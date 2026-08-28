// Builds data/npc.json — items an NPC sells outright for coins, keyed by
// display name. If an NPC sells it for less than a flip's resale target,
// nobody pays the AH premium. Source: NEU repo npc_shop recipes.
// Node 18+, no deps (minimal tar walk over the repo tarball).
import { gunzipSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const TARBALL = 'https://codeload.github.com/NotEnoughUpdates/NotEnoughUpdates-REPO/tar.gz/refs/heads/master';

const res = await fetch(TARBALL);
if (!res.ok) throw new Error('tarball fetch failed: ' + res.status);
const tar = gunzipSync(Buffer.from(await res.arrayBuffer()));

const strip = (s) => String(s || '').replace(/§./g, '');
const names = {};   // internal tag -> display name
const recipes = []; // [resultTag, count, coins]

for (let off = 0; off + 512 <= tar.length;) {
  const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
  if (!name) break;
  const size = parseInt(tar.toString('utf8', off + 124, off + 136).trim(), 8) || 0;
  const body = off + 512;
  if (name.includes('/items/') && name.endsWith('.json')) {
    try {
      const it = JSON.parse(tar.toString('utf8', body, body + size));
      if (it.internalname) names[it.internalname] = strip(it.displayname).trim();
      for (const r of it.recipes || []) {
        if (r.type !== 'npc_shop') continue;
        let coins = 0, pure = true;
        for (const c of r.cost || []) {
          if (typeof c === 'string' && c.startsWith('SKYBLOCK_COIN:')) coins += parseFloat(c.slice(14));
          else pure = false;
        }
        if (!pure || !(coins > 0)) continue;
        let tag = r.result || '', cnt = 1;
        const m = /^(.*):(\d+(?:\.\d+)?)$/.exec(tag);
        if (m) { tag = m[1]; cnt = Math.max(1, parseInt(m[2], 10)); }
        if (tag) recipes.push([tag, cnt, coins]);
      }
    } catch { /* one bad json — skip */ }
  }
  off = body + Math.ceil(size / 512) * 512;
}

const shop = {};
for (const [tag, cnt, coins] of recipes) {
  const nm = names[tag] || tag;
  const per = Math.round(coins / cnt);
  if (!(nm in shop) || shop[nm] > per) shop[nm] = per;
}

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, '..', 'data'), { recursive: true });
writeFileSync(join(here, '..', 'data', 'npc.json'), JSON.stringify(shop));
console.log('wrote', Object.keys(shop).length, 'NPC shop prices; sample Undead Sword =', shop['Undead Sword']);
