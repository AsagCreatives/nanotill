'use strict';
/* Shared logic for the Nano Tech tracker. It runs inside server.js (your own server) or the Netlify function.
   All saving goes through a "store" (lib/filestore.cjs or netlify/lib/blobstore.mjs). */
const http = require('http'), https = require('https'), crypto = require('crypto');
const env = process.env;
const TZ = env.TZ_NAME || 'Europe/London';
const TRUST_PROXY = env.TRUST_PROXY === '1';
const SHOW_NAMES = env.SHOW_STAFF_NAMES !== '0';          // set to 0 to make staff type their name instead of tapping it
const ANY_WEBHOOK = env.ALLOW_ANY_WEBHOOK === '1';        // testing only
const STATUS = ['Received','Diagnosing','Awaiting customer approval','Waiting for parts','In repair','Outside repair','Ready for collection','Collected','Unrepairable / returned'];
const DONE = ['Collected', 'Unrepairable / returned'];
const SHOP0 = () => ({name: 'Nano Tech', address: '', phone: '', email: '', vat: '', footer: ''});
let db, dlog, aux, store;
const save = (bump = true) => { if (bump) db.rev++; store.touch('db'); };
const dlSave = () => store.touch('dlog');
const auxSave = () => store.touch('aux');
function prepare(s) {         // fill in anything missing in what was loaded, so old data keeps working
  db = {users: [], jobs: [], seq: 0, rev: 1, secret: '', setupCode: '', slackQ: [], mailQ: [], ...s.db};
  db.settings = {slackUrl: '', auto: true, onExport: true, details: false, daily: '', lastDaily: '', ...db.settings, shop: {...SHOP0(), ...(db.settings && db.settings.shop)}};
  dlog = {records: [], deleted: [], ...s.dlog}; dlog.seq = {buy: 0, sell: 0, ...dlog.seq};
  dlog.records.forEach(r => { if (!r.ref) r.ref = (r.type === 'sell' ? 'SELL-' : 'BUY-') + String(++dlog.seq[r.type === 'sell' ? 'sell' : 'buy']).padStart(4, '0'); });
  aux = {tries: {}, kioskHits: [], imeiHits: {}, imeiCache: {}, imeiLog: [], ...s.aux};
  s.db = db; s.dlog = dlog; s.aux = aux;
  if (!db.secret) { db.secret = crypto.randomBytes(32).toString('hex'); save(false); }
  if (!db.users.length && !db.setupCode) {
    db.setupCode = env.SETUP_CODE || crypto.randomBytes(4).toString('hex').toUpperCase(); save(false);
    console.log(`FIRST-TIME SETUP CODE: ${env.SETUP_CODE || db.setupCode}  (enter it on the tracker page to create the admin account)`);
  }
}
async function loadState() { const s = await store.load(); prepare(s); }
async function withState(fn) {         // run fn on freshly loaded data; if someone else saved at the same moment, start again
  for (let a = 0; a < 12; a++) { await loadState(); const out = await fn(); if (await store.commit()) return out; await new Promise(r => setTimeout(r, Math.random() * 30 * (a + 1))); }
  throw new Error('The server is busy, please try again.');
}
async function mutate(fn) { for (let a = 0; a < 12; a++) { await loadState(); fn(); if (await store.commit()) return true; await new Promise(r => setTimeout(r, Math.random() * 30 * (a + 1))); } return false; }

