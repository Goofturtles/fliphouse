/* Fliphouse UI — filters, budget planner, settings, demand, rendering.
   Classic script, needs engine.js first. */
(function () {
  'use strict';

  var LS_SCAN = 'ahflips:scan2';
  var LS_PREFS = 'ahflips:prefs';
  var FRESH_MS = 5 * 60 * 1000;    // auto-rescan if cache older than this
  var RESCAN_MS = 150 * 1000;      // auto-rescan interval (opt-in setting)
  var SALES_MS = 65 * 1000;        // demand poll — auctions_ended updates every 60s
  var RENDER_CAP = 100;

  var BUDGET_PRESETS = [
    { v: null, label: 'Any' },
    { v: 1e6, label: '1m' },
    { v: 5e6, label: '5m' },
    { v: 10e6, label: '10m' },
    { v: 25e6, label: '25m' },
    { v: 50e6, label: '50m' },
    { v: 100e6, label: '100m' },
    { v: 500e6, label: '500m' }
  ];

  var CATS = [
    { v: 'all', label: 'All' },
    { v: 'weapon', label: 'Weapons' },
    { v: 'armor', label: 'Armor' },
    { v: 'accessories', label: 'Accessories' },
    { v: 'pet', label: 'Pets' },
    { v: 'book', label: 'Books' },
    { v: 'other', label: 'Other' }
  ];

  var COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg>';

  var state = {
    flips: [],
    meta: null,
    budget: null,
    cat: 'all',
    search: '',
    sort: 'profit',
    minProfit: 100000,
    hideRisky: true,
    showAll: false,
    scanning: false,
    autoRescan: false
  };

  var els = {};
  ['scanPanel', 'scanLabel', 'scanFill', 'scanTrack', 'retryBtn', 'rescanBtn', 'dataAge',
   'stAuctions', 'stBins', 'stFlips', 'stBest',
   'budgetChips', 'budgetInput', 'budgetApply', 'planPanel',
   'searchInput', 'catChips', 'sortSel', 'minProfitSel', 'hideRisky',
   'lotsSel', 'minSupplySel', 'autoRescanChk',
   'resultCount', 'flipList', 'showMoreBtn', 'toast'
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  /* ---------- utils ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(n) {
    if (n == null || isNaN(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e9) return trim3(n / 1e9) + 'b';
    if (abs >= 1e6) return trim3(n / 1e6) + 'm';
    if (abs >= 1e3) return trim3(n / 1e3) + 'k';
    return String(Math.round(n));
  }
  function trim3(x) {
    var s = (Math.round(x * 100) / 100).toFixed(2);
    return s.replace(/\.?0+$/, '');
  }
  function fmtPct(x) { return Math.round(x * 100) + '%'; }

  function fmtRate(estDay) {
    if (estDay == null) return '—';
    if (estDay === 0) return '0/d';
    if (estDay < 1) return '<1/d';
    if (estDay < 10) return (Math.round(estDay * 10) / 10) + '/d';
    return Math.round(estDay) + '/d';
  }

  function parseCoins(str) {
    var raw = String(str).replace(/,(?=\d{3}(?:\D|$))/g, ''); // 1,500 / 1,500k = grouping
    var m = /^\s*(\d+(?:[.,]\d+)?)\s*([kmb])?\s*$/i.exec(raw);
    if (!m) return null;
    var num = parseFloat(m[1].replace(',', '.'));
    if (isNaN(num) || num <= 0) return null;
    var mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return Math.round(num * mult);
  }

  function rarKey(tier) {
    var t = String(tier || 'common').toLowerCase();
    var known = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'divine', 'special', 'very_special'];
    return known.indexOf(t) !== -1 ? t : 'common';
  }

  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('on'); }, 2200);
  }

  function copyText(text, doneMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* blocked */ }
      document.body.removeChild(ta);
      toast(ok ? doneMsg : 'Copy blocked — type: ' + text);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(doneMsg); }, fallback);
    } else fallback();
  }

  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* full/blocked — fine */ }
  }
  function lsDel(key) {
    try { localStorage.removeItem(key); } catch (e) { /* fine */ }
  }

  function validScan(c) {
    return !!(c && Array.isArray(c.flips) && c.meta &&
      typeof c.meta.scannedAt === 'number' && isFinite(c.meta.scannedAt) &&
      c.flips.every(function (f) {
        return f && Array.isArray(f.ladder) && typeof f.buy === 'number' &&
          typeof f.profit === 'number' && typeof f.roi === 'number' &&
          typeof f.risk === 'string' && typeof f.name === 'string' &&
          typeof f.supply === 'number';
      }));
  }

  /* ---------- filtering ---------- */

  function baseFiltered() {
    // everything except the budget cut — used for budget chip counts too
    var q = state.search.trim().toLowerCase();
    return state.flips.filter(function (f) {
      if (f.profit < state.minProfit) return false;
      if (state.hideRisky && f.risk === 'high') return false;
      if (state.cat !== 'all' && f.kind !== state.cat) return false;
      if (q && f.name.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function visibleFlips(base) {
    var list = state.budget == null ? base.slice() : base.filter(function (f) { return f.buy <= state.budget; });
    switch (state.sort) {
      case 'roi': list.sort(function (a, b) { return b.roi - a.roi; }); break;
      case 'cheap': list.sort(function (a, b) { return a.buy - b.buy; }); break;
      case 'supply': list.sort(function (a, b) { return b.supply - a.supply; }); break;
      case 'demand':
        list.sort(function (a, b) {
          var av = a.estDay == null ? -1 : a.estDay;
          var bv = b.estDay == null ? -1 : b.estDay;
          return bv - av || b.profit - a.profit;
        });
        break;
      default: list.sort(function (a, b) { return b.profit - a.profit; });
    }
    return list;
  }

  /* ---------- rendering ---------- */

  function render() {
    var base = baseFiltered();
    var visible = visibleFlips(base);
    renderStats(visible);
    renderBudgetChips(base);
    renderPlan(visible);
    renderList(visible);
  }

  /* Re-render but keep open rows open and put focus back where it was. */
  function renderPreserving() {
    var openKeys = [].map.call(document.querySelectorAll('#flipList details[open]'), function (d) {
      return d.getAttribute('data-k');
    });
    var focus = null, listFocus = null;
    var ae = document.activeElement;
    if (ae && ae.hasAttribute) {
      if (ae.hasAttribute('data-budget')) focus = '[data-budget="' + ae.getAttribute('data-budget') + '"]';
      else if (ae.hasAttribute('data-cat')) focus = '[data-cat="' + ae.getAttribute('data-cat') + '"]';
      else if (ae === els.flipList || els.flipList.contains(ae)) {
        var focRow = ae.closest && ae.closest('details[data-k]');
        listFocus = focRow ? {
          k: focRow.getAttribute('data-k'),
          sel: ae.classList.contains('copy') ? '.copy' : ae.classList.contains('copy-cmd') ? '.copy-cmd' : 'summary'
        } : { k: null };
      }
    }
    render();
    openKeys.forEach(function (k) {
      var d = document.querySelector('#flipList details[data-k="' + CSS.escape(k) + '"]');
      if (d) d.open = true;
    });
    if (focus) {
      var el = document.querySelector(focus);
      if (el) el.focus();
    } else if (listFocus) {
      var row = listFocus.k != null &&
        document.querySelector('#flipList details[data-k="' + CSS.escape(listFocus.k) + '"]');
      var target = row && row.querySelector(listFocus.sel);
      if (target) target.focus();
      else els.flipList.focus();
    }
  }

  function renderStats(visible) {
    var m = state.meta;
    els.stAuctions.textContent = m ? fmt(m.totalAuctions) : '—';
    els.stBins.textContent = m ? fmt(m.binCount) : '—';
    els.stFlips.textContent = m ? String(state.flips.length) : '—';
    var best = visible.length ? visible.reduce(function (a, b) { return a.profit >= b.profit ? a : b; }) : null;
    els.stBest.textContent = best ? '+' + fmt(best.profit) : '—';
  }

  function renderBudgetChips(base) {
    var html = BUDGET_PRESETS.map(function (p) {
      var count = p.v == null ? base.length : base.filter(function (f) { return f.buy <= p.v; }).length;
      var on = state.budget === p.v;
      return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-budget="' + (p.v == null ? '' : p.v) + '" aria-pressed="' + on + '">' +
        p.label + '<span class="n">' + count + '</span></button>';
    });
    var isPreset = BUDGET_PRESETS.some(function (p) { return p.v === state.budget; });
    if (!isPreset && state.budget != null) {
      html.push('<button type="button" class="chip on" data-budget="' + state.budget + '" aria-pressed="true">' +
        fmt(state.budget) + '<span class="n">custom</span></button>');
    }
    els.budgetChips.innerHTML = html.join('');
  }

  function renderPlan(visible) {
    if (state.budget == null) {
      els.planPanel.innerHTML = '<p class="plan-hint">Pick a budget above and Fliphouse builds a ready-made shopping list — the best set of flips your coins can cover.</p>';
      return;
    }
    var pool = visible.filter(function (f) {
      if (f.risk === 'high') return false;
      if (f.estDay != null && f.estDay < 1) return false; // slower than ~1 sale/day
      return true;
    }).slice().sort(function (a, b) { return b.profit - a.profit; });
    var left = state.budget, picks = [];
    for (var i = 0; i < pool.length && picks.length < 6; i++) {
      if (pool[i].buy <= left) { picks.push(pool[i]); left -= pool[i].buy; }
    }
    if (!picks.length) {
      els.planPanel.innerHTML = '<div class="plan-box"><h3>Shopping list · ' + fmt(state.budget) + ' budget</h3>' +
        '<p class="plan-hint">No safe flips fit this budget right now. Try a bigger budget, lower the min profit, or rescan.</p></div>';
      return;
    }
    var spend = 0, ret = 0;
    var rows = picks.map(function (f) {
      spend += f.buy; ret += f.profit;
      return '<div class="plan-row"><span class="pname ' + 'r-' + rarKey(f.tier) + '">' + esc(f.name) + '</span>' +
        '<span class="pnums">' + fmt(f.buy) + ' → <b>+' + fmt(f.profit) + '</b></span></div>';
    }).join('');
    els.planPanel.innerHTML = '<div class="plan-box"><h3>Shopping list · ' + fmt(state.budget) + ' budget</h3>' + rows +
      '<div class="plan-total"><span>Spend ' + fmt(spend) + ' · ' + fmt(state.budget - spend) + ' left</span>' +
      '<span class="ret">Est. return +' + fmt(ret) + ' (' + fmtPct(ret / spend) + ')</span></div>' +
      '<p class="plan-hint plan-foot">Skips risky flips and items with under ~1 observed sale a day.</p></div>';
  }

  function coverageNote() {
    var d = state.meta && state.meta.demand;
    if (!d || !d.tracking) return '';
    if (!d.coverageMs) return ' · demand data warming up';
    return ' · demand: ' + Math.round(d.coverageMs / 60000) + 'm of sales watched';
  }

  function renderList(visible) {
    var hiddenRisky = 0;
    if (state.hideRisky) {
      // count risky flips that would otherwise pass the current filters
      state.hideRisky = false;
      try { hiddenRisky = visibleFlips(baseFiltered()).length - visible.length; }
      finally { state.hideRisky = true; }
    }

    if (!state.meta) {
      els.resultCount.textContent = '';
      els.flipList.innerHTML = '<div class="empty"><b>Scanning the auction house…</b><br>First scan takes a few seconds — every BIN listing is checked.</div>';
      els.showMoreBtn.hidden = true;
      return;
    }
    if (!visible.length) {
      var d = state.meta.demand;
      var warming = d && d.tracking && d.coverageMs < 10 * 60000;
      els.resultCount.textContent = '0 flips match';
      els.flipList.innerHTML = '<div class="empty">' + (warming
        ? '<b>Verifying flips against real sales…</b><br>Every flip must be backed by prices buyers actually paid. Leave the tab open — sales are sampled every minute and verified flips appear as the data comes in.' +
          (hiddenRisky > 0 ? '<br>' + hiddenRisky + ' unverified flips are hidden — untick “Hide risky” to gamble on them.' : '')
        : '<b>No flips match these filters.</b><br>' +
          (hiddenRisky > 0 ? hiddenRisky + ' risky flips are hidden — untick “Hide risky” to see them. ' : '') +
          'Try a wider budget or a lower min profit.') + '</div>';
      els.showMoreBtn.hidden = true;
      return;
    }

    var cap = state.showAll ? visible.length : Math.min(RENDER_CAP, visible.length);
    var ageMins = Math.floor((Date.now() - state.meta.scannedAt) / 60000);
    els.resultCount.textContent =
      (ageMins >= 3 ? '⚠ Scan is ' + ageMins + 'm old — listings change every second, rescan before buying · ' : '') +
      'Showing ' + cap + ' of ' + visible.length + ' flips' +
      (hiddenRisky > 0 ? ' · ' + hiddenRisky + ' risky hidden' : '') + coverageNote();

    var html = [];
    for (var i = 0; i < cap; i++) html.push(rowHtml(visible[i]));
    els.flipList.innerHTML = html.join('');

    els.showMoreBtn.hidden = visible.length <= cap;
    els.showMoreBtn.textContent = 'Show all ' + visible.length;
  }

  function demandNote(f) {
    var d = state.meta && state.meta.demand;
    if (!d || !d.tracking) return 'Demand tracking needs a newer browser — sells/day unavailable.';
    if (f.estDay == null) {
      if (f.sold > 0) {
        return 'Seen <b>' + f.sold + ' sold</b> in ' + Math.round(d.coverageMs / 60000) + 'm of watching — a couple more and a sells/day rate kicks in.';
      }
      return 'No demand data on this item yet — keep the tab open, real sales are sampled every minute.';
    }
    var mins = Math.round(d.coverageMs / 60000);
    var s = 'Seen <b>' + f.sold + ' sold</b> in ' + mins + 'm of watching → est <b>' + fmtRate(f.estDay) + '</b> (≈' + fmt(Math.round(f.estDay * 7)) + '/week).';
    if (f.soldMedian != null) s += ' Buyers actually paid around <b>' + fmt(f.soldMedian) + '</b>.';
    if (f.weekAvg != null) s += ' 7-day average price <b>' + fmt(f.weekAvg) + '</b> across ' + f.weekN + ' sales.';
    return s;
  }

  function rowHtml(f) {
    var rk = rarKey(f.tier);
    var riskLabel = f.risk === 'low' ? 'solid' : f.risk === 'med' ? 'fair' : 'risky';
    var ladder = f.ladder.map(function (p, i) {
      return '<span class="lad' + (i === 0 ? ' snipe' : '') + '">' + fmt(p) + '</span>';
    }).join('');
    var cmd = '/viewauction ' + f.uuid;
    var relist = fmt(Math.max(f.sell - 1, f.buy));
    var lotTag = f.lot > 0 ? ' · lot ' + (f.lot + 1) : '';
    var basisNote = f.basis === 'median' ? 'the market median' : f.basis === 'sold' ? 'the recent sold price' : 'just under the next listing';
    return '<details class="row" data-k="' + esc(f.key) + '|' + f.lot + '">' +
      '<summary class="rgrid">' +
        '<div class="c-item">' +
          '<span class="chev" aria-hidden="true"></span>' +
          '<span class="rar-dot bg-' + rk + '"></span>' +
          '<div class="iw">' +
            '<span class="iname r-' + rk + '">' + esc(f.name) + '</span>' +
            '<span class="isub">' + esc(f.sub) + ' · ' + esc(String(f.tier).replace('_', ' ').toLowerCase()) + ' · ' + f.supply + ' alike' + lotTag + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="c num"><span class="cl">Buy now</span><span class="cv">' + fmt(f.buy) + '</span></div>' +
        '<div class="c num"><span class="cl">Sell at</span><span class="cv">' + fmt(f.sell) + '</span></div>' +
        '<div class="c num"><span class="cl">Profit</span><span class="cv profit">+' + fmt(f.profit) + '</span></div>' +
        '<div class="c num"><span class="cl">ROI</span><span class="cv roi">' + fmtPct(f.roi) + '</span></div>' +
        '<div class="c num"><span class="cl">Sells</span>' +
          (f.estDay == null ? '<span class="cv roi" role="img" aria-label="no data yet">—</span>'
            : '<span class="cv roi">' + fmtRate(f.estDay) + '</span><span class="cw">≈' + fmt(Math.round(f.estDay * 7)) + '/wk</span>') + '</div>' +
        '<div class="c"><span class="cl">Risk</span><span class="badge b-' + f.risk + '">' + riskLabel + '</span></div>' +
        '<div class="c act"><button type="button" class="copy" data-cmd="' + esc(cmd) + '" title="Copy ' + esc(cmd) + '" aria-label="Copy view-auction command for ' + esc(f.name) + '">' + COPY_ICON + '</button></div>' +
      '</summary>' +
      '<div class="det"><div class="det-grid">' +
        '<div class="det-block"><h4>Price ladder</h4><div class="ladder">' + ladder + '</div>' +
          '<p class="det-note">Your buy plus the ' + Math.min(f.supply - 1, 7) + ' cheapest <b>matching</b> listings — lore-checked so enchants, dyes and upgrades line up' +
            (f.groupSize > f.supply ? ' (' + (f.groupSize - f.supply) + ' same-name listings didn’t match and are ignored)' : '') +
            ' · matching median <b>' + fmt(f.median) + '</b>. You buy the gold one; the sell price is ' + basisNote + '.</p>' +
          '<p class="det-note">' + demandNote(f) + '</p>' +
          (f.why ? '<p class="det-note"><b>Why ' + riskLabel + ':</b> ' + esc(f.why) + '.</p>' : '') + '</div>' +
        '<div class="det-block"><h4>How to buy</h4>' +
          '<div class="cmd-row"><code class="cmd">' + esc(cmd) + '</code>' +
          '<button type="button" class="btn copy-cmd" data-cmd="' + esc(cmd) + '">Copy</button></div>' +
          '<p class="det-note">Paste in chat → buy for <b>' + fmt(f.buy) + '</b> → relist around <b>' + relist + '</b> → clear <b>+' + fmt(f.profit) + '</b> after the ' + (f.fee * 100) + '% tax. Check the lore and the live price in game first — new listings appear every second, so a cheaper copy may exist by now.</p></div>' +
      '</div></div>' +
    '</details>';
  }

  /* ---------- scan flow ---------- */

  var lastScanStep = -1;
  function setScanUi(mode, a, b) {
    els.scanPanel.hidden = false;
    els.retryBtn.hidden = true;
    els.scanLabel.classList.remove('err');
    els.scanTrack.hidden = false;
    if (mode === 'progress') {
      var pct = Math.round((a / Math.max(b, 1)) * 100);
      // the label is a live region — update it in coarse steps, not 46 times
      var step = Math.floor(pct / 25);
      if (step !== lastScanStep) {
        els.scanLabel.textContent = 'Scanning the auction house… ' + pct + '%';
        lastScanStep = step;
      }
      els.scanFill.style.width = pct + '%';
      els.scanTrack.setAttribute('aria-valuenow', String(pct));
    } else if (mode === 'done') {
      els.scanLabel.textContent = 'Scanned ' + fmt(a) + ' auctions · ' + b + ' flips found';
      els.scanFill.style.width = '100%';
      els.scanTrack.setAttribute('aria-valuenow', '100');
    } else if (mode === 'error') {
      els.scanLabel.textContent = 'Scan failed — ' + a + '. The Hypixel API may be busy.';
      els.scanLabel.classList.add('err');
      els.scanTrack.hidden = true;
      els.retryBtn.hidden = false;
      if (!state.meta) {
        els.flipList.innerHTML = '<div class="empty"><b>Couldn’t reach the auction house.</b><br>Use the retry button above once the API settles.</div>';
      }
    }
  }

  function adoptResult(result, preserve) {
    state.flips = result.flips;
    state.meta = result.meta;
    lsSet(LS_SCAN, { flips: result.flips, meta: result.meta });
    if (preserve) renderPreserving(); else { state.showAll = false; render(); }
    tickAge();
  }

  var scanFailedAt = 0;
  function startScan(auto) {
    if (state.scanning) return;
    // a failing API must not be hammered by the 65s poll fallback
    if (auto && Date.now() - scanFailedAt < 10 * 60000) return;
    state.scanning = true;
    lastScanStep = -1;
    els.rescanBtn.disabled = true;
    els.rescanBtn.textContent = 'Scanning…';
    setScanUi('progress', 0, 1);

    window.FlipEngine.scan(function (done, total) { setScanUi('progress', done, total); })
      .then(function (result) {
        // auto refreshes must not collapse open rows or steal focus
        adoptResult(result, !!auto);
        setScanUi('done', result.meta.totalAuctions, result.flips.length);
        pollSales(); // grab a demand window right away
      })
      .catch(function (e) {
        scanFailedAt = Date.now();
        setScanUi('error', (e && e.message) || 'network error');
      })
      .then(function () {
        state.scanning = false;
        els.rescanBtn.disabled = false;
        els.rescanBtn.textContent = 'Rescan';
      });
  }

  var polling = false;
  function pollSales() {
    if (polling || !window.FlipEngine.sales.enabled()) return;
    polling = true;
    window.FlipEngine.sales.poll()
      .then(function (changed) {
        if (changed) {
          var r = window.FlipEngine.rebuild();
          if (r) adoptResult(r, true);
          // cache-restored session: no groups in memory yet, so scan once
          else if (state.meta && !state.scanning) startScan(true);
        }
      })
      .then(function () { polling = false; }, function () { polling = false; });
  }

  var lastAgeText = '';
  function tickAge() {
    var text = '';
    if (state.meta) {
      var mins = Math.floor((Date.now() - state.meta.scannedAt) / 60000);
      if (!isFinite(mins) || mins < 0) mins = 0;
      text = mins < 1 ? 'data: live' : 'data: ' + mins + 'm old';
      els.dataAge.classList.toggle('warn', mins >= 10);
    }
    if (text !== lastAgeText) { els.dataAge.textContent = text; lastAgeText = text; }
  }

  /* ---------- events ---------- */

  function savePrefs() {
    var eng = window.FlipEngine.getOptions();
    lsSet(LS_PREFS, {
      budget: state.budget, cat: state.cat, sort: state.sort,
      minProfit: state.minProfit, hideRisky: state.hideRisky,
      basis: eng.basis, lots: eng.lots, minSupply: eng.minSupply,
      autoRescan: state.autoRescan
    });
  }

  function onFilterChange() {
    state.showAll = false;
    savePrefs();
    renderPreserving();
  }

  function onEngineOptionChange() {
    savePrefs();
    var r = window.FlipEngine.rebuild();
    if (r) adoptResult(r, true);
    else if (!state.scanning) startScan(true); // cache-only session — scan so the setting takes effect
    else renderPreserving();
  }

  els.rescanBtn.addEventListener('click', function () { startScan(false); });
  els.retryBtn.addEventListener('click', function () { startScan(false); });

  els.budgetChips.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-budget]');
    if (!chip) return;
    var v = chip.getAttribute('data-budget');
    state.budget = v === '' ? null : Number(v);
    els.budgetInput.value = '';
    onFilterChange();
  });

  function applyCustomBudget() {
    var v = parseCoins(els.budgetInput.value);
    if (v == null) { toast('Try a number like 25m, 750k or 1.5b'); return; }
    state.budget = v;
    onFilterChange();
    toast('Budget set to ' + fmt(v) + ' coins');
  }
  els.budgetApply.addEventListener('click', applyCustomBudget);
  els.budgetInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') applyCustomBudget(); });

  els.catChips.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-cat]');
    if (!chip) return;
    state.cat = chip.getAttribute('data-cat');
    renderCatChips();
    var again = document.querySelector('#catChips [data-cat="' + state.cat + '"]');
    if (again) again.focus();
    onFilterChange();
  });

  var searchTimer = null;
  els.searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.search = els.searchInput.value;
      state.showAll = false;
      render();
    }, 150);
  });

  els.sortSel.addEventListener('change', function () { state.sort = els.sortSel.value; onFilterChange(); });
  els.minProfitSel.addEventListener('change', function () { state.minProfit = Number(els.minProfitSel.value); onFilterChange(); });
  els.hideRisky.addEventListener('change', function () { state.hideRisky = els.hideRisky.checked; onFilterChange(); });

  els.showMoreBtn.addEventListener('click', function () {
    state.showAll = true;
    render();
    els.flipList.focus();
  });

  // settings
  [].forEach.call(document.querySelectorAll('input[name="basis"]'), function (radio) {
    radio.addEventListener('change', function () {
      if (radio.checked) { window.FlipEngine.setOptions({ basis: radio.value }); onEngineOptionChange(); }
    });
  });
  els.lotsSel.addEventListener('change', function () {
    window.FlipEngine.setOptions({ lots: Number(els.lotsSel.value) });
    onEngineOptionChange();
  });
  els.minSupplySel.addEventListener('change', function () {
    window.FlipEngine.setOptions({ minSupply: Number(els.minSupplySel.value) });
    onEngineOptionChange();
  });
  var rescanTimer = null;
  function applyAutoRescan() {
    clearInterval(rescanTimer);
    if (state.autoRescan) rescanTimer = setInterval(function () { startScan(true); }, RESCAN_MS);
  }
  els.autoRescanChk.addEventListener('change', function () {
    state.autoRescan = els.autoRescanChk.checked;
    savePrefs();
    applyAutoRescan();
    toast(state.autoRescan ? 'Auto-rescan on — every 2.5 min' : 'Auto-rescan off');
  });

  // one delegated handler for every copy button (summary buttons must not toggle the row)
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    copyText(btn.getAttribute('data-cmd'), 'Copied — paste in Minecraft chat');
  });

  function renderCatChips() {
    els.catChips.innerHTML = CATS.map(function (c) {
      var on = state.cat === c.v;
      return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-cat="' + c.v + '" aria-pressed="' + on + '">' + c.label + '</button>';
    }).join('');
  }

  /* ---------- init ---------- */

  var prefs = lsGet(LS_PREFS);
  if (prefs) {
    if (typeof prefs.budget === 'number' || prefs.budget === null) state.budget = prefs.budget;
    if (typeof prefs.cat === 'string') state.cat = prefs.cat;
    if (typeof prefs.sort === 'string') state.sort = prefs.sort;
    if (typeof prefs.minProfit === 'number') state.minProfit = prefs.minProfit;
    if (typeof prefs.hideRisky === 'boolean') state.hideRisky = prefs.hideRisky;
    if (typeof prefs.autoRescan === 'boolean') state.autoRescan = prefs.autoRescan;
    window.FlipEngine.setOptions({ basis: prefs.basis, lots: prefs.lots, minSupply: prefs.minSupply });
  }

  var eng = window.FlipEngine.getOptions();
  var basisRadio = document.querySelector('input[name="basis"][value="' + eng.basis + '"]');
  if (basisRadio) basisRadio.checked = true;
  els.lotsSel.value = String(eng.lots);
  els.minSupplySel.value = String(eng.minSupply);
  els.autoRescanChk.checked = state.autoRescan;
  els.sortSel.value = state.sort;
  if (!els.sortSel.value) { state.sort = 'profit'; els.sortSel.value = 'profit'; }
  els.minProfitSel.value = String(state.minProfit);
  if (!els.minProfitSel.value) { state.minProfit = 100000; els.minProfitSel.value = '100000'; }
  els.hideRisky.checked = state.hideRisky;

  renderCatChips();

  var cached = lsGet(LS_SCAN);
  if (validScan(cached)) {
    state.flips = cached.flips;
    state.meta = cached.meta;
    document.body.classList.add('has-data'); // returning visit: compact hero, data first
  } else if (cached) {
    lsDel(LS_SCAN); // stale shape from an older version — start clean
  }

  try { render(); } catch (e) {
    // a bad cache must never brick the page
    lsDel(LS_SCAN);
    state.flips = [];
    state.meta = null;
    render();
  }
  tickAge();
  setInterval(tickAge, 30000);
  setInterval(pollSales, SALES_MS);
  applyAutoRescan();

  // adopt the repo's continuously-collected sales table (hours of real sales)
  // BEFORE the first live poll, so the two never race each other
  var boot = window.FlipEngine.sales.bootstrap('data/sales.json').then(function (adopted) {
    if (!adopted) return;
    var r = window.FlipEngine.rebuild();
    if (r) adoptResult(r, true);
    else render();
  });

  if (!state.meta || Date.now() - state.meta.scannedAt > FRESH_MS) startScan();
  else boot.then(function () { pollSales(); });
})();
