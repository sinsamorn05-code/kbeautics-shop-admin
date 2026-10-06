// =====================================================
// K-BEAUTICS SHOP — server function "shop-api"
// Checks every request really comes from a Telegram user,
// then reads/writes the database safely for them.
// Paste into Supabase > Edge Functions > Deploy a new function > Via Editor
// =====================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_CHAT_ID') || '';
const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
class UserError extends Error {}
const must = (cond, msg) => { if (!cond) throw new UserError(msg); };
const money = (n) => '$' + Number(n || 0).toFixed(2);
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// ---------- Telegram identity check ----------
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
async function telegramUser(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(new TextEncoder().encode('WebAppData'), BOT_TOKEN);
  const sig = [...(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return null;
  const age = Date.now() / 1000 - Number(params.get('auth_date'));
  if (!(age < 86400)) return null; // older than 24h → reopen the shop
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

// ---------- Telegram message to you (optional) ----------
async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID || !BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text }),
    });
  } catch (_) { /* ignore */ }
}
const who = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') + (c.username ? ` (@${c.username})` : '');

// ---------- actions ----------
async function getCustomer(u) {
  const { error } = await db.from('customers').upsert(
    { telegram_id: u.id, first_name: u.first_name || null, last_name: u.last_name || null, username: u.username || null },
    { onConflict: 'telegram_id' },
  );
  if (error) throw error;
  const { data, error: e2 } = await db.from('customers').select('*').eq('telegram_id', u.id).single();
  if (e2) throw e2;
  return data;
}

async function init(c, _b, u) {
  const [s, cats, prods, bans, sales] = await Promise.all([
    db.from('shop_settings').select('shop_name,bank_name,account_name,account_number,qr_image_url,delivery_fee_usd,default_deposit_percent,flash_sale_ends_at').eq('id', 1).single(),
    db.from('categories').select('id,name,sort_order,image_url').eq('is_active', true).order('sort_order').order('name'),
    db.from('products').select('id,category_id,name,description,price_usd,compare_at_price_usd,flash_price_usd,images,is_preorder,deposit_percent,eta_days,created_at')
      .eq('is_active', true).order('created_at', { ascending: false }),
    db.from('banners').select('id,image_url,link_product_id,link_category_id')
      .eq('is_active', true).order('sort_order').order('id'),
    db.from('product_sales').select('product_id,sold'),
  ]);
  for (const r of [s, cats, prods]) if (r.error) throw r.error;
  const sold = Object.fromEntries((sales.data || []).map((x) => [x.product_id, x.sold]));
  return {
    customer: {
      first_name: c.first_name, last_name: c.last_name, username: c.username,
      phone: c.phone, address: c.address, photo_url: (u && u.photo_url) || null,
    },
    settings: s.data, categories: cats.data,
    products: prods.data.map((p) => ({ ...p, sold: sold[p.id] || 0 })),
    banners: bans.error ? [] : bans.data,
    server_time: new Date().toISOString(),
  };
}

async function myStuff(c) {
  const [o, r] = await Promise.all([
    db.from('orders')
      .select('id,order_no,order_type,status,subtotal_usd,delivery_fee_usd,total_usd,deposit_usd,paid_usd,delivery_address,created_at,order_items(product_id,product_name,unit_price_usd,qty,line_total_usd),payments(payment_kind,amount_usd,status,reject_reason,created_at)')
      .eq('customer_id', c.id).order('created_at', { ascending: false }).limit(50),
    db.from('taobao_requests')
      .select('id,taobao_url,request_type,item_note,images,qty,status,quoted_price_usd,quote_note,eta_days,order_id,created_at')
      .eq('customer_id', c.id).order('created_at', { ascending: false }).limit(50),
  ]);
  if (o.error) throw o.error;
  if (r.error) throw r.error;
  // short-lived links so the customer can see the photos they sent
  const paths = r.data.flatMap((x) => x.images || []);
  let urls = {};
  if (paths.length) {
    const { data: signed } = await db.storage.from('request-photos').createSignedUrls(paths, 3600);
    urls = Object.fromEntries((signed || []).map((x) => [x.path, x.signedUrl]));
  }
  const requests = r.data.map((x) => ({ ...x, images: (x.images || []).map((p) => urls[p]).filter(Boolean) }));
  return { orders: o.data, requests };
}

