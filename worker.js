// ============================================================
// Crustly — Cloudflare Worker
// ============================================================

// Static file routing
const ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/crustly-order.html': 'crustly-order.html',
  '/crustly-kitchen.html': 'crustly-kitchen.html',
  '/crustly-owner.html': 'crustly-owner.html',
  '/crustly-onboarding.html': 'crustly-onboarding.html',
  '/crustly-dashboard.html': 'crustly-dashboard.html',
  '/crustly-invoice.html': 'crustly-invoice.html',
  '/crustly-landing.html': 'crustly-landing.html',
  '/crustly-login.html': 'crustly-login.html',
  '/crustly-loyalty.html': 'crustly-loyalty.html',
  '/crustly-loyalty-customer.html': 'crustly-loyalty-customer.html',
  '/crustly-birthday.html': 'crustly-birthday.html',
  '/crustly-reengagement.html': 'crustly-reengagement.html',
  '/crustly-settings.html': 'crustly-settings.html',
  '/crustly-auth.js': 'crustly-auth.js',
  '/crustly-supabase.js': 'crustly-supabase.js',
  '/server.js': 'server.js',
};

import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST';
const assetManifest = JSON.parse(manifestJSON);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── CORS PREFLIGHT ─────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }});
    }

    // ── SMS PROXY ──────────────────────────────────────────
    if (path === '/sms' && request.method === 'POST') {
      return handleSMS(request);
    }

    // ── STRIPE PROXY ───────────────────────────────────────
    if (path === '/stripe/create-payment-intent' && request.method === 'POST') {
      return handleStripePaymentIntent(request, env);
    }
    if (path === '/stripe/fees' && request.method === 'GET') {
      return handleStripeFees(request, env);
    }

    // ── CLAUDE AI PROXY ────────────────────────────────────
    if (path === '/claude/generate' && request.method === 'POST') {
      return handleClaudeProxy(request, env);
    }

    // ── APPLE PAY DOMAIN VERIFICATION ─────────────────────
    if (path === '/.well-known/apple-developer-merchantid-domain-association') {
      const res = await fetch('https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association');
      const content = await res.arrayBuffer();
      return new Response(content, {
        headers: { 'Content-Type': 'application/octet-stream' }
      });
    }

    // ── STATIC FILES ───────────────────────────────────────
    try {
      return await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
      );
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  }
};

// ── STRIPE HANDLER ──────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function handleStripePaymentIntent(request, env) {
  try {
    const { amount, currency, restaurantName, orderId } = await request.json();

    if (!amount || amount < 1) {
      return Response.json({ error: 'Ogiltigt belopp' }, { status: 400, headers: corsHeaders });
    }

    // Stripe använder ören — multiplicera med 100
    const body = new URLSearchParams({
      amount:                    String(Math.round(amount * 100)),
      currency:                  currency || 'sek',
      'metadata[restaurant]':    restaurantName || '',
      'metadata[order_id]':      orderId || '',
      // Explicita betalmetoder: kort (inkl Apple/Google Pay), Klarna
      // Swish läggs till när Stripe-kontot är verifierat för Sverige
      'payment_method_types[0]': 'card',
      'payment_method_types[1]': 'klarna',
    });

    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization':  'Bearer ' + env.STRIPE_SECRET_KEY,
        'Content-Type':   'application/x-www-form-urlencoded',
      },
      body: body.toString()
    });

    const data = await res.json();

    if (!res.ok) {
      return Response.json(
        { error: data.error?.message || 'Stripe-fel' },
        { status: 400, headers: corsHeaders }
      );
    }

    return Response.json({
      clientSecret:    data.client_secret,
      paymentIntentId: data.id
    }, { headers: corsHeaders });

  } catch(e) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}

