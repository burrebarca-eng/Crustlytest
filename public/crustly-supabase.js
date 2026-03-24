// ============================================================
// crustly-supabase.js — Central Supabase-modul
// Ersätter crustly-auth.js och all Firebase-kod
// Importeras på varje sida
// ============================================================

import { createClient } from 'https://unpkg.com/@supabase/supabase-js@2/dist/esm/supabase.js';

// ── Config ──
const SUPABASE_URL  = 'https://febybrpterkybwzhigte.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZlYnlicnB0ZXJreWJ3emhpZ3RlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MjU0ODUsImV4cCI6MjA4ODQwMTQ4NX0.XFQV0sct_vspo-8uc5XQOFN1QqpDOjm-4dTc2I1DObQ';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
// AUTH
// ============================================================

// Kräver inloggning — redirect om ej inloggad
// callback(user, restaurant)
export async function requireAuth(callback) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'crustly-login.html';
    return;
  }
  const restaurant = await getMyRestaurant(session.user.id);
  callback(session.user, restaurant);

  // Lyssna på auth-ändringar
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      window.location.href = 'crustly-login.html';
    }
  });
}

// Hämta restaurang kopplad till inloggad ägare
export async function getMyRestaurant(userId) {
  const { data, error } = await supabase
    .from('restaurants')
    .select('*')
    .eq('owner_uid', userId)
    .single();
  if (error) return null;
  return data;
}

// Logga in
export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { success: false, error: friendlyError(error.message) };
  return { success: true, user: data.user };
}

// Logga ut
export async function logout() {
  await supabase.auth.signOut();
  window.location.href = 'crustly-login.html';
}

// Återställ lösenord
export async function resetPassword(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/crustly-login.html'
  });
  if (error) return { success: false, error: friendlyError(error.message) };
  return { success: true };
}

// Skapa ägarkonto vid onboarding
export async function createRestaurantUser(email, password, restaurantData) {
  // 1. Skapa Auth-användare
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email, password
  });
  if (authError) return { success: false, error: friendlyError(authError.message) };

  // 2. Spara restaurang i databasen
  const { data: rest, error: restError } = await supabase
    .from('restaurants')
    .insert({
      ...restaurantData,
      owner_uid:   authData.user.id,
      owner_email: email,
    })
    .select()
    .single();

  if (restError) return { success: false, error: restError.message };
  return { success: true, user: authData.user, restaurant: rest };
}

// ============================================================
// ORDERS
// ============================================================

// Lägg en order (från beställningssidan — ingen auth krävs)
export async function placeOrder(orderData) {
  const crustlyCut = (orderData.total || 0) * 0.10;
  const { data, error } = await supabase
    .from('orders')
    .insert({
      ...orderData,
      crustly_cut: crustlyCut,
      status: 'new',
      payment_status: 'pending',
      created_at: new Date().toISOString()
    })
    .select()
    .single();
  if (error) return { success: false, error: error.message };

  // Uppdatera kundstatistik
  await updateCustomerStats(orderData);

  return { success: true, order: data };
}

// Hämta orders för en restaurang
export async function getOrders(restaurantId, options = {}) {
  let query = supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false });

  if (options.status)  query = query.eq('status', options.status);
  if (options.limit)   query = query.limit(options.limit);
  if (options.since)   query = query.gte('created_at', options.since);

  const { data, error } = await query;
  if (error) return [];
  return data;
}

// Uppdatera orderstatus
export async function updateOrderStatus(orderId, status) {
  const { error } = await supabase
    .from('orders')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', orderId);
  return !error;
}

// Bekräfta Swish-betalning
export async function confirmPayment(orderId) {
  const { error } = await supabase
    .from('orders')
    .update({ payment_status: 'paid', updated_at: new Date().toISOString() })
    .eq('id', orderId);
  return !error;
}

