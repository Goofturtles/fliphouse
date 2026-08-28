// Server-side sales collector — run by GitHub Actions on a schedule.
// Reuses the site's engine.js verbatim so classification keys match the client
// exactly. Polls the last-60s sold-auctions feed a few times, merges into the
// published rolling table, prunes anything older than 24h.
// Node 18+ (fetch, DecompressionStream, atob).
import { createRequire } from 'module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

globalThis.window = globalThis;
createRequire(import.meta.url)('../engine.js');
const sales = window.FlipEngine.sales;

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const file = join(dataDir, 'sales.json');
const DAY = 86400000;
const now = Date.now();

if (existsSync(file)) {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (d && d.v === 1 && d.samples && typeof d.coveredMs === 'number') sales.data = d;
  } catch { /* fresh table */ }
}
const today = Math.floor(now / DAY);
for (const k of Object.keys(sales.data.samples)) {
  const s = sales.data.samples[k];
  const hasWeek = s.w && s.w.some((b) => b[0] > today - 7);
  if (now - s.t > DAY && !hasWeek) { delete sales.data.samples[k]; continue; }
  if (s.w) s.w = s.w.filter((b) => b[0] > today - 7);
}

const POLLS = Number(process.env.POLLS || 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < POLLS; i++) {
  const changed = await sales.poll();
  console.log(`poll ${i + 1}/${POLLS}: ${changed ? 'new window' : 'window already counted'}` +
    ` — coverage ${(sales.data.coveredMs / 60000) | 0}m, keys ${Object.keys(sales.data.samples).length}`);
  if (i < POLLS - 1) await sleep(62000);
}

mkdirSync(dataDir, { recursive: true });
writeFileSync(file, JSON.stringify(sales.data));
console.log(`wrote ${Object.keys(sales.data.samples).length} keys,` +
  ` coverage ${(sales.data.coveredMs / 60000) | 0}m`);
