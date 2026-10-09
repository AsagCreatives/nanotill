'use strict';
/* Run the whole app on your own computer or server: `node server.js` (Node 18+, no installs).
   For Netlify use the netlify/ folder instead. */
const http = require('http'), fs = require('fs'), path = require('path');
const core = require('./lib/core.cjs'), fileStore = require('./lib/filestore.cjs');
const PORT = +process.env.PORT || 3000, DATA = process.env.DATA_DIR || path.join(__dirname, 'data'), PUB = path.join(__dirname, 'public');
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml'};
core.useStore(fileStore(DATA));
const readBody = req => new Promise((ok, no) => { let d = '', n = 0; req.on('data', c => { n += c.length; if (n > 9e6) { no(new Error('too big')); req.destroy(); } else d += c; }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(e); } }); });

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    if (url.pathname.startsWith('/api/')) {
      const out = await core.handle({method: req.method, path: url.pathname, query: url.search, headers: req.headers, ip: req.socket.remoteAddress, body: ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {}});
      res.writeHead(out.status, out.headers); return res.end(out.body);
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const f = path.resolve(PUB, name);
    if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    fs.createReadStream(f).pipe(res);
  } catch (e) { console.error(e.message); if (!res.headersSent) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: 'Bad request.'})); } else res.end(); }
}).listen(PORT, () => console.log(`Nano tracker running on port ${PORT}. Data folder: ${DATA}`));
setInterval(() => core.tick().catch(e => console.error('background job failed:', e.message)), 60000).unref();
core.tick().catch(e => console.error(e.message));
