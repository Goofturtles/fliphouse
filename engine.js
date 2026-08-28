/* Fliphouse engine — scans Hypixel Skyblock BIN auctions, tracks real sales,
   and finds resale gaps. Classic script, exposes window.FlipEngine. No deps. */
(function () {
  'use strict';

  var API = 'https://api.hypixel.net/v2/skyblock/auctions';
  var API_ENDED = 'https://api.hypixel.net/v2/skyblock/auctions_ended';
  var CONCURRENCY = 6;
  var LS_SALES = 'ahflips:sales1';
  var DAY_MS = 86400000;

  /* Tunable via setOptions(). basis: how the resale price is picked.
     lots: how many of the cheapest listings per item to surface as buyable flips. */
  var opts = { basis: 'undercut', lots: 1, minSupply: 3 };

  var lastGroups = null; // Map from the most recent scan, kept for rebuild()
  var lastMeta = null;

  /* Reforge prefixes stripped so "Sharp Livid Dagger" and "Fabled Livid Dagger"
     land in the same price group. Sorted longest-first at init so multi-word
     reforges match before their shorter cousins. */
  var REFORGES = [
    // swords
    'Epic', 'Fair', 'Fast', 'Gentle', 'Heroic', 'Legendary', 'Odd', 'Sharp', 'Spicy',
    'Coldfused', 'Dirty', 'Fabled', 'Suspicious', 'Warped', 'Withered', 'Bulky', 'Fanged',
    'Great', 'Rugged',
    // bows
    'Awkward', 'Deadly', 'Fine', 'Grand', 'Hasty', 'Neat', 'Rapid', 'Rich', 'Unreal',
    'Precise', 'Spiritual', 'Headstrong',
    // armor
    'Clean', 'Fierce', 'Heavy', 'Light', 'Mythic', 'Pure', 'Smart', 'Titanic', 'Wise',
    'Candied', 'Submerged', 'Perfect', 'Reinforced', 'Renowned', 'Spiked', 'Hyper',
    'Giant', 'Jaded', 'Cubic', 'Necrotic', 'Empowered', 'Ancient', 'Undead', 'Loving',
    'Ridiculous', 'Bustling', 'Mossy', 'Festive', 'Greater Spook',
    // equipment
    'Stained', 'Menacing', 'Hefty', 'Soft', 'Honored', 'Blended', 'Astute', 'Colossal',
    'Brilliant', 'Waxed', 'Fortified', 'Strengthened', 'Glistening', 'Blooming', 'Rooted',
    'Snowy', 'Squeaky', 'Dimensional',
    // accessories
    'Bizarre', 'Itchy', 'Ominous', 'Pleasant', 'Pretty', 'Shiny', 'Simple', 'Strange',
    'Vivid', 'Godly', 'Demonic', 'Forceful', 'Hurtful', 'Keen', 'Strong', 'Superior',
    'Unpleasant', 'Zealous', 'Silky', 'Bloody', 'Shaded', 'Sweet', 'Unyielding',
    // tools / rods / drills
    'Robust', 'Zooming', 'Peasant', 'Green Thumb', 'Blessed', 'Bountiful', 'Salty',
    'Treacherous', 'Lucky', 'Stiff', 'Chomp', 'Auspicious', 'Fleet', 'Heated', 'Ambered',
    'Refined', 'Mithraic', 'Lustrous', 'Stellar', 'Fruitful', 'Magnetic',
    // dungeon
    'Moil', 'Toil'
  ].sort(function (a, b) { return b.length - a.length; });

  /* Base item names that legitimately start with a reforge word
     ("Wise Dragon Boots", "Refined Mithril", "Lucky Clover") — never strip there. */
  var GUARD = /^(Dragon|Mithril|Titanium|Diamond|Mineral|Clover|White|Helmet|Chestplate|Leggings|Boots)\b/;

  var PET_RE = /^\[Lvl (\d+)\] (.+)$/;
  var STARS_RE = /\s*([✪➊➋➌➍➎]+)\s*$/;
  var DECO_RE = /^([^A-Za-z0-9\[\]]+)\s+(.+)$/; // leading symbols like ✿ ⚚ ◆
  var TIER_RE = /\b(VERY SPECIAL|COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC|DIVINE|SPECIAL|SUPREME|ULTIMATE)\b/;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function stripCodes(s) { return String(s).replace(/§./g, ''); }

  function starBucket(glyphs) {
    var stars = 0, master = 0;
    for (var i = 0; i < glyphs.length; i++) {
      var ch = glyphs.charAt(i);
      if (ch === '✪') stars++;
      else master = '➊➋➌➍➎'.indexOf(ch) + 1 || master;
    }
    var total = stars + master;
    if (total <= 0) return '';
    if (total >= 6) return 'M✪';
    if (total === 5) return '5✪';
    return '1-4✪';
  }

  /* Normalize an item name for grouping: hold decoration symbols and star count,
     strip the reforge prefix, return the pieces. */
  function cleanName(raw) {
    var name = String(raw).replace(/[\u2800\u200B\uFEFF\uE000-\uF8FF]/g, '').trim();
    var stars = '';
    var sm = name.match(STARS_RE);
    if (sm) { stars = starBucket(sm[1]); name = name.replace(STARS_RE, '').trim(); }

    var deco = '';
    var dm = name.match(DECO_RE);
    if (dm) { deco = dm[1]; name = dm[2]; }

    for (var i = 0; i < REFORGES.length; i++) {
      var r = REFORGES[i];
      if (name.length > r.length + 1 && name.lastIndexOf(r, 0) === 0 && name.charAt(r.length) === ' ') {
        var rest = name.slice(r.length + 1);
        // GUARD: real base-item families that start with reforge words
        // ("Wise Dragon Boots", "Heavy Chestplate", "Perfect Jasper Gemstone")
        if (!GUARD.test(rest) && !/Gemstone$/.test(rest)) name = rest;
        break;
      }
    }
    if (deco) name = deco + ' ' + name;
    return { name: name, stars: stars };
  }

  function petBucket(lvl) {
    if (lvl >= 200) return '200';
    if (lvl > 100) return '101-199';
    if (lvl === 100) return '100';
    if (lvl >= 90) return '90-99';
    if (lvl >= 70) return '70-89';
    if (lvl >= 40) return '40-69';
    return '1-39';
  }

  function firstLoreLine(lore) {
    return stripCodes(String(lore || '').split('\n')[0] || '').trim();
  }

  function kindOf(cat) {
    if (cat === 'weapon' || cat === 'armor' || cat === 'accessories') return cat;
    return 'other';
  }

  function catLabel(cat) {
    switch (cat) {
      case 'weapon': return 'Weapon';
      case 'armor': return 'Armor';
      case 'accessories': return 'Accessory';
      case 'consumables': return 'Consumable';
      case 'blocks': return 'Blocks';
      default: return 'Misc';
    }
  }

  /* Decide which price group an item belongs to. Works for both live auctions
     and decoded sold items (a: {item_name, item_lore, tier, category?}).
     Returns null when the item can't be grouped safely. */
  function classify(a) {
    var raw = a.item_name || '';
    var tier = a.tier || 'COMMON';

    if (raw === 'Enchanted Book') {
      var ench = firstLoreLine(a.item_lore);
      // Multi-enchant books list enchants comma-separated — value depends on the
      // whole set, so a name-level group would compare apples to oranges. Skip.
      if (!ench || ench.indexOf(',') !== -1 || ench.length > 40) return null;
      return { key: 'book|' + ench + '|' + tier, display: ench, sub: 'Enchanted Book', kind: 'book', tier: tier };
    }

    var pm = raw.match(PET_RE);
    if (pm) {
      var lvl = parseInt(pm[1], 10);
      var base = pm[2].trim();
      var bucket = petBucket(lvl);
      return {
        key: 'pet|' + base + '|' + tier + '|' + bucket,
        display: base, sub: 'Pet · Lvl ' + bucket, kind: 'pet', tier: tier
      };
    }

    var cn = cleanName(raw);
    if (!cn.name) return null;
    var subBits = [catLabel(a.category)];
    if (cn.stars) subBits.push(cn.stars);

    // New Year Cakes: the year (first lore line) is the entire value.
    if (cn.name.lastIndexOf('New Year Cake', 0) === 0) {
      var year = firstLoreLine(a.item_lore);
      return {
        key: 'item|' + cn.name + '|' + year + '|' + tier,
        display: year ? cn.name + ' (' + year + ')' : cn.name,
        sub: subBits.join(' · '), kind: kindOf(a.category), tier: tier
      };
    }

    return {
      key: 'item|' + cn.name + '|' + cn.stars + '|' + tier,
      display: cn.name, sub: subBits.join(' · '), kind: kindOf(a.category), tier: tier
    };
  }

  /* ---------------- lore signatures (like-for-like matching) ----------------
     Two listings under the same name can be wildly different items: enchants,
     dyes, gems, drill upgrades, attributes. A flip only counts against listings
     whose LORE genuinely matches. Stat lines are reduced to their stat name so
     reforge/star rolls don't matter; enchant/ability/dye lines must match;
     gem lines keep their color codes (filled vs empty slots differ). */

  var GEM_RE = /[❁❈☘⸕✎✧❂✿]/;
  var STAT_RE = /^([A-Za-z][A-Za-z '\-]{0,28}):\s*[+\-]?[\d.]/;
  var ENCH_SEG = /^[A-Za-z][A-Za-z' \-]*\s[IVXLCDM]+$/;

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  /* "Legion V, Growth V, Hecatomb X" / "Vampiric Vitality IV" / "Chimera I" */
  function isEnchLine(t) {
    var segs = t.split(', ');
    for (var i = 0; i < segs.length; i++) {
      if (!ENCH_SEG.test(segs[i].trim())) return false;
    }
    return segs.length > 0;
  }

  /* Only HIGH-SIGNAL lines make the signature. Ability paragraphs and flavor
     text are identical boilerplate that would drown the few lines that carry
     value; stat lines are downstream of enchants and full of reforge/star
     noise. What identifies an item: its enchant set, its gem/dye glyph lines
     (raw, so filled vs empty slots differ), and non-numeric "Key: value"
     lines (Ability:, Held Item:, Upgrade Module:, …). */
  function sigOf(rawLore) {
    var lines = String(rawLore || '').split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var t = stripCodes(raw).trim();
      if (!t) continue;
      if (TIER_RE.test(t)) continue;          // rarity footer (incl. recomb noise)
      if (t.charAt(0) === '▸') continue;      // pet XP progress
      if (STAT_RE.test(t)) continue;          // numeric stat rolls
      if (t.indexOf('Pet Candy Used') !== -1) { out.push(hashStr(t)); continue; } // "(2/10) Pet Candy Used" — candied ≠ clean
      if (GEM_RE.test(raw)) { out.push(hashStr(raw)); continue; }
      var tl = t.replace(/,\s*$/, ''); // wrapped enchant lists end mid-list with a comma
      if (isEnchLine(tl)) {
        // one token PER enchant, so "Growth V, Protection V" and a wrapped or
        // reordered list of the same enchants produce identical tokens
        var segs = tl.split(', ');
        for (var s2 = 0; s2 < segs.length; s2++) out.push(hashStr(segs[s2].trim()));
        continue;
      }
      if (/^[A-Za-z ]+ Pet(, .+)?$/.test(t)) { out.push(hashStr(t)); continue; } // pet footer names the applied skin
      var c = t.indexOf(': ');
      if (c > 0) out.push(hashStr(t));        // Ability: / Held Item: / Color: / Upgrade Module: …
    }
    return out;
  }

  function fetchJson(url) {
    return new Promise(function (resolve, reject) {
      var attempt = 0;
      function go() {
        fetch(url)
          .then(function (res) {
            if (res.status === 429) throw { rateLimited: true };
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (json) {
            if (!json.success) throw new Error('API returned success:false');
            resolve(json);
          })
          .catch(function (e) {
            attempt++;
            if (attempt >= 4) return reject(e instanceof Error ? e : new Error('rate limited'));
            sleep((e && e.rateLimited ? 2500 : 700) * attempt).then(go);
          });
      }
      go();
    });
  }

  /* AH claiming tax by sale price. */
  function feeRate(price) {
    if (price < 1e7) return 0.01;
    if (price < 1e8) return 0.02;
    return 0.025;
  }

  /* ---------------- sales tracker (auctions_ended) ---------------- */

  var canDecode = typeof DecompressionStream !== 'undefined';

  function gunzip(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var ds = new DecompressionStream('gzip');
    return new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  }

  /* Minimal big-endian NBT reader — only the shapes Hypixel item_bytes use. */
  function parseNbt(buf) {
    var dv = new DataView(buf);
    var pos = 0;
    var td = new TextDecoder();
    function str() {
      var n = dv.getUint16(pos); pos += 2;
      var out = td.decode(new Uint8Array(buf, pos, n)); pos += n;
      return out;
    }
    function payload(t) {
      switch (t) {
        case 1: return dv.getInt8(pos++);
        case 2: { var v2 = dv.getInt16(pos); pos += 2; return v2; }
        case 3: { var v3 = dv.getInt32(pos); pos += 4; return v3; }
        case 4: pos += 8; return 0;
        case 5: pos += 4; return 0;
        case 6: { var v6 = dv.getFloat64(pos); pos += 8; return v6; }
        case 7: { var n7 = dv.getInt32(pos); pos += 4 + n7; return null; }
        case 8: return str();
        case 9: {
          var ct = dv.getUint8(pos++);
          var n9 = dv.getInt32(pos); pos += 4;
          if (ct === 0 || n9 <= 0) return [];
          var arr = [];
          for (var i = 0; i < n9; i++) arr.push(payload(ct));
          return arr;
        }
        case 10: {
          var o = {};
          for (;;) {
            var tt = dv.getUint8(pos++);
            if (tt === 0) return o;
            var name = str(); // must be read before the payload
            o[name] = payload(tt);
          }
        }
        case 11: { var n11 = dv.getInt32(pos); pos += 4 + 4 * n11; return null; }
        case 12: { var n12 = dv.getInt32(pos); pos += 4 + 8 * n12; return null; }
        default: throw new Error('nbt tag ' + t);
      }
    }
    var t = dv.getUint8(pos++); str();
    return payload(t);
  }

  /* Decode one sold auction's item_bytes into the classify() input shape. */
  function decodeSoldItem(b64) {
    return gunzip(b64).then(function (buf) {
      var root = parseNbt(buf);
      var item = (root.i && root.i[0]) || {};
      var tag = item.tag || {};
      var disp = tag.display || {};
      var lore = disp.Lore || [];
      var name = stripCodes(disp.Name || '').replace(/[\u2800\u200B\uFEFF\uE000-\uF8FF]/g, '').trim();
      if (!name) return null;
      var tier = 'COMMON';
      for (var i = lore.length - 1; i >= 0; i--) {
        var m = TIER_RE.exec(stripCodes(lore[i]));
        if (m) { tier = m[1].replace(' ', '_'); break; }
      }
      return { item_name: name, item_lore: lore.join('\n'), tier: tier };
    });
  }

  function freshSales() {
    return { v: 1, start: Date.now(), coveredMs: 0, lastWindow: 0, samples: {} };
  }

  var sales = {
    data: freshSales(),

    load: function () {
      try {
        var d = JSON.parse(localStorage.getItem(LS_SALES));
        if (d && d.v === 1 && d.samples && typeof d.coveredMs === 'number') {
          var cutoff = Date.now() - DAY_MS;
          var fresh = false;
          for (var k in d.samples) {
            if (d.samples[k].t < cutoff) delete d.samples[k];
            else fresh = true;
          }
          // a table with nothing from the last 24h is dead weight — start clean
          this.data = fresh ? d : freshSales();
        }
      } catch (e) { /* fresh start */ }
    },

    save: function () {
      try { localStorage.setItem(LS_SALES, JSON.stringify(this.data)); } catch (e) { /* full — fine */ }
    },

    /* Pull the last 60s of real sales. Resolves true when new data landed. */
    poll: function () {
      var self = this;
      if (!canDecode) return Promise.resolve(false);
      return fetchJson(API_ENDED).then(function (json) {
        if (!json.lastUpdated || json.lastUpdated <= self.data.lastWindow) return false;
        var list = json.auctions || [];
        var jobs = list.map(function (a) {
          // Promise.resolve first so a sync throw (bad base64) hits the catch below
          return Promise.resolve(a.item_bytes).then(decodeSoldItem)
            .then(function (pseudo) {
              if (!pseudo) return;
              var c = classify(pseudo);
              if (!c) return;
              var s = self.data.samples[c.key];
              if (!s) s = self.data.samples[c.key] = { c: 0, ps: [], t: 0 };
              s.c++; // demand counts every sale…
              if (a.bin) { // …but only BIN prices are resale evidence (bid hammers skew low)
                s.ps.push(a.price);
                if (s.ps.length > 8) s.ps.shift();
              }
              s.t = a.timestamp || Date.now();
            })
            .catch(function () { /* one undecodable item — skip */ });
        });
        return Promise.all(jobs).then(function () {
          self.data.lastWindow = json.lastUpdated;
          if (self.data.coveredMs >= DAY_MS) {
            // sliding 24h window: each new minute decays the old ones out, so
            // counts and coverage stay proportional forever — no resets needed
            var decay = (DAY_MS - 60000) / DAY_MS;
            var smp = self.data.samples;
            for (var dk in smp) smp[dk].c *= decay;
          } else {
            self.data.coveredMs = Math.min(self.data.coveredMs + 60000, DAY_MS);
          }
          var cutoff = Date.now() - DAY_MS;
          var smp2 = self.data.samples;
          for (var pk in smp2) {
            if (smp2[pk].t < cutoff || smp2[pk].c < 0.05) delete smp2[pk];
          }
          self.prune();
          self.save();
          return true;
        });
      }).catch(function () { return false; });
    },

    prune: function () {
      var keys = Object.keys(this.data.samples);
      if (keys.length <= 5000) return;
      var self = this;
      keys.sort(function (a, b) { return self.data.samples[a].t - self.data.samples[b].t; });
      for (var i = 0; i < keys.length - 5000; i++) delete this.data.samples[keys[i]];
    },

    coverageMs: function () { return this.data.coveredMs; },

    /* Adopt a server-collected sales table (published by the repo's cron
       collector) when it has more coverage than what this browser has seen.
       Local polling then keeps extending it. */
    bootstrap: function (url) {
      var self = this;
      return fetch(url, { cache: 'no-cache' })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (remote) {
          if (!remote || remote.v !== 1 || !remote.samples ||
              typeof remote.coveredMs !== 'number') return false;
          if (remote.coveredMs <= self.data.coveredMs) return false;
          self.data = {
            v: 1,
            start: typeof remote.start === 'number' ? remote.start : Date.now(),
            coveredMs: Math.min(remote.coveredMs, DAY_MS),
            lastWindow: remote.lastWindow || 0,
            samples: remote.samples
          };
          self.save();
          return true;
        })
        .catch(function () { return false; });
    },

    stats: function (key) {
      var cov = this.data.coveredMs;
      var s = this.data.samples[key];
      var out = { sold: s ? Math.round(s.c) : 0, estDay: null, soldMedian: null, coverageMs: cov };
      if (s && s.ps.length >= 2) {
        var ps = s.ps.slice().sort(function (a, b) { return a - b; });
        out.soldMedian = (ps.length % 2) ? ps[(ps.length - 1) / 2]
          : Math.round((ps[ps.length / 2 - 1] + ps[ps.length / 2]) / 2);
      }
      // A rate needs real evidence: one lucky sale in a tiny window extrapolates
      // to nonsense, and "no sales" only means something after a long watch.
      if (cov >= 5 * 60000 && s && s.c >= 2) out.estDay = Math.min(s.c * DAY_MS / cov, 960);
      else if (cov >= 45 * 60000 && !s) out.estDay = 0;
      return out;
    },

    enabled: function () { return canDecode; }
  };

  /* ---------------- scan + flip building ---------------- */

  function scan(onProgress) {
    var groups = new Map();
    var binCount = 0;
    var now = Date.now();
    var seen = new Set(); // the snapshot can rotate mid-scan and repeat auctions across pages

    function ingest(pageData) {
      try {
        var list = pageData.auctions || [];
        for (var i = 0; i < list.length; i++) {
          var a = list[i];
          if (!a.bin) continue;                    // only Buy It Now
          if (a.highest_bid_amount > 0) continue;  // already bought, awaiting claim
          if (a.end <= now) continue;              // expired
          if (seen.has(a.uuid)) continue;
          seen.add(a.uuid);
          binCount++;
          var c = classify(a);
          if (!c) continue;
          var g = groups.get(c.key);
          if (!g) {
            g = { display: c.display, sub: c.sub, kind: c.kind, tier: c.tier, listings: [] };
            groups.set(c.key, g);
          }
          g.listings.push({ p: a.starting_bid, uuid: a.uuid, s: sigOf(a.item_lore) });
        }
      } catch (e) { /* one malformed page must not sink the scan */ }
    }

    return fetchJson(API + '?page=0').then(function (first) {
      ingest(first);
      var totalPages = first.totalPages;
      var done = 1, failed = 0, next = 1;
      if (onProgress) onProgress(done, totalPages);

      function worker() {
        var p = next++;
        if (p >= totalPages) return Promise.resolve();
        return fetchJson(API + '?page=' + p)
          .then(ingest, function () { failed++; })
          .then(function () {
            done++;
            if (onProgress) onProgress(done, totalPages);
            return worker();
          });
      }

      var lanes = [];
      for (var w = 0; w < Math.min(CONCURRENCY, totalPages); w++) lanes.push(worker());

      return Promise.all(lanes).then(function () {
        if (failed > Math.max(2, Math.floor(totalPages * 0.1))) {
          throw new Error(failed + ' of ' + totalPages + ' pages failed to load');
        }
        lastGroups = groups;
        lastMeta = {
          totalAuctions: first.totalAuctions,
          binCount: binCount,
          pages: totalPages,
          failedPages: failed,
          apiUpdated: first.lastUpdated,
          scannedAt: Date.now()
        };
        return build(groups, lastMeta);
      });
    });
  }

  /* Recompute flips from the last scan (new sales data or changed options). */
  function rebuild() {
    if (!lastGroups) return null;
    return build(lastGroups, lastMeta);
  }

  function build(groups, meta) {
    var flips = [];
    var minSupply = Math.max(3, opts.minSupply | 0);
    var maxLots = Math.min(3, Math.max(1, opts.lots | 0));

    groups.forEach(function (g, key) {
      var L = g.listings;
      var n = L.length;
      if (n < minSupply) return; // need real market depth to price the resale
      L.sort(function (a, b) { return a.p - b.p; });

      var sets = new Array(n);
      function setOf(i) { return sets[i] || (sets[i] = new Set(L[i].s || [])); }
      /* Comparable = at most ONE lore token differs in either direction.
         Boilerplate is identical on every copy so it can never pad the score;
         an extra enchant, filled gem, held item or exotic color always lands
         in the difference — a clean copy never matches a maxed one. */
      function alike(i, j) {
        var A = setOf(i), B = setOf(j);
        var diff = 0;
        A.forEach(function (h) { if (!B.has(h)) diff++; });
        B.forEach(function (h) { if (!A.has(h)) diff++; });
        return diff <= 1;
      }

      var d = sales.stats(key);

      for (var li = 0; li < Math.min(maxLots, n - 1); li++) {
        var buy = L[li];

        // resale evidence must come from listings that are actually the same
        // item, and only from ones still on sale after you buy this lot
        var comp = [];
        for (var j = li + 1; j < n && comp.length < 30; j++) {
          if (alike(li, j)) comp.push(L[j]);
        }
        var cn = comp.length;
        if (cn + 1 < minSupply) continue; // name twins exist, true twins don't

        var median = (cn % 2) ? comp[(cn - 1) / 2].p : Math.round((comp[cn / 2 - 1].p + comp[cn / 2].p) / 2);
        var basisUsed = opts.basis;
        var target;
        if (opts.basis === 'median') target = median;
        // sold prices are tracked per name, so only trust them when every
        // same-name listing is a true lore twin (no mixed variants)
        else if (opts.basis === 'sold' && d.soldMedian != null && cn + 1 === n) target = d.soldMedian;
        else { target = comp[0].p; basisUsed = 'undercut'; }

        var fee = feeRate(target);
        var profit = Math.floor(target * (1 - fee)) - buy.p;
        if (profit < 50000) continue;
        var roi = profit / buy.p;
        if (roi < 0.03) continue;
        if (buy.p < 1000) continue;

        /* ---- risk: sold prices are truth, asks are wishes ----
           Default-visible flips need EITHER real sold prices backing the resale
           (and a buy clearly below what the item actually sells for), OR a
           tight, deep ask ladder. Everything else is speculation → risky. */
        var nearT = 0;
        for (var k2 = 0; k2 < cn; k2++) { if (comp[k2].p <= target * 1.2) nearT++; }

        var risk, why;
        if (roi > 3) {
          risk = 'high'; why = 'margin looks too good — usually hidden value explains the cheap price';
        } else if (d.soldMedian != null && buy.p >= d.soldMedian) {
          risk = 'high'; why = 'recent buyers paid less than this buy price — no real edge';
        } else if (d.soldMedian != null && target > d.soldMedian * 1.4) {
          risk = 'high'; why = 'sellers are asking way above what this item actually sells for';
        } else if (d.soldMedian != null) {
          // corroborated: buyers really pay around this price, and the buy is under it
          risk = (buy.p <= d.soldMedian * 0.85 && cn + 1 >= 4 && nearT >= 2) ? 'low' : 'med';
          why = risk === 'low' ? 'real sold prices back this resale, with a real margin under them'
            : 'sold prices back the resale, but the edge or supply is thin';
        } else {
          // No real sold prices. Asks alone cannot verify a flip — sellers herd
          // at fantasy prices even in deep tight clusters (10+ gloves asked at
          // 9-12m that actually trade at 5m). Unverified = hidden.
          risk = 'high';
          why = median > target * 1.8
            ? 'asks on this item are wildly scattered — no reliable resale price'
            : 'no real sales observed yet to verify this price — leave the tab open and it may confirm';
        }

        // demand-rate adjustments from watching real sales
        if (d.estDay != null) {
          if (d.estDay < 0.5) { risk = 'high'; why = 'we watched the AH and this basically never sells'; }
          else if (d.estDay < 2 && risk === 'low') { risk = 'med'; why = 'sells, but slowly — under 2 a day'; }
          else if (d.estDay >= 10 && risk !== 'high') { why = 'sells fast — ' + Math.round(d.estDay) + ' a day observed'; }
        } else if (d.soldMedian == null) {
          // no real sold PRICES — price-aware prior: nobody impulse-buys a 400m item
          if (target >= 2e8) { risk = 'high'; why = 'price this high needs proof buyers exist — none observed yet'; }
          else if (target >= 5e7 && risk !== 'high') { risk = 'high'; why = 'expensive item without enough observed sales yet'; }
        }

        flips.push({
          key: key, lot: li, name: g.display, sub: g.sub, kind: g.kind, tier: g.tier,
          buy: buy.p, uuid: buy.uuid, sell: target, fee: fee, basis: basisUsed,
          profit: profit, roi: roi, supply: cn + 1, groupSize: n,
          median: median, risk: risk, why: why,
          sold: d.sold, estDay: d.estDay, soldMedian: d.soldMedian,
          ladder: [buy.p].concat(comp.slice(0, 7).map(function (x) { return x.p; }))
        });
      }
    });

    flips.sort(function (a, b) { return b.profit - a.profit; });
    meta.demand = { coverageMs: sales.coverageMs(), tracking: sales.enabled() };
    return { flips: flips, meta: meta };
  }

  function setOptions(o) {
    if (!o) return;
    if (o.basis === 'undercut' || o.basis === 'median' || o.basis === 'sold') opts.basis = o.basis;
    if (o.lots != null) opts.lots = Math.min(3, Math.max(1, o.lots | 0));
    if (o.minSupply != null) opts.minSupply = Math.min(10, Math.max(3, o.minSupply | 0));
  }

  sales.load();

  window.FlipEngine = {
    scan: scan,
    rebuild: rebuild,
    setOptions: setOptions,
    getOptions: function () { return { basis: opts.basis, lots: opts.lots, minSupply: opts.minSupply }; },
    sales: sales,
    feeRate: feeRate
  };
})();