// ── STRIPE FEES HANDLER ─────────────────────────────────────
async function handleStripeFees(request, env) {
  try {
    if (!env.STRIPE_SECRET_KEY) {
      return Response.json({ error: 'Stripe ej konfigurerat' }, { status: 400, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const now = new Date();
    // Hämta innevarande månad som standard, eller ?month=YYYY-MM från query
    const monthParam = url.searchParams.get('month');
    let start, end;
    if (monthParam) {
      const [y, m] = monthParam.split('-').map(Number);
      start = Math.floor(new Date(y, m - 1, 1).getTime() / 1000);
      end   = Math.floor(new Date(y, m, 1).getTime() / 1000);
    } else {
      start = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
      end   = Math.floor(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000);
    }

    // Paginera genom ALLA transaktioner för exakta siffror
    let allTxns = [];
    let startingAfter = null;
    let hasMore = true;

    while (hasMore) {
      let apiUrl = `https://api.stripe.com/v1/balance_transactions?limit=100&created[gte]=${start}&created[lt]=${end}`;
      if (startingAfter) apiUrl += '&starting_after=' + startingAfter;

      const res = await fetch(apiUrl, {
        headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY }
      });
      const page = await res.json();

      if (!res.ok) {
        return Response.json({ error: page.error?.message || 'Stripe-fel' }, { status: 400, headers: corsHeaders });
      }

      const items = page.data || [];
      allTxns = allTxns.concat(items);
      hasMore = page.has_more || false;
      if (hasMore && items.length > 0) {
        startingAfter = items[items.length - 1].id;
      }
    }

    // Filtrera och summera — separera charges och refunds för exakta avgifter
    const charges = allTxns.filter(t => t.type === 'charge');
    const refunds = allTxns.filter(t => t.type === 'refund');

    const charge_fees     = charges.reduce((s, t) => s + (t.fee || 0), 0);
    const refund_fee_back = refunds.reduce((s, t) => s + Math.abs(t.fee || 0), 0);
    const net_fees        = charge_fees - refund_fee_back;

    const total_volume = charges.reduce((s, t) => s + (t.amount || 0), 0);
    const net_volume   = allTxns.reduce((s, t) => s + (t.net || 0), 0);

    return Response.json({
      charge_fees,       // brutto avgifter i ören
      refund_fee_back,   // återbetalda avgifter vid refunds i ören
      net_fees,          // netto avgifter (charge_fees - refund_fee_back) i ören
      total_volume,      // total volym via charges i ören
      net_volume,        // netto efter alla avgifter i ören
      charge_count: charges.length,
      refund_count: refunds.length,
      transaction_count: allTxns.length,
      recent: charges.slice(0, 15).map(t => ({
        id: t.id,
        amount: t.amount,
        fee: t.fee,
        net: t.net,
        description: t.description || '',
        created: t.created,
        source: t.source
      }))
    }, { headers: corsHeaders });

  } catch(e) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}

// ── CLAUDE AI PROXY ─────────────────────────────────────────
async function handleClaudeProxy(request, env) {
  try {
    const { apiKey, model, max_tokens, messages } = await request.json();

    // API-nyckel: använd medskickad nyckel från localStorage, eller env-var som fallback
    const key = apiKey || env.CLAUDE_API_KEY;
    if (!key) {
      return Response.json({ error: 'Ingen Claude API-nyckel. Lägg till i Inställningar.' }, { status: 400, headers: corsHeaders });
    }

    if (!messages || !messages.length) {
      return Response.json({ error: 'Inga meddelanden skickade' }, { status: 400, headers: corsHeaders });
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5-20251001',
        max_tokens: max_tokens || 1000,
        messages
      })
    });

    const data = await res.json();

    if (!res.ok) {
      return Response.json(
        { error: data.error?.message || 'Claude API-fel' },
        { status: res.status, headers: corsHeaders }
      );
    }

    return Response.json(data, { headers: corsHeaders });

  } catch(e) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}

// ── SMS HANDLER ────────────────────────────────────────────
async function handleSMS(request) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const { api_username, api_password, from, to, message } = body;

    if (!api_username || !api_password || !from || !to || !message) {
      return Response.json({ success: false, error: 'Saknade fält' }, { status: 400, headers: corsHeaders });
    }

    // Validera telefonnummer (måste börja med +)
    if (!to.startsWith('+')) {
      return Response.json({ success: false, error: 'Telefonnummer måste börja med + (t.ex. +46701234567)' }, { status: 400, headers: corsHeaders });
    }

    // Skicka via 46elks API
    const credentials = btoa(`${api_username}:${api_password}`);
    const formData = new URLSearchParams();
    formData.append('from', from.slice(0, 11)); // max 11 tecken
    formData.append('to', to);
    formData.append('message', message);

    const elksRes = await fetch('https://api.46elks.com/a1/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString()
    });

    const elksData = await elksRes.json();

    if (elksRes.ok && elksData.status !== 'failed') {
      return Response.json({ success: true, id: elksData.id }, { headers: corsHeaders });
    } else {
      return Response.json({ success: false, error: elksData.message || 'SMS kunde inte skickas' }, { status: 400, headers: corsHeaders });
    }

  } catch(e) {
    return Response.json({ success: false, error: e.message }, { status: 500, headers: corsHeaders });
  }
}
