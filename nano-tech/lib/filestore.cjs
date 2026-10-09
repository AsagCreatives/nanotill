'use strict';
/* Saves to files in a folder (used by server.js). Data lives in memory and is written to disk on every change. */
const fs = require('fs'), path = require('path');
module.exports = function fileStore(DATA) {
  fs.mkdirSync(path.join(DATA, 'backups'), {recursive: true}); fs.mkdirSync(path.join(DATA, 'photos'), {recursive: true});
  const files = {db: path.join(DATA, 'db.json'), dlog: path.join(DATA, 'devicelog.json'), aux: path.join(DATA, 'aux.json')};
  const read = (k, dflt) => { try { return JSON.parse(fs.readFileSync(files[k], 'utf8')); } catch (e) { if (e.code === 'ENOENT') return dflt; throw new Error(`${path.basename(files[k])} is unreadable, refusing to start so nothing is overwritten: ${e.message}`); } };
  const mem = {db: read('db', {}), dlog: read('dlog', {}), aux: read('aux', {})};
  const write = k => { const t = files[k] + '.tmp'; fs.writeFileSync(t, JSON.stringify(mem[k])); fs.renameSync(t, files[k]); };
  return {
    imeiBudgetMs: 20000,
    async load() { return mem; },
    touch(k) { write(k); },                 // saved straight away
    async commit() { return true; },
    async putPhoto(id, ext, buf) { fs.writeFileSync(path.join(DATA, 'photos', `${id}.${ext}`), buf); },
    async getPhoto(id, ext) { const f = path.join(DATA, 'photos', `${id}.${ext}`); return fs.existsSync(f) ? fs.readFileSync(f) : null; },
    async backup(day) {
      for (const [pre, k] of [['db', 'db'], ['devicelog', 'dlog']]) {
        const f = path.join(DATA, 'backups', `${pre}-${day}.json`);
        if (!fs.existsSync(f) && fs.existsSync(files[k])) fs.copyFileSync(files[k], f);
        const all = fs.readdirSync(path.join(DATA, 'backups')).filter(x => x.startsWith(pre + '-')).sort();
        all.slice(0, Math.max(0, all.length - 30)).forEach(x => fs.unlinkSync(path.join(DATA, 'backups', x)));
      }
    }
  };
};
