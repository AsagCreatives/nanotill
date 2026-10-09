// All /api/* requests land here (see netlify.toml / config below).
import core from '../../lib/core.cjs';
import { blobStore } from '../lib/blobstore.mjs';

// One request at a time per function instance (Netlify already does this); other instances are handled by the conditional saves.
let queue = Promise.resolve();
const oneAtATime = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

export default (req, context) => oneAtATime(() => handle(req, context));

async function handle(req, context) {
  try {
    core.useStore(await blobStore());
    const url = new URL(req.url), headers = Object.fromEntries(req.headers);
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') { try { body = (await req.json()) || {}; } catch (_) { body = {}; } }
    const out = await core.handle({ method: req.method, path: url.pathname, query: url.search, headers, ip: (context && context.ip) || headers['x-nf-client-connection-ip'] || '', body });
    return new Response(out.body, { status: out.status, headers: out.headers });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: 'The server had a problem. Please try again.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
export const config = { path: '/api/*' };