/* ---------- helpers ---------- */
const scrypt = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('base64');
const mkUser = (name, role, pw, tv = 0) => { const salt = crypto.randomBytes(16).toString('base64'); return {name, role, salt, hash: scrypt(pw, salt), tv}; };
const pwOk = (u, pw) => { const a = Buffer.from(scrypt(pw, u.salt)), b = Buffer.from(u.hash); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const pad = n => 'NR-' + String(n).padStart(4, '0');
const parts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}).formatToParts(d).map(p => [p.type, p.value]));
const today = () => { const p = parts(); return `${p.year}-${p.month}-${p.day}`; };
const hm = () => { const p = parts(); return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`; };
const stamp = iso => { const p = parts(new Date(iso)); return `${p.day}/${p.month} ${p.hour}:${p.minute}`; };
const gbp = n => '£' + (Number(n) || 0).toFixed(2);
const margin = j => (Number(j.quote) || 0) - (Number(j.parts.cost) || 0) - (j.repair.where === 'Outside job' ? Number(j.repair.outsideCost) || 0 : 0);

const BLANK = {ref: '', status: 'Received', branch: '', cust: {name: '', phone: '', email: ''}, dev: {type: 'Phone', brand: '', model: '', storage: '', colour: '', imei: ''}, fault: '', quote: '', deposit: '',
  parts: {needed: false, ordered: false, partName: '', supplier: '', cost: '', orderRef: '', orderedOn: '', eta: '', arrived: false},
  repair: {where: 'In house', tech: '', outsideCo: '', outsideContact: '', sentOn: '', outsideCost: '', dueBack: '', backOn: ''},
  handover: {given: false, on: '', by: '', paid: '', method: 'Card'}};
function clean(tpl, src) {       // keep only known fields, correct types, capped length
  const out = {};
  for (const k of Object.keys(tpl)) {
    const t = tpl[k], v = src?.[k];
    out[k] = t && typeof t === 'object' ? clean(t, v) : typeof t === 'boolean' ? v === true : String(v ?? t).slice(0, 2000);
  }
  return out;
}

/* ---------- sign-in tokens (signed, so they work on any server instance) ---------- */
const TTL = 2 * 3600 * 1000;
const b64u = x => Buffer.from(x).toString('base64url');
const sig = payload => crypto.createHmac('sha256', db.secret).update(payload).digest('base64url');
const signToken = u => { const p = b64u(JSON.stringify({n: u.name, e: Date.now() + TTL, v: u.tv || 0})); return p + '.' + sig(p); };
const ipOf = req => (TRUST_PROXY && req.headers['x-forwarded-for'] && req.headers['x-forwarded-for'].split(',')[0].trim()) || req.ip || 'unknown';
function auth(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, ''), [p, g] = t.split('.'); if (!p || !g) return null;
  const a = Buffer.from(sig(p)), b = Buffer.from(g); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let o; try { o = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch (_) { return null; }
  if (!o || o.e < Date.now()) return null;
  const u = db.users.find(x => x.name === o.n); if (!u || (u.tv || 0) !== o.v) return null;
  return {token: t, user: u};
}

/* ---------- Slack ---------- */
const extractHook = x => { const m = /https:\/\/hooks\.slack\.com\/[A-Za-z0-9\/_-]+/.exec(String(x || '')); return m ? m[0] : (ANY_WEBHOOK ? String(x || '').trim() : ''); };
const hook = () => extractHook(db.settings.slackUrl) || extractHook(process.env.SLACK_WEBHOOK_URL);
function slackSend(text) {
  return new Promise(res => {
    let u; try { u = new URL(hook()); } catch (_) { return res({ok: false, error: 'No valid webhook URL saved.'}); }
    const body = JSON.stringify({text: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')});
    const r = (u.protocol === 'http:' ? http : https).request(u, {method: 'POST', headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}, timeout: 10000}, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => { const why = {no_service: 'Slack says this webhook no longer exists. It was probably deleted or replaced, so create a new one in Slack and paste that.', invalid_token: 'Slack does not accept this webhook address. Check it was copied completely, or create a new one.', no_team: 'Slack does not recognise the workspace in this webhook. Create a new one.', channel_not_found: 'The Slack channel for this webhook was not found. Create a new webhook for the channel.', channel_is_archived: 'The Slack channel for this webhook is archived.', action_prohibited: 'Your Slack workspace has blocked this webhook. Ask a Slack admin to allow it.', no_active_hooks: 'Incoming webhooks are switched off for this Slack app.'}[d.trim()];
      res(resp.statusCode === 200 ? {ok: true} : {ok: false, error: why || `Slack replied ${resp.statusCode}: ${d.slice(0, 80)}`}); });
    });
    r.on('error', e => res({ok: false, error: e.message})); r.on('timeout', () => { r.destroy(); res({ok: false, error: 'Slack timed out'}); });
    r.end(body);
  });
}
async function flushSlack() {
  if (!hook()) return;
  for (let pass = 0; pass < 4; pass++) {
    let mine = [];       // claim a few messages first, so two servers never send the same one
    const got = await mutate(() => { const now = Date.now(); mine = db.slackQ.filter(m => !m.claim || m.claim < now - 120000).slice(0, 10); mine.forEach(m => { m.claim = now; }); if (mine.length) save(false); });
    if (!got || !mine.length) return;
    const ids = mine.map(m => m.id), done = [];
    for (const m of mine) {
      const late = Date.now() - m.at > 120000, r = await slackSend(late ? `${m.text}\n_(queued ${stamp(new Date(m.at).toISOString())})_` : m.text);
      if (r.ok || Date.now() - m.at > 6 * 3600e3) done.push(m.id); else break;
    }
    await mutate(() => { db.slackQ = db.slackQ.filter(x => !done.includes(x.id)); db.slackQ.forEach(x => { if (ids.includes(x.id)) x.claim = 0; }); save(false); });
    if (done.length < ids.length) return;
  }
}
function slack(text) { if (!hook()) return; db.slackQ.push({id: crypto.randomUUID(), text, at: Date.now()}); db.slackQ = db.slackQ.slice(-100); save(false); }
const dev = j => [j.dev.brand, j.dev.model].filter(Boolean).join(' ');
function summary(title, by) {
  const open = db.jobs.filter(j => !DONE.includes(j.status)), n = s => db.jobs.filter(j => j.status === s).length, day = today();
  const tod = db.jobs.filter(j => j.handover.given && j.handover.on === day);
  const bt = dlog.records.filter(r => r.type === 'buy' && r.date === day), st = dlog.records.filter(r => r.type === 'sell' && r.date === day);
  const toOrder = open.filter(j => j.parts.needed && !j.parts.ordered).map(j => j.ref);
  const inbound = open.filter(j => j.parts.ordered && !j.parts.arrived).map(j => j.ref + (j.parts.supplier ? ` (${j.parts.supplier})` : ''));
  const outside = open.filter(j => j.repair.where === 'Outside job' && !j.repair.backOn).map(j => `${j.ref} at ${j.repair.outsideCo || '?'}${j.repair.dueBack ? ' due ' + j.repair.dueBack : ''}`);
  return [`:bar_chart: *Nano repair tracker — ${title}* (${stamp(new Date().toISOString())}, ${by})`, `*Open jobs:* ${open.length}`,
    ...STATUS.filter(s => !DONE.includes(s) && n(s)).map(s => `• ${s}: ${n(s)}`),
    toOrder.length ? `*Parts to order:* ${toOrder.join(', ')}` : '', inbound.length ? `*Parts on the way:* ${inbound.join(', ')}` : '', outside.length ? `*With outside repairers:* ${outside.join('; ')}` : '',
    `*Bought today:* ${bt.length} · paid ${gbp(bt.reduce((a, r) => a + (+r.price || 0), 0))} · *Sold today:* ${st.length} · ${gbp(st.reduce((a, r) => a + (+r.price || 0), 0))}`,
    `*Given back today:* ${tod.length} · taken ${gbp(tod.reduce((a, j) => a + (+j.handover.paid || 0), 0))} · est. profit ${gbp(tod.reduce((a, j) => a + margin(j), 0))}`].filter(Boolean).join('\n');
}
/* ---------- buying / selling records ---------- */
const BUYF = ['brand', 'model', 'capacity', 'condition', 'colour', 'faults', 'imei', 'imeiCheck', 'imeiResult', 'date', 'price', 'sellerName', 'sellerContact', 'sellerEmail'];
const SELLF = ['buyerName', 'buyerContact', 'buyerEmail', 'brand', 'model', 'imei', 'imeiResult', 'grade', 'price', 'date'];
const BANK = ['accountName', 'sortCode', 'accountNumber'];
const pubRec = (r, admin) => { const c = {...r}; delete c.photoExt; if (!admin) BANK.forEach(k => delete c[k]); return c; };
const recDev = r => [r.brand, r.model, r.capacity && r.capacity !== 'Not specified' ? r.capacity : ''].filter(Boolean).join(' ');
async function savePhoto(id, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '')); if (!m) return '';
  const buf = Buffer.from(m[2], 'base64'); if (buf.length > 3e6 || !buf.length) return '';
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1]; await store.putPhoto(id, ext, buf); return ext;
}
function recSlack(r) {
  const d = db.settings.details;
  return r.type === 'buy' ? `:inbox_tray: *Purchase ${r.ref}* by *${r.createdBy}* — ${recDev(r)}${r.condition ? ' · ' + r.condition : ''} · paid ${gbp(r.price)}${d ? ' · from ' + r.sellerName : ''}`
    : `:moneybag: *Sale ${r.ref}* by *${r.createdBy}* — ${recDev(r)} · grade ${r.grade || '-'} · ${gbp(r.price)}${d ? ' · to ' + r.buyerName : ''}`;
}

/* ---------- email receipts (Resend: set RESEND_API_KEY and MAIL_FROM on the server) ---------- */
const MAIL_KEY = process.env.RESEND_API_KEY || '', MAIL_FROM = process.env.MAIL_FROM || '', MAIL_URL = process.env.MAIL_API_URL || 'https://api.resend.com/emails';
const mailReady = () => !!(MAIL_KEY && MAIL_FROM);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());
const eh = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const longDate = d => new Intl.DateTimeFormat('en-GB', {timeZone: TZ, dateStyle: 'long'}).format(d ? new Date(d) : new Date());
function mailSend(m) {
  return new Promise(res => {
    let u; try { u = new URL(MAIL_URL); } catch (_) { return res({ok: false, permanent: true, error: 'Bad mail URL.'}); }
    const sh = db.settings.shop, payload = JSON.stringify({from: MAIL_FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(emailOk(sh.email) ? {reply_to: sh.email} : {})});
    const r = (u.protocol === 'http:' ? http : https).request(u, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + MAIL_KEY, 'Content-Length': Buffer.byteLength(payload)}, timeout: 15000}, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => res(resp.statusCode < 300 ? {ok: true} : {ok: false, permanent: resp.statusCode < 500 && resp.statusCode !== 429, error: `Mail service replied ${resp.statusCode}: ${d.slice(0, 120)}`}));
    });
    r.on('error', e => res({ok: false, error: e.message})); r.on('timeout', () => { r.destroy(); res({ok: false, error: 'Mail service timed out'}); });
    r.end(payload);
  });
}
function receipt({title, ref, date, intro, rows = [], items = [], total, totalLabel, note}) {
  const sh = db.settings.shop, td = 'border-bottom:1px solid #eee;padding:8px 4px';
  const foot = [sh.name, sh.address, sh.phone, sh.vat ? 'VAT ' + sh.vat : ''].filter(Boolean);
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#231f20"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:8px;overflow:hidden"><tr><td align="center" style="background:#302f2f;color:#fff;padding:22px;font-size:26px;letter-spacing:6px;font-weight:bold">${eh(sh.name.toUpperCase())}</td></tr><tr><td style="padding:24px"><h2 style="margin:0 0 4px">${eh(title)}</h2><p style="margin:0 0 16px;color:#6b6a6b">Reference ${eh(ref)} · ${eh(date)}</p>${intro ? `<p>${eh(intro)}</p>` : ''}<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="${td};color:#6b6a6b">${eh(k)}</td><td align="right" style="${td}">${eh(v)}</td></tr>`).join('')}${items.map(([d, p]) => `<tr><td style="${td}">${eh(d)}</td><td align="right" style="${td}">${p === '' ? '' : gbp(p)}</td></tr>`).join('')}${total != null ? `<tr><td style="padding:14px 4px 4px;font-weight:bold">${eh(totalLabel || 'Total')}</td><td align="right" style="padding:14px 4px 4px;font-weight:bold;font-size:18px">${gbp(total)}</td></tr>` : ''}</table>${note ? `<p style="margin-top:18px;font-size:13px;color:#555">${eh(note)}</p>` : ''}</td></tr><tr><td align="center" style="background:#f7f7f8;padding:16px 24px;font-size:12px;color:#6b6a6b">${foot.map(eh).join(' · ')}${sh.footer ? `<br><br>${eh(sh.footer)}` : ''}</td></tr></table></td></tr></table></body></html>`;
  const text = [sh.name.toUpperCase(), title, `Reference ${ref} · ${date}`, intro || '', ...rows.map(([k, v]) => `${k}: ${v}`), ...items.map(([d, p]) => `${d}${p === '' ? '' : ' ' + gbp(p)}`), total != null ? `${totalLabel || 'Total'}: ${gbp(total)}` : '', note || '', '', foot.join(' · '), sh.footer || ''].filter(x => x !== '').join('\n');
  return {html, text};
}
const MIN_FEE = t => /phone/i.test(t) ? 29.99 : 49.99;
function buildMail(kind, o) {
  const sh = db.settings.shop.name;
  if (kind === 'booking') { const tot = o.repairs.reduce((a, r) => a + r.price, 0);
    return {subject: `Your ${sh} repair booking ${o.ref}`, ...receipt({title: 'Repair booking confirmation', ref: o.ref, date: longDate(), intro: `Thank you for booking with ${sh}. We have your details and will be in touch about your repair.`,
      rows: [['Name', o.name], ['Device', o.device]], items: o.repairs.map(r => [r.name, r.price]), total: tot, totalLabel: 'Estimated total',
      note: `Payment is taken in store. A minimum non-refundable labour/diagnostic fee of ${gbp(MIN_FEE(o.deviceType))} applies even if the repair cannot be completed. You accepted our Terms & Conditions when booking${o.termsAt ? ' on ' + longDate(o.termsAt) : ''}.`})}; }
  if (kind === 'repair') { const j = o, paid = Number(j.handover.paid) || Number(j.quote) || 0;
    return {subject: `Your ${sh} repair receipt ${j.ref}`, ...receipt({title: 'Repair receipt', ref: j.ref, date: longDate(j.handover.on || undefined), intro: `Thank you for choosing ${sh}.`,
      rows: [['Name', j.cust.name], ['Device', dev(j)], ['Collected', j.handover.on || ''], ['Paid by', j.handover.given ? j.handover.method : '']].filter(r => r[1]), items: [[`Repair: ${j.fault}`, Number(j.quote) || 0]], total: paid, totalLabel: 'Total paid'})}; }
  if (kind === 'buy') { const r = o;
    return {subject: `Your ${sh} purchase receipt ${r.ref}`, ...receipt({title: 'Purchase receipt', ref: r.ref, date: longDate(r.date), intro: `Thank you for selling your device to ${sh}.`,
      rows: [['Seller', r.sellerName], ['Device', recDev(r)], ['IMEI / serial', r.imei], ['Condition', r.condition]].filter(x => x[1]), total: Number(r.price) || 0, totalLabel: 'Amount paid to you'})}; }
  const r = o;
  return {subject: `Your ${sh} sales receipt ${r.ref}`, ...receipt({title: 'Sales receipt', ref: r.ref, date: longDate(r.date), intro: `Thank you for your purchase from ${sh}.`,
    rows: [['Buyer', r.buyerName], ['Device', recDev(r)], ['IMEI', r.imei], ['Grade', r.grade]].filter(x => x[1]), total: Number(r.price) || 0, totalLabel: 'Total paid'})};
}
function setReceipt(t, kind, to, status, error) {
  t.receipts = (t.receipts || []).filter(x => !(x.kind === kind && x.status === 'queued'));
  t.receipts.push({kind, to, at: new Date().toISOString(), status, error: error ? String(error).slice(0, 150) : ''}); t.receipts = t.receipts.slice(-8);
}
const persistAll = () => { dlSave(); save(); };
async function sendReceipt(tk, target, kind, to, content) {      // tk: 'job' or 'rec'. Queues the email; it is sent right after the save.
  if (!emailOk(to)) return 'no email';
  if (!mailReady()) { setReceipt(target, kind, to, 'failed', 'Email is not set up on the server yet.'); persistAll(); return 'failed'; }
  db.mailQ.push({id: crypto.randomUUID(), tk, tid: target.id, kind, to: to.trim(), content, at: Date.now()}); db.mailQ = db.mailQ.slice(-200);
  setReceipt(target, kind, to, 'queued'); persistAll(); return 'queued';
}
async function flushMail() {
  if (!mailReady()) return;
  for (let pass = 0; pass < 4; pass++) {
    let mine = [];       // claim first, so two servers never send the same receipt
    const got = await mutate(() => { const now = Date.now(); mine = db.mailQ.filter(m => !m.claim || m.claim < now - 120000).slice(0, 5); mine.forEach(m => { m.claim = now; }); if (mine.length) save(false); });
    if (!got || !mine.length) return;
    const out = [];
    for (const q of mine) {
      const r = await mailSend({to: q.to, ...q.content});
      if (r.ok) out.push({q, status: 'sent'});
      else if (r.permanent || Date.now() - q.at > 864e5) out.push({q, status: 'failed', error: r.error || 'Gave up after 24 hours'});
      else out.push({q, status: 'retry', error: r.error});
    }
    await mutate(() => {
      for (const o of out) {
        if (o.status === 'retry') { const x = db.mailQ.find(y => y.id === o.q.id); if (x) x.claim = 0; continue; }
        db.mailQ = db.mailQ.filter(x => x.id !== o.q.id);
        const t = (o.q.tk === 'job' ? db.jobs : dlog.records).find(x => x.id === o.q.tid); if (t) setReceipt(t, o.q.kind, o.q.to, o.status, o.error);
      }
      persistAll();
    });
    if (out.some(o => o.status === 'retry')) return;
  }
}
/* ---------- IMEI checks (Dhru Fusion API at your checkimei account) ---------- */
const IMEI_URL = process.env.CHECKIMEI_URL || 'https://dhru.checkimei.com', IMEI_USER = process.env.CHECKIMEI_USER || 'nanokensington';
const imeiKey = () => process.env.CHECKIMEI_API_KEY || db.settings.imeiKey || '';
const imeiEndpoint = () => /\.php$/i.test(IMEI_URL) ? IMEI_URL : IMEI_URL.replace(/\/+$/, '') + '/api/index.php';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function postForm(urlStr, fields) {
  return new Promise(res => {
    let u; try { u = new URL(urlStr); } catch (_) { return res({ok: false, error: 'The IMEI service address is not valid.'}); }
    const body = new URLSearchParams(fields).toString();
    const r = (u.protocol === 'http:' ? http : https).request(u, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body)}, timeout: 20000}, resp => {
      let d = ''; resp.on('data', c => { if (d.length < 2e6) d += c; });
      resp.on('end', () => res({ok: true, text: d, status: resp.statusCode}));
    });
    r.on('error', e => res({ok: false, error: 'Could not reach the IMEI service: ' + e.message})); r.on('timeout', () => { r.destroy(); res({ok: false, error: 'The IMEI service took too long to answer.'}); });
    r.end(body);
  });
}
function parseReply(text) {        // the service may add warnings around its answer, or reply in the older XML style
  const t = String(text || '').replace(/^\uFEFF/, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  if (/<(SUCCESS|ERROR)\b/i.test(t)) {
    const tag = (n, x) => { const m = new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i').exec(x); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : undefined; };
    if (/<ERROR\b/i.test(t)) return {ERROR: [{MESSAGE: tag('MESSAGE', t) || tag('FULL_DESCRIPTION', t) || 'The IMEI service reported an error.'}]};
    const o = {}; for (const k of ['MESSAGE', 'REFERENCEID', 'STATUS', 'CODE', 'COMMENTS', 'username', 'credit', 'currency']) { const v = tag(k, t); if (v !== undefined) o[k] = v; }
    return {SUCCESS: [o]};
  }
  return null;
}
const snip = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 160);
async function dhru(action, params = {}) {
  const has = Object.keys(params).length;
  const send = xml => postForm(imeiEndpoint(), {username: IMEI_USER, apiaccesskey: imeiKey(), action, requestformat: 'JSON',
    ...(has ? {parameters: xml ? '<PARAMETERS>' + Object.entries(params).map(([k, v]) => `<${k}>${eh(v)}</${k}>`).join('') + '</PARAMETERS>' : Buffer.from(JSON.stringify(params)).toString('base64')} : {})});
  const read = r => {
    if (!r.ok) return {error: r.error};
    const j = parseReply(r.text);
    if (!j) return {unreadable: true, raw: r.text, error: `The IMEI service answered (HTTP ${r.status}) but I could not read it. It said: "${snip(r.text)}"`};
    const e = Array.isArray(j.ERROR) ? (j.ERROR[0] && (j.ERROR[0].FULL_DESCRIPTION || j.ERROR[0].MESSAGE)) : j.ERROR;
    if (e) return {error: String(e).slice(0, 200), paramsProblem: /param|invalid|xml|format/i.test(JSON.stringify(j.ERROR))};
    const sx = j.SUCCESS; return {data: Array.isArray(sx) ? sx[0] || {} : (sx && typeof sx === 'object' ? sx : {})};
  };
  const xmlFirst = aux.imeiFmt === 'xml';
  let r = read(await send(xmlFirst));
  // A second try with the other request format is only safe when the first clearly did not place an order
  const orderSeen = action === 'placeimeiorder' && r.raw && /REFERENCEID|"SUCCESS"|<SUCCESS/i.test(r.raw);
  if (has && (r.paramsProblem || r.unreadable) && !orderSeen) {
    const r2 = read(await send(!xmlFirst));
    if (r2.data) { aux.imeiFmt = xmlFirst ? 'json' : 'xml'; auxSave(); }
    if (r2.data || !r2.unreadable) r = r2;
  }
  return r.data ? {data: r.data} : {error: r.error};
}
const luhnOk = s => { if (!/^\d{15}$/.test(s)) return false; let t = 0; for (let i = 0; i < 15; i++) { let d = +s[14 - i]; if (i % 2) { d *= 2; if (d > 9) d -= 9; } t += d; } return t % 10 === 0; };
const cleanResult = c => String(c ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
function flattenServices(list) {
  const out = [], walk = (o, g) => { if (!o || typeof o !== 'object') return; if (o.SERVICEID !== undefined && o.SERVICENAME) { out.push({id: String(o.SERVICEID), name: String(o.SERVICENAME), credit: o.CREDIT ?? '', time: o.TIME ?? '', group: g || ''}); return; } for (const v of Object.values(o)) walk(v, o.GROUPNAME || g); };
  walk(list, ''); return out;
}
async function imeiOrderStatus(ref) {          // one look at an order: {done, text} | {pending} | {error}
  const r = await dhru('getimeiorder', {ID: ref}); if (r.error) return {error: r.error};
  const st = String(r.data.STATUS ?? ''), text = cleanResult(r.data.CODE || r.data.COMMENTS || '');
  if (st === '4') return {done: true, text: text || 'The check finished but returned no details.'};
  if (st === '3') return {error: text || 'The IMEI service rejected this check.'};
  return {pending: true};
}
function imeiCacheSave(imei, text, ref) {
  aux.imeiCache[imei] = {at: Date.now(), text, ref, svc: db.settings.imeiService?.id};
  const keys = Object.keys(aux.imeiCache); if (keys.length > 500) keys.sort((a, b) => aux.imeiCache[a].at - aux.imeiCache[b].at).slice(0, keys.length - 500).forEach(k => delete aux.imeiCache[k]);
  auxSave();
}

/* ---------- http ---------- */
const send = (res, code, obj) => { res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(obj)); };

async function api(req, res, url) {
  const m = req.method, p = url.pathname, b = req.body || {};
  if (m === 'GET' && p === '/api/public') return send(res, 200, {needsSetup: !db.users.length, names: SHOW_NAMES ? db.users.map(u => u.name) : null});
  if (m === 'POST' && p === '/api/setup') {
    if (db.users.length) return send(res, 403, {error: 'Already set up.'});
    if (String(b.code || '').trim().toUpperCase() !== String(env.SETUP_CODE || db.setupCode).toUpperCase()) return send(res, 403, {error: 'Wrong setup code.'});
    if (!String(b.name || '').trim() || String(b.password || '').length < 8) return send(res, 400, {error: 'Enter a name and a password of at least 8 characters.'});
    db.users.push(mkUser(String(b.name).trim().slice(0, 40), 'admin', b.password)); save(); return send(res, 200, {ok: true});
  }
  if (m === 'POST' && p === '/api/login') {
    const key = ipOf(req) + '|' + String(b.name).toLowerCase(), t = aux.tries[key] || {n: 0, until: 0};
    if (Date.now() < t.until) return send(res, 429, {error: `Too many attempts. Wait ${Math.ceil((t.until - Date.now()) / 1000)}s.`});
    const u = db.users.find(x => x.name.toLowerCase() === String(b.name || '').toLowerCase());
    if (u && pwOk(u, b.password || '')) { if (aux.tries[key]) { delete aux.tries[key]; auxSave(); } return send(res, 200, {token: signToken(u), name: u.name, role: u.role}); }
    if (!u) scrypt('x', 'x'); // keep timing similar
    t.n++; if (t.n >= 5) { t.until = Date.now() + 60000; t.n = 0; } aux.tries[key] = t; for (const k of Object.keys(aux.tries)) if (aux.tries[k].until && aux.tries[k].until < Date.now() - 3600e3) delete aux.tries[k]; auxSave();
    return send(res, 401, {error: 'Wrong name or password.'});
  }
  if (m === 'POST' && p === '/api/kiosk-booking') {      // customers on the booking iPad: no login, so limited and tightly cleaned
    const now = Date.now(); aux.kioskHits = aux.kioskHits.filter(t => t > now - 600000);
    if (aux.kioskHits.length >= 60) return send(res, 429, {error: 'Busy, try again shortly.'});
    aux.kioskHits.push(now); auxSave();
    const cid = String(b.clientId || '').slice(0, 64), dup = cid && db.jobs.find(x => x.kioskId === cid);
    if (dup) return send(res, 200, {ok: true, ref: dup.ref, duplicate: true});
    const reps = (Array.isArray(b.repairs) ? b.repairs : []).slice(0, 20).map(r => ({name: String(r.name || '').slice(0, 150), price: Math.max(0, Number(r.price) || 0)})).filter(r => r.name);
    const total = reps.reduce((a, r) => a + r.price, 0), nowIso = new Date().toISOString();
    const j = clean(BLANK, {status: 'Received', cust: {name: b.name, phone: b.phone, email: b.email}, dev: {type: b.deviceType, brand: b.brand, model: b.model, storage: b.storage, colour: b.colour},
      fault: reps.map(r => r.name).join(', ') + (b.notes ? ' — ' + b.notes : ''), quote: reps.length ? total.toFixed(2) : ''});
    if (j.cust.name.trim().length < 2 || !(j.cust.phone.trim() || j.cust.email.trim()) || !j.fault.trim()) return send(res, 400, {error: 'Missing details.'});
    Object.assign(j, {id: crypto.randomUUID(), ref: pad(++db.seq), kioskId: cid, createdAt: nowIso, createdBy: 'Kiosk', updatedAt: nowIso, updatedBy: 'Kiosk',
      log: [{at: nowIso, by: 'Kiosk', text: 'Booked by the customer on the kiosk'}],
      notes: [{at: nowIso, by: 'Kiosk', text: [`Terms & Conditions accepted${b.termsAt ? ' at ' + stamp(String(b.termsAt)) : ''} (including the minimum repair attempt fee).`,
        `Device passcode given: ${b.passcodeGiven ? 'Yes (see the Ecwid order)' : 'No'}.`, `Ecwid order: ${String(b.ecwid || 'not sent').slice(0, 120)}.`].join(' ')}]});
    db.jobs.push(j); save();
    if (db.settings.auto) slack(`:calendar: *New kiosk booking ${j.ref}*${db.settings.details ? ' for ' + j.cust.name : ''} — ${dev(j)} · ${j.fault.slice(0, 120)} (${gbp(total)})`);
    if (emailOk(j.cust.email)) sendReceipt('job', j, 'booking', j.cust.email, buildMail('booking', {ref: j.ref, name: j.cust.name, device: dev(j), deviceType: j.dev.type, repairs: reps, termsAt: b.termsAt})).catch(() => {});
    return send(res, 200, {ok: true, ref: j.ref});
  }
  const a = auth(req); if (!a) return send(res, 401, {error: 'Please log in.'});
  const me = a.user, admin = me.role === 'admin', need = () => { if (!admin) { send(res, 403, {error: 'Admin only.'}); return false; } return true; };

  if (m === 'POST' && p === '/api/logout') return send(res, 200, {ok: true});
  if (m === 'POST' && p === '/api/me/password') {
    if (String(b.password || '').length < 8) return send(res, 400, {error: 'At least 8 characters.'});
    Object.assign(me, mkUser(me.name, me.role, b.password, me.tv || 0)); save(false); return send(res, 200, {ok: true});
  }
  if (m === 'GET' && p === '/api/jobs') {
    const rev = +url.searchParams.get('rev');
    return send(res, 200, rev === db.rev ? {rev: db.rev, same: true} : {rev: db.rev, jobs: db.jobs, records: dlog.records.map(r => pubRec(r, admin))});
  }
  if (m === 'POST' && p === '/api/jobs') {
    const j = clean(BLANK, b.job), now = new Date().toISOString();
    if (!STATUS.includes(j.status)) j.status = 'Received';
    if (!j.cust.name.trim() || !j.fault.trim() || !(j.dev.model.trim() || j.dev.brand.trim())) return send(res, 400, {error: 'Customer name, device and fault are required.'});
    Object.assign(j, {id: crypto.randomUUID(), ref: pad(++db.seq), createdAt: now, createdBy: me.name, updatedAt: now, updatedBy: me.name, log: [{at: now, by: me.name, text: 'Job booked in'}],
      notes: (b.job?.notes || []).slice(0, 50).map(n => ({at: now, by: me.name, text: String(n.text || '').slice(0, 1000)})).filter(n => n.text)});
    db.jobs.push(j); save();
    if (db.settings.auto) slack(`:wrench: *${j.ref}* booked in by *${me.name}*${db.settings.details ? ' for ' + j.cust.name : ''} — ${dev(j)} · ${j.fault.slice(0, 100)}`);
    return send(res, 200, {job: j});
  }
  let mm = p.match(/^\/api\/jobs\/([\w-]+)$/);
  if (mm) {
    const i = db.jobs.findIndex(x => x.id === mm[1]); if (i < 0) return send(res, 404, {error: 'Job not found.'});
    const old = db.jobs[i];
    if (m === 'DELETE') { if (!need()) return; db.jobs.splice(i, 1); save(); return send(res, 200, {ok: true}); }
    if (m === 'PUT') {
      if (b.base !== old.updatedAt) return send(res, 409, {error: 'changed', job: old});
      const j = clean(BLANK, b.job), now = new Date().toISOString();
      if (!STATUS.includes(j.status)) j.status = old.status;
      if (!j.cust.name.trim() || !j.fault.trim() || !(j.dev.model.trim() || j.dev.brand.trim())) return send(res, 400, {error: 'Customer name, device and fault are required.'});
      if (j.handover.given && !j.handover.by) j.handover.by = me.name;
      if (j.handover.given && !j.handover.on) j.handover.on = today();
      const changes = (Array.isArray(b.changes) ? b.changes : []).slice(0, 25).map(c => String(c).slice(0, 300));
      const fresh = (b.job?.notes || []).slice(old.notes.length, old.notes.length + 20).map(n => ({at: now, by: me.name, text: String(n.text || '').slice(0, 1000)})).filter(n => n.text);
      const nj = Object.assign(j, {id: old.id, ref: old.ref, kioskId: old.kioskId, createdAt: old.createdAt, createdBy: old.createdBy, updatedAt: now, updatedBy: me.name,
        notes: [...old.notes, ...fresh], log: changes.length ? [...old.log, {at: now, by: me.name, text: changes.join(' · ')}] : old.log});
      db.jobs[i] = nj; save();
      if (!old.handover.given && nj.handover.given && emailOk(nj.cust.email)) sendReceipt('job', nj, 'repair', nj.cust.email, buildMail('repair', nj)).catch(() => {});
      const lines = db.settings.details ? changes : changes.filter(l => !/^(Customer name|Phone|Email|Their contact number):/.test(l));
      if (db.settings.auto && lines.length) slack(`:arrows_counterclockwise: *${nj.ref}* (${dev(nj)}) updated by *${me.name}*\n${lines.map(l => '• ' + l).join('\n')}`);
      return send(res, 200, {job: nj});
    }
  }
  if (m === 'POST' && p === '/api/records') {
    const type = b.type === 'sell' ? 'sell' : 'buy', src = b.record || {}, now = new Date().toISOString(), r = {};
    for (const k of type === 'buy' ? BUYF : SELLF) r[k] = String(src[k] ?? '').trim().slice(0, k === 'imeiResult' ? 2000 : 500);
    if (type === 'buy') BANK.forEach(k => { r[k] = String(src[k] ?? '').trim().slice(0, 100); });
    const price = Number(r.price); r.price = Number.isFinite(price) && price >= 0 && r.price !== '' ? price.toFixed(2) : '';
    if (!r.date) r.date = today();
    const need = type === 'buy' ? ['brand', 'model', 'imei', 'price', 'sellerName', 'accountName', 'sortCode', 'accountNumber'] : ['brand', 'model', 'imei', 'price', 'buyerName'];
    const miss = need.filter(k => !r[k]); if (miss.length) return send(res, 400, {error: 'Please fill in: ' + miss.join(', ') + '.'});
    const id = crypto.randomUUID(); r.id = id; r.type = type; r.ref = (type === 'buy' ? 'BUY-' : 'SELL-') + String(++dlog.seq[type]).padStart(4, '0'); r.createdAt = now; r.createdBy = me.name;
    if (type === 'buy' && src.photo) { const ext = await savePhoto(id, src.photo); if (ext) { r.hasPhoto = true; r.photoExt = ext; } }
    dlog.records.push(r); persistAll();
    if (db.settings.auto) slack(recSlack(r));
    const to = type === 'buy' ? r.sellerEmail : r.buyerEmail;
    if (emailOk(to)) sendReceipt('rec', r, type, to, buildMail(type, r)).catch(() => {});
    return send(res, 200, {record: pubRec(r, admin)});
  }
  mm = p.match(/^\/api\/(records|jobs)\/([\w-]+)\/receipt$/);
  if (mm && m === 'POST') {
    const isJob = mm[1] === 'jobs', t = (isJob ? db.jobs : dlog.records).find(x => x.id === mm[2]); if (!t) return send(res, 404, {error: 'Not found.'});
    const to = String(b.to || (isJob ? t.cust.email : t.type === 'buy' ? t.sellerEmail : t.buyerEmail) || '').trim();
    if (!emailOk(to)) return send(res, 400, {error: 'There is no valid email address on this record. Type one in.'});
    if (!mailReady()) return send(res, 400, {error: 'Email is not set up on the server yet (see the Email card in Settings).'});
    if (!isJob) { if (t.type === 'buy') t.sellerEmail = to; else t.buyerEmail = to; } else t.cust.email = to;
    const kind = isJob ? 'repair' : t.type, st = await sendReceipt(isJob ? 'job' : 'rec', t, kind, to, buildMail(kind, t));
    return send(res, st === 'failed' ? 502 : 200, st === 'failed' ? {error: t.receipts.at(-1)?.error || 'Could not send.'} : {ok: true, status: st});
  }
  if (m === 'POST' && p === '/api/imei/check') {
    const imei = String(b.imei || '').replace(/\D/g, '');
    if (!luhnOk(imei)) return send(res, 400, {error: 'Enter the full 15-digit IMEI (the number is checked for typing mistakes).'});
    if (!imeiKey()) return send(res, 400, {error: 'The IMEI check is not connected yet. An admin needs to add the API key in Settings.'});
    const svc = db.settings.imeiService; if (!svc || !svc.id) return send(res, 400, {error: 'An admin needs to choose the IMEI check service in Settings first.'});
    const c = aux.imeiCache[imei]; if (c && c.svc === svc.id && Date.now() - c.at < 864e5) return send(res, 200, {done: true, text: c.text, cached: true, at: new Date(c.at).toISOString()});
    const now = Date.now(), hits = (aux.imeiHits[me.name] || []).filter(t => t > now - 3600e3); if (hits.length >= 40) return send(res, 429, {error: 'That is a lot of checks in an hour. Please wait a bit.'});
    hits.push(now); aux.imeiHits[me.name] = hits; auxSave();
    const placed = await dhru('placeimeiorder', {ID: svc.id, IMEI: imei}); if (placed.error) return send(res, 502, {error: placed.error});
    const ref = String(placed.data.REFERENCEID || ''); if (!ref) return send(res, 502, {error: 'The IMEI service did not accept the order.'});
    aux.imeiLog.push({at: new Date().toISOString(), by: me.name, imei, ref, service: svc.name}); aux.imeiLog = aux.imeiLog.slice(-1000); auxSave();
    const t0 = Date.now();
    for (let i = 0; ; i++) {
      await sleep(i ? 2500 : 1500); const s = await imeiOrderStatus(ref);
      if (s.error) return send(res, 502, {error: s.error});
      if (s.done) { imeiCacheSave(imei, s.text, ref); return send(res, 200, {done: true, text: s.text, ref}); }
      if (Date.now() - t0 > (store.imeiBudgetMs || 20000)) break;
    }
    return send(res, 200, {pending: true, ref});
  }
  if (m === 'GET' && p === '/api/imei/result') {
    const ref = String(url.searchParams.get('ref') || '').replace(/[^\w-]/g, ''), imei = String(url.searchParams.get('imei') || '').replace(/\D/g, ''); if (!ref) return send(res, 400, {error: 'Missing reference.'});
    const s = await imeiOrderStatus(ref); if (s.error) return send(res, 502, {error: s.error});
    if (s.done && imei) imeiCacheSave(imei, s.text, ref);
    return send(res, 200, s);
  }
  if (m === 'POST' && p === '/api/slack/summary') {
    if (b.reason === 'export' && !db.settings.onExport) return send(res, 200, {ok: true, posted: false});
    if (!hook()) return send(res, 400, {error: 'Slack is not connected yet.'});
    slack(summary(b.reason === 'export' ? 'export' : 'summary', me.name)); return send(res, 200, {ok: true, posted: true});
  }

  /* ----- admin only from here ----- */
  if (!need()) return;
  if (m === 'GET' && p === '/api/users') return send(res, 200, {users: db.users.map(u => ({name: u.name, role: u.role}))});
  if (m === 'POST' && p === '/api/users') {
    const name = String(b.name || '').trim().slice(0, 40);
    if (!name || String(b.password || '').length < 8) return send(res, 400, {error: 'Enter a name and a password of at least 8 characters.'});
    if (db.users.some(u => u.name.toLowerCase() === name.toLowerCase())) return send(res, 400, {error: 'That name is already used.'});
    db.users.push(mkUser(name, b.role === 'admin' ? 'admin' : 'staff', b.password)); save(false); return send(res, 200, {ok: true});
  }
  mm = p.match(/^\/api\/users\/([^/]+)(\/password)?$/);
  if (mm) {
    const name = decodeURIComponent(mm[1]), u = db.users.find(x => x.name === name); if (!u) return send(res, 404, {error: 'No such user.'});
    if (mm[2] && m === 'POST') { if (String(b.password || '').length < 8) return send(res, 400, {error: 'At least 8 characters.'}); Object.assign(u, mkUser(u.name, u.role, b.password, (u.tv || 0) + 1)); save(false); return send(res, 200, {ok: true}); }
    if (m === 'DELETE') {
      if (u.name === me.name) return send(res, 400, {error: "You can't remove yourself."});
      db.users = db.users.filter(x => x !== u); save(false); return send(res, 200, {ok: true});
    }
  }
  if (m === 'GET' && p === '/api/settings') { const {slackUrl, imeiKey: _k, imeiService, ...rest} = db.settings; return send(res, 200, {...rest, connected: !!hook(), mailReady: mailReady(), imei: {url: IMEI_URL, username: IMEI_USER, keySet: !!imeiKey(), fromEnv: !!process.env.CHECKIMEI_API_KEY, service: db.settings.imeiService || null}, queued: db.slackQ.length, mailQueued: db.mailQ.length}); }
  if (m === 'PUT' && p === '/api/settings') {
    const s = db.settings;
    if (typeof b.slackUrl === 'string') {
      const raw = b.slackUrl.trim(), u = extractHook(raw);
      if (raw && !u) return send(res, 400, {error: 'That does not look like a Slack webhook. Paste only the web address, which starts https://hooks.slack.com/services/'});
      s.slackUrl = u; if (!u) db.slackQ = [];
    }
    for (const k of ['auto', 'onExport', 'details']) if (typeof b[k] === 'boolean') s[k] = b[k];
    if (typeof b.imeiKey === 'string' && b.imeiKey.trim()) s.imeiKey = b.imeiKey.trim().slice(0, 200);
    if (b.imeiService && typeof b.imeiService === 'object') s.imeiService = {id: String(b.imeiService.id || '').slice(0, 40), name: String(b.imeiService.name || '').slice(0, 150)};
    if (b.shop && typeof b.shop === 'object') for (const k of ['name', 'address', 'phone', 'email', 'vat', 'footer']) if (typeof b.shop[k] === 'string') s.shop[k] = b.shop[k].trim().slice(0, k === 'footer' ? 400 : 120) || (k === 'name' ? 'Nano Tech' : '');
    if (typeof b.daily === 'string') s.daily = /^\d\d:\d\d$/.test(b.daily) ? b.daily : '';
    save(false); return send(res, 200, {ok: true});
  }
  if (m === 'POST' && p === '/api/slack/test') { const r = await slackSend(`:white_check_mark: Test from the Nano repair tracker (sent by ${me.name}). Slack is connected.`); return send(res, r.ok ? 200 : 502, r.ok ? r : {error: r.error}); }
  mm = p.match(/^\/api\/records\/([\w-]+)(\/photo)?$/);
  if (mm) {
    const i = dlog.records.findIndex(x => x.id === mm[1]); if (i < 0) return send(res, 404, {error: 'Record not found.'});
    const r = dlog.records[i];
    if (mm[2] && m === 'GET') {
      const buf = r.hasPhoto ? await store.getPhoto(r.id, r.photoExt) : null; if (!buf) return send(res, 404, {error: 'No photo.'});
      res.writeHead(200, {'Content-Type': 'image/' + (r.photoExt === 'jpg' ? 'jpeg' : r.photoExt), 'Cache-Control': 'private, no-store'}); return res.end(buf);
    }
    if (!mm[2] && m === 'DELETE') { dlog.deleted.push({...r, deletedAt: new Date().toISOString(), deletedBy: me.name}); dlog.deleted = dlog.deleted.slice(-5000); dlog.records.splice(i, 1); persistAll(); if (db.settings.auto) slack(`:wastebasket: ${r.ref} (${recDev(r)}) was deleted by *${me.name}*. A copy is kept on the server.`); return send(res, 200, {ok: true}); }
  }
  if (m === 'POST' && p === '/api/imei/test') {
    if (!imeiKey()) return send(res, 400, {error: 'Add the API access key first.'});
    const r = await dhru('accountinfo'); if (r.error) return send(res, 502, {error: r.error});
    const a = r.data.AccoutInfo || r.data.AccountInfo || r.data;
    return send(res, 200, {ok: true, username: a.username || IMEI_USER, credit: a.credit ?? a.creditraw ?? '', currency: a.currency || ''});
  }
  if (m === 'GET' && p === '/api/imei/services') {
    if (!imeiKey()) return send(res, 400, {error: 'Add the API access key first.'});
    const r = await dhru('imeiservicelist'); if (r.error) return send(res, 502, {error: r.error});
    const list = flattenServices(r.data.LIST || r.data); if (!list.length) return send(res, 502, {error: 'The service list came back empty.'});
    return send(res, 200, {services: list.slice(0, 1500)});
  }
  if (m === 'POST' && p === '/api/mail/test') {
    if (!mailReady()) return send(res, 400, {error: 'Set RESEND_API_KEY and MAIL_FROM on the server first.'});
    if (!emailOk(b.to)) return send(res, 400, {error: 'Enter an email address to send the test to.'});
    const r = await mailSend({to: String(b.to).trim(), ...buildMail('buy', {ref: 'TEST-0000', date: today(), sellerName: 'Test', brand: 'Sample', model: 'device', imei: '000000000000000', price: '1.00', condition: 'Good'})});
    return send(res, r.ok ? 200 : 502, r.ok ? {ok: true} : {error: r.error});
  }
  if (m === 'GET' && p === '/api/backup') return send(res, 200, {exportedAt: new Date().toISOString(), jobs: db.jobs, records: dlog.records, seq: db.seq});
  if (m === 'POST' && p === '/api/import') {      // jobs from an old single-iPad backup; existing ids are skipped
    const have = new Set(db.jobs.map(j => j.id)); let added = 0;
    for (const o of Array.isArray(b.jobs) ? b.jobs : []) {
      if (!o || have.has(o.id) || !/^[\w-]{8,}$/.test(o.id || '')) continue;
      const j = clean(BLANK, o), at = s => typeof s === 'string' && !isNaN(Date.parse(s)) ? s : new Date().toISOString();
      if (!STATUS.includes(j.status)) j.status = 'Received';
      const cl = arr => (Array.isArray(arr) ? arr : []).slice(0, 500).map(x => ({at: at(x.at), by: String(x.by || '').slice(0, 40), text: String(x.text || '').slice(0, 1000)}));
      Object.assign(j, {id: o.id, ref: String(o.ref || '').slice(0, 12) || pad(++db.seq), createdAt: at(o.createdAt), createdBy: String(o.createdBy || '').slice(0, 40), updatedAt: at(o.updatedAt), updatedBy: String(o.updatedBy || '').slice(0, 40), notes: cl(o.notes), log: cl(o.log)});
      const n = +(j.ref.match(/(\d+)$/)?.[1] || 0); if (n > db.seq) db.seq = n;
      db.jobs.push(j); added++;
    }
    if (added) save(); return send(res, 200, {added});
  }
  return send(res, 404, {error: 'Not found.'});
}

/* ---------- entry points used by the hosts ---------- */
async function settle() {          // send queued Slack posts and emails (always after the data has been saved)
  if (db.slackQ.length) await flushSlack();
  if (db.mailQ.length) await flushMail();
}
async function handle({method, path: pathname, query, headers, body, ip}) {
  const res = {writeHead(code, h) { this.code = code; this.headers = h; }, end(p) { this.payload = p; }};
  const url = {pathname, searchParams: new URLSearchParams(query || '')}, req = {method, headers: headers || {}, ip, body: body || {}};
  await withState(() => api(req, res, url));
  if (store.awaitBackground) await settle(); else settle().catch(e => console.error('background send failed:', e.message));
  return {status: res.code || 500, headers: res.headers || {}, body: res.payload === undefined ? '' : res.payload};
}
async function tick() {            // runs every few minutes: daily Slack summary, retries, daily backup
  await withState(async () => {
    const s = db.settings;
    if (hook() && s.daily && hm() >= s.daily && s.lastDaily !== today()) { s.lastDaily = today(); slack(summary('daily summary', 'auto')); save(false); }
  });
  await settle();
  if (store.backup) await store.backup(today(), db, dlog);
}
function useStore(st) { store = st; }
module.exports = {handle, tick, useStore};
