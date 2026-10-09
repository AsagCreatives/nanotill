// Saves to Netlify Blobs (built into every Netlify site, nothing to set up).
// Every save is conditional on nobody else having saved in the meantime; if they did, lib/core.cjs re-reads and tries again.
async function stores() {
  if (globalThis.__NANO_GETSTORE) return globalThis.__NANO_GETSTORE;      // used by the local test harness only
  const { getStore } = await import('@netlify/blobs');
  return getStore;
}
export async function blobStore() {
  const getStore = await stores();
  const data = getStore({ name: 'nano-data', consistency: 'strong' }), photos = getStore({ name: 'nano-photos', consistency: 'strong' }), backups = getStore({ name: 'nano-backups' });
  // Jobs, buying/selling records and settings are saved together as ONE document, so a save is all-or-nothing.
  const state = {}, dirty = new Set(); let mainEtag = null;
  return {
    awaitBackground: true,        // a function stops when it answers, so finish the Slack / email sending first
    imeiBudgetMs: 6500,           // keep each request well under the function time limit; the app keeps asking for the result
    async load() {
      dirty.clear();
      const [m, x] = await Promise.all([data.getWithMetadata('main', { type: 'json', consistency: 'strong' }), data.getWithMetadata('aux', { type: 'json', consistency: 'strong' })]);
      mainEtag = m ? m.etag : null; state.db = (m && m.data && m.data.db) || {}; state.dlog = (m && m.data && m.data.dlog) || {}; state.aux = x ? x.data : {};
      return state;
    },
    touch(k) { dirty.add(k === 'aux' ? 'aux' : 'main'); },
    async commit() {
      if (dirty.has('main')) {
        const r = await data.setJSON('main', { db: state.db, dlog: state.dlog }, mainEtag ? { onlyIfMatch: mainEtag } : { onlyIfNew: true });
        if (r && r.modified === false) return false;               // someone else saved first: the caller reads again and retries
        if (r && r.etag) mainEtag = r.etag;
      }
      if (dirty.has('aux')) await data.setJSON('aux', state.aux);   // login limits and the IMEI cache: not worth a retry
      dirty.clear(); return true;
    },
    async putPhoto(id, ext, buf) { await photos.set(`${id}.${ext}`, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); },
    async getPhoto(id, ext) { const ab = await photos.get(`${id}.${ext}`, { type: 'arrayBuffer' }); return ab ? Buffer.from(ab) : null; },
    async backup(day, db, dlog) {
      if (await backups.get(`db-${day}`)) return;
      await backups.set(`db-${day}`, JSON.stringify(db)); await backups.set(`devicelog-${day}`, JSON.stringify(dlog));
      const { blobs } = await backups.list();
      for (const pre of ['db-', 'devicelog-']) {
        const keys = blobs.map(b => b.key).filter(k => k.startsWith(pre)).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - 30))) await backups.delete(k);
      }
    }
  };
}