// Realtidslyssnare på orders (för köksskärm)
export function listenToOrders(restaurantId, callback) {
  // Initial load
  getOrders(restaurantId, { limit: 100 }).then(callback);

  // Realtid via Supabase
  const channel = supabase
    .channel(`orders-${restaurantId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'orders',
      filter: `restaurant_id=eq.${restaurantId}`
    }, () => {
      getOrders(restaurantId, { limit: 100 }).then(callback);
    })
    .subscribe();

  return channel; // returnera för att kunna avsluta
}

// ============================================================
// CUSTOMERS
// ============================================================

// Hämta eller skapa kund
export async function upsertCustomer(customerData) {
  // Kolla om kund redan finns (baserat på telefon + restaurang)
  const { data: existing } = await supabase
    .from('customers')
    .select('*')
    .eq('restaurant_id', customerData.restaurant_id)
    .eq('phone', customerData.phone)
    .single();

  if (existing) {
    // Uppdatera befintlig kund
    const { data } = await supabase
      .from('customers')
      .update({
        name: customerData.name,
        email: customerData.email || existing.email,
        birthday_day: customerData.birthday_day || existing.birthday_day,
        birthday_month: customerData.birthday_month || existing.birthday_month,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)
      .select()
      .single();
    return data;
  }

  // Skapa ny kund
  const { data } = await supabase
    .from('customers')
    .insert(customerData)
    .select()
    .single();
  return data;
}

// Uppdatera kundstatistik efter order
async function updateCustomerStats(orderData) {
  if (!orderData.customer_phone || !orderData.restaurant_id) return;

  const { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('restaurant_id', orderData.restaurant_id)
    .eq('phone', orderData.customer_phone)
    .single();

  if (!customer) return;

  const newPoints  = (customer.loyalty_points || 0) + Math.floor(orderData.total || 0);
  const newOrders  = (customer.total_orders || 0) + 1;
  const newSpent   = (customer.total_spent || 0) + (orderData.total || 0);
  const tier       = newPoints >= 5000 ? 'gold' : newPoints >= 1000 ? 'silver' : 'bronze';

  await supabase
    .from('customers')
    .update({
      loyalty_points: newPoints,
      total_orders:   newOrders,
      total_spent:    newSpent,
      loyalty_tier:   tier,
      last_order_at:  new Date().toISOString(),
      updated_at:     new Date().toISOString()
    })
    .eq('id', customer.id);
}

// Hämta kunder för en restaurang
export async function getCustomers(restaurantId, options = {}) {
  let query = supabase
    .from('customers')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('last_order_at', { ascending: false });

  if (options.limit) query = query.limit(options.limit);
  const { data, error } = await query;
  if (error) return [];
  return data;
}

// Hämta inaktiva kunder (återaktivering)
export async function getInactiveCustomers(restaurantId, daysSince = 14) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysSince);

  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .lt('last_order_at', cutoff.toISOString())
    .order('last_order_at', { ascending: true });

  if (error) return [];
  return data;
}

// Hämta kunder med födelsedag inom X dagar
export async function getUpcomingBirthdays(restaurantId, daysAhead = 30) {
  const today = new Date();
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .not('birthday_month', 'is', null)
    .not('birthday_day', 'is', null);

  if (error) return [];

  return data.map(c => {
    const bday = new Date(today.getFullYear(), c.birthday_month - 1, c.birthday_day);
    if (bday < today) bday.setFullYear(today.getFullYear() + 1);
    const daysAway = Math.ceil((bday - today) / 86400000);
    return { ...c, daysAway };
  })
  .filter(c => c.daysAway <= daysAhead)
  .sort((a, b) => a.daysAway - b.daysAway);
}

// ============================================================
// RESTAURANTS
// ============================================================

export async function getRestaurant(restaurantId) {
  const { data } = await supabase
    .from('restaurants')
    .select('*')
    .eq('id', restaurantId)
    .single();
  return data;
}

export async function getRestaurantBySlug(slug) {
  const { data } = await supabase
    .from('restaurants')
    .select('*')
    .eq('slug', slug)
    .single();
  return data;
}

export async function updateRestaurant(restaurantId, updates) {
  const { data, error } = await supabase
    .from('restaurants')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', restaurantId)
    .select()
    .single();
  if (error) return { success: false, error: error.message };
  return { success: true, restaurant: data };
}

// Hämta alla restauranger (för admin-dashboard)
export async function getAllRestaurants() {
  const { data, error } = await supabase
    .from('restaurants')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return [];
  return data;
}

// ============================================================
// SETTINGS
// ============================================================

export async function getSettings(restaurantId) {
  const { data } = await supabase
    .from('settings')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .single();
  return data;
}

export async function saveSettings(restaurantId, updates) {
  const { data, error } = await supabase
    .from('settings')
    .upsert({ restaurant_id: restaurantId, ...updates, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) return { success: false, error: error.message };
  return { success: true, settings: data };
}

// ============================================================
// STATISTIK (för dashboard + rapporter)
// ============================================================

export async function getStats(restaurantId, period = 'month') {
  const now = new Date();
  let since;
  if (period === 'today') {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'week') {
    since = new Date(now - 7 * 86400000);
  } else {
    since = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const { data: orders, error } = await supabase
    .from('orders')
    .select('total, crustly_cut, status, items, delivery_type, payment_method, created_at')
    .eq('restaurant_id', restaurantId)
    .gte('created_at', since.toISOString());

  if (error) return null;

  const completed = orders.filter(o => o.status !== 'cancelled');
  const totalRevenue = completed.reduce((s, o) => s + (o.total || 0), 0);
  const crustlyCut   = completed.reduce((s, o) => s + (o.crustly_cut || 0), 0);

  // Topprätter
  const itemCounts = {};
  completed.forEach(o => {
    (o.items || []).forEach(item => {
      itemCounts[item.name] = (itemCounts[item.name] || 0) + (item.quantity || 1);
    });
  });
  const topItems = Object.entries(itemCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    totalOrders:  completed.length,
    totalRevenue,
    crustlyCut,
    topItems,
    deliveryCount: completed.filter(o => o.delivery_type === 'delivery').length,
    pickupCount:   completed.filter(o => o.delivery_type === 'pickup').length,
    swishCount:    completed.filter(o => o.payment_method === 'swish').length,
    cashCount:     completed.filter(o => o.payment_method === 'cash').length,
  };
}

// ============================================================
// HJÄLPFUNKTIONER
// ============================================================

export const sek = n => Math.round(n || 0).toLocaleString('sv-SE') + ' kr';

export function timeAgo(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  if (s < 60)    return s + 's sedan';
  if (s < 3600)  return Math.floor(s / 60) + 'm sedan';
  if (s < 86400) return Math.floor(s / 3600) + 'h sedan';
  return Math.floor(s / 86400) + 'd sedan';
}

function friendlyError(msg) {
  const errors = {
    'Invalid login credentials':         'Fel e-post eller lösenord.',
    'Email not confirmed':               'Bekräfta din e-post först.',
    'User already registered':           'E-postadressen används redan.',
    'Password should be at least 6':     'Lösenordet måste vara minst 6 tecken.',
    'Unable to validate email address':  'Ogiltig e-postadress.',
    'Rate limit exceeded':               'För många försök. Vänta en stund.',
  };
  for (const [key, val] of Object.entries(errors)) {
    if (msg.includes(key)) return val;
  }
  return 'Ett fel uppstod. Försök igen.';
}
