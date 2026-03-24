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
      amount:                              String(Math.round(amount * 100)),
      currency:                            currency || 'sek',
      'metadata[restaurant]':              restaurantName || '',
      'metadata[order_id]':               orderId || '',
      // Aktivera alla tillgängliga betalningsmetoder automatiskt (kort, Klarna etc)
      'automatic_payment_methods[enabled]': 'true',
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