function contactFrom(b) {
  const name = String(b.contact_name || '').trim().slice(0, 100);
  const phone = String(b.contact_phone || '').trim().slice(0, 40);
  const address = String(b.address || '').trim().slice(0, 500);
  must(name, 'Please enter your name');
  must(phone.replace(/\D/g, '').length >= 8, 'Please enter a valid phone number');
  must(address, 'Please enter your delivery address');
  return { name, phone, address, note: String(b.note || '').trim().slice(0, 500) || null };
}

async function placeOrder(c, b) {
  const ct = contactFrom(b);
  const items = Array.isArray(b.items) ? b.items.slice(0, 50).map((i) => ({ product_id: Number(i.product_id), qty: Number(i.qty) })) : [];
  must(items.length, 'Your cart is empty');
  await db.from('customers').update({ phone: ct.phone, address: ct.address }).eq('id', c.id);
  const { data, error } = await db.rpc('shop_place_order', {
    p_customer_id: c.id, p_items: items, p_contact_name: ct.name,
    p_contact_phone: ct.phone, p_address: ct.address, p_note: ct.note,
  });
  if (error) throw new UserError(error.message);
  await notifyAdmin(`🛒 New order from ${who(c)}\n` +
    data.map((o) => `${o.order_no} · ${o.order_type === 'preorder' ? 'Pre-order' : 'Normal order'} · ${money(o.total_usd)}`).join('\n') +
    `\n📞 ${ct.phone}`);
  return { orders: data };
}

function amountDue(o) {
  const left = r2(o.total_usd - o.paid_usd);
  if (o.order_type === 'stock') return { kind: 'full', amount: left };
  if (Number(o.paid_usd) === 0 && Number(o.deposit_usd) > 0 && Number(o.deposit_usd) < Number(o.total_usd)) {
    return { kind: 'deposit', amount: r2(o.deposit_usd) };
  }
  return { kind: Number(o.paid_usd) === 0 ? 'full' : 'balance', amount: left };
}

async function pay(c, b) {
  const { data: o } = await db.from('orders').select('*').eq('id', Number(b.order_id)).eq('customer_id', c.id).maybeSingle();
  must(o, 'Order not found');
  must(['pending_payment', 'arrived'].includes(o.status), 'This order is not waiting for payment');
  const { count } = await db.from('payments').select('id', { count: 'exact', head: true }).eq('order_id', o.id).eq('status', 'pending');
  must(!count, 'Your payment is already being checked');
  const due = amountDue(o);
  must(due.amount > 0, 'Nothing to pay');

  const m = String(b.image || '').match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
  must(m, 'Please choose a photo of your payment slip');
  const bytes = Uint8Array.from(atob(m[3]), (ch) => ch.charCodeAt(0));
  must(bytes.length < 6 * 1024 * 1024, 'Photo is too large');
  const path = `${o.id}/${Date.now()}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`;
  const up = await db.storage.from('payment-slips').upload(path, bytes, { contentType: m[1] });
  if (up.error) throw up.error;

  const ins = await db.from('payments').insert({ order_id: o.id, payment_kind: due.kind, amount_usd: due.amount, slip_path: path });
  if (ins.error) throw ins.error;
  const upd = await db.from('orders').update({ status: 'payment_review' }).eq('id', o.id);
  if (upd.error) throw upd.error;
  await notifyAdmin(`💵 Payment slip to check\n${o.order_no} · ${due.kind} ${money(due.amount)}\nFrom ${who(c)}`);
  return { ok: true };
}

async function cancelOrder(c, b) {
  const { data: o } = await db.from('orders').select('*').eq('id', Number(b.order_id)).eq('customer_id', c.id).maybeSingle();
  must(o, 'Order not found');
  must(o.status === 'pending_payment' && Number(o.paid_usd) === 0, 'This order can no longer be cancelled — please contact us');
  const { error } = await db.from('orders').update({ status: 'cancelled' }).eq('id', o.id);
  if (error) throw error;
  await db.from('taobao_requests').update({ status: 'cancelled' }).eq('order_id', o.id);
  await notifyAdmin(`❌ ${o.order_no} cancelled by customer ${who(c)}`);
  return { ok: true };
}

async function newRequest(c, b) {
  const type = b.type === 'custom_brand' ? 'custom_brand' : 'preorder';
  const url = String(b.url || '').trim().slice(0, 1000) || null;
  const note = String(b.note || '').trim().slice(0, 1000) || null;
  const pics = Array.isArray(b.images) ? b.images.slice(0, 5) : [];
  must(url || note || pics.length, 'Please add a photo, a link, or describe what you want');
  must(!url || /^https?:\/\/\S+$/i.test(url), 'The link should start with http');
  const qty = Math.floor(Number(b.qty) || 1);
  must(qty >= 1 && qty <= 100000, 'Invalid quantity');
  const { count } = await db.from('taobao_requests').select('id', { count: 'exact', head: true }).eq('customer_id', c.id).eq('status', 'pending');
  must((count || 0) < 10, 'You have many requests waiting — please wait for our reply');
  const images = [];
  for (const [i, img] of pics.entries()) {
    const m = String(img || '').match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
    must(m, 'One of the photos could not be read — please choose it again');
    const bytes = Uint8Array.from(atob(m[3]), (ch) => ch.charCodeAt(0));
    must(bytes.length < 6 * 1024 * 1024, 'A photo is too large');
    const path = `${c.id}/${Date.now()}-${i}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`;
    const up = await db.storage.from('request-photos').upload(path, bytes, { contentType: m[1] });
    if (up.error) throw up.error;
    images.push(path);
  }
  const { error } = await db.from('taobao_requests').insert({
    customer_id: c.id, request_type: type, taobao_url: url, qty, item_note: note, images,
  });
  if (error) throw error;
  await notifyAdmin(`${type === 'custom_brand' ? '🏷️ New CUSTOM BRAND request' : '📦 New PRE-ORDER request'} from ${who(c)}\nQty ${qty}${note ? '\n' + note : ''}${url ? '\n' + url : ''}${images.length ? `\n📷 ${images.length} photo${images.length > 1 ? 's' : ''} — open admin to see` : ''}`);
  return { ok: true };
}

async function acceptQuote(c, b) {
  const ct = contactFrom(b);
  const { data: r } = await db.from('taobao_requests').select('*').eq('id', Number(b.request_id)).eq('customer_id', c.id).maybeSingle();
  must(r && r.status === 'quoted' && r.quoted_price_usd != null, 'This quote is no longer available');
  const { data: s } = await db.from('shop_settings').select('delivery_fee_usd,default_deposit_percent').eq('id', 1).single();
  const sub = r2(r.quoted_price_usd * r.qty);
  const fee = r2(s.delivery_fee_usd);
  const { data: o, error } = await db.from('orders').insert({
    customer_id: c.id, order_type: 'taobao_link', subtotal_usd: sub, delivery_fee_usd: fee, total_usd: r2(sub + fee),
    deposit_usd: r2(sub * s.default_deposit_percent / 100),
    contact_name: ct.name, contact_phone: ct.phone, delivery_address: ct.address, customer_note: ct.note,
  }).select('id,order_no,total_usd').single();
  if (error) throw error;
  await db.from('order_items').insert({
    order_id: o.id, product_name: (r.request_type === 'custom_brand' ? 'Custom brand: ' : 'Pre-order: ') + (r.item_note || 'requested item').slice(0, 120),
    unit_price_usd: r.quoted_price_usd, unit_cost_usd: r.quoted_cost_usd ?? null, qty: r.qty,
  });
  await db.from('taobao_requests').update({ status: 'accepted', order_id: o.id }).eq('id', r.id);
  await db.from('customers').update({ phone: ct.phone, address: ct.address }).eq('id', c.id);
  await notifyAdmin(`✅ Quote accepted → ${o.order_no} · ${money(o.total_usd)}\nFrom ${who(c)}`);
  return { order: o };
}

async function declineQuote(c, b) {
  const { data: r } = await db.from('taobao_requests').select('id,status').eq('id', Number(b.request_id)).eq('customer_id', c.id).maybeSingle();
  must(r && ['pending', 'quoted'].includes(r.status), 'Request not found');
  const { error } = await db.from('taobao_requests').update({ status: 'cancelled' }).eq('id', r.id);
  if (error) throw error;
  return { ok: true };
}

const ACTIONS = {
  init, my: myStuff, place_order: placeOrder, pay, cancel_order: cancelOrder,
  request: newRequest, accept_quote: acceptQuote, decline_quote: declineQuote,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  try {
    const body = await req.json();
    const fn = ACTIONS[body.action];
    if (!fn) return reply({ error: 'Unknown action' }, 400);
    const u = await telegramUser(body.initData);
    if (!u || !u.id) return reply({ error: 'Please close and reopen the shop from Telegram' }, 401);
    const c = await getCustomer(u);
    return reply(await fn(c, body, u));
  } catch (e) {
    if (e instanceof UserError) return reply({ error: e.message }, 400);
    console.error(e);
    return reply({ error: 'Something went wrong, please try again' }, 500);
  }
});
