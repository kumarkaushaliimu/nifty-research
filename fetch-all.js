/**
 * NIFTY 500 research pipeline
 *  - NSE official constituents
 *  - Yahoo Finance: quotes, 2y prices, cash/debt
 *  - Screener.in: 10y P&L, balance sheet, cash flow, ratios, 3/5y CAGRs
 * Output: data500.json (scored fundamentals + technicals)
 *
 * Usage: node fetch-all.js [--limit=10] [--refresh]
 */
const fs = require('fs');
const cheerio = require('cheerio');

const args = process.argv.slice(2);
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10);
const REFRESH = args.includes('--refresh');
const INDEX = (args.find(a => a.startsWith('--index=')) || '').split('=')[1] || '500'; // 200 or 500
const TITLE = 'NIFTY ' + INDEX;
const BENCH = TITLE;
const CSV_FILE = INDEX === '200' ? 'ind_nifty200list.csv' : 'ind_nifty500list.csv';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const YH = { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' };
const SC = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  let s = String(v).trim();
  // Extract from Yahoo finance object
  if (s === '[object Object]') return null;
  // Remove currency symbols, commas, unit text and whitespace — but KEEP decimal points
  s = s.replace(/Cr\.?/gi, '').replace(/Lakh/gi, '').replace(/[₹$€£]/g, '')
       .replace(/,/g, '').replace(/[\s%]/g, '').trim();
  if (!s || s === '-' || s === '—' || s === '--') return null;
  // Strip stray leading/trailing dots that aren't part of a decimal number
  s = s.replace(/^\.+$/, '').replace(/\.$/, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
};
const raw = v => num(v) ?? num(v && v.raw);

/* ---------------- cache ---------------- */
function loadCache(file) {
  const map = new Map();
  if (REFRESH || !fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); map.set(o.s, o.v); } catch {}
  }
  return map;
}
function appendCache(file, sym, v) {
  fs.appendFileSync(file, JSON.stringify({ s: sym, v }) + '\n');
}
for (const f of ['cache-tech.jsonl', 'cache-fund.jsonl', 'cache-fin.jsonl']) {
  if (REFRESH && fs.existsSync(f)) fs.unlinkSync(f);
}
const techCache = loadCache('cache-tech.jsonl');
const fundCache = loadCache('cache-fund.jsonl');
const finCache = loadCache('cache-fin.jsonl');

/* ---------------- http ---------------- */
let session = null;
async function yahooSession() {
  const r1 = await fetch('https://fc.yahoo.com', { headers: YH });
  const cookie = r1.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...YH, Cookie: cookie } });
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.length > 20) throw new Error('Yahoo crumb failed');
  session = { cookie, crumb };
}

async function getJson(url, tries = 4) {
  for (let t = 1; t <= tries; t++) {
    try {
      const r = await fetch(url, { headers: { ...YH, Cookie: session.cookie } });
      if (r.status === 200) return await r.json();
      if (r.status === 404) return null;
      if (r.status === 401) { await yahooSession(); continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(800 * t); continue; }
      return null;
    } catch {
      if (t === tries) return null;
      await sleep(500 * t);
    }
  }
  return null;
}

async function getHtml(url, tries = 3) {
  for (let t = 1; t <= tries; t++) {
    try {
      const r = await fetch(url, { headers: SC, redirect: 'follow' });
      if (r.status === 200) return await r.text();
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500 || r.status === 403) {
        if (t === tries) return null;
        await sleep(3000 * t); // long backoff so we don't stay in the 429 storm
        continue;
      }
      return null;
    } catch (e) {
      if (t === tries) return null;
      await sleep(1500 * t);
    }
  }
  return null;
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/* ---------------- technical indicators ---------------- */
function sma(arr, p) {
  if (arr.length < p) return null;
  return arr.slice(-p).reduce((a, b) => a + b, 0) / p;
}
function emaSeries(vals, p) {
  if (vals.length < p) return [];
  const k = 2 / (p + 1);
  const out = new Array(vals.length).fill(null);
  let e = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = e;
  for (let i = p; i < vals.length; i++) {
    e = vals[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}
function rsiSeries(closes, p = 14) {
  if (closes.length < p + 1) return [];
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  let ag = g / p, al = l / p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function adxLast(highs, lows, closes, p = 14) {
  const n = closes.length;
  if (n < p * 2 + 2) return null;
  const tr = [], pdm = [], ndm = [];
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr = 0, sp = 0, sn = 0;
  for (let i = 0; i < p; i++) { atr += tr[i]; sp += pdm[i]; sn += ndm[i]; }
  const dx = [];
  const pushDx = () => {
    const pdi = 100 * sp / (atr || 1);
    const ndi = 100 * sn / (atr || 1);
    dx.push(100 * Math.abs(pdi - ndi) / ((pdi + ndi) || 1));
  };
  pushDx();
  for (let i = p; i < tr.length; i++) {
    atr = atr - atr / p + tr[i];
    sp = sp - sp / p + pdm[i];
    sn = sn - sn / p + ndm[i];
    pushDx();
  }
  if (dx.length < p) return null;
  let adx = dx.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p;
  return adx;
}

function buildTech(sym, chart, indexReturns) {
  const res = chart?.chart?.result?.[0];
  if (!res) return null;
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] != null && q.high?.[i] != null && q.low?.[i] != null) {
      rows.push({ c: q.close[i], h: q.high[i], l: q.low[i], v: q.volume?.[i] || 0 });
    }
  }
  if (rows.length < 30) return null;
  const closes = rows.map(r => r.c), highs = rows.map(r => r.h), lows = rows.map(r => r.l), vols = rows.map(r => r.v);
  const n = closes.length;
  const price = closes[n - 1];
  const e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50), e200 = emaSeries(closes, 200);
  const ema20 = e20[n - 1] ?? null, ema50 = e50[n - 1] ?? null, ema200 = e200[n - 1] ?? null;
  const ema200Prev = n > 21 && e200[n - 21] != null ? e200[n - 21] : null;
  const rsi = rsiSeries(closes, 14)[n - 1] ?? null;
  const adx = adxLast(highs, lows, closes, 14);
  const ret = bars => {
    const j = n - 1 - bars;
    return j >= 0 && closes[j] ? (price / closes[j] - 1) * 100 : null;
  };
  const ret1m = ret(21), ret3m = ret(63), ret6m = ret(126), ret1y = ret(252);
  const high52 = Math.max(...highs.slice(-252));
  const low52 = Math.min(...lows.slice(-252));
  const distHigh = high52 ? (price / high52 - 1) * 100 : null;
  const avgVol20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volAbove = vols[n - 1] > avgVol20;
  let breakoutVol = false;
  for (let i = Math.max(20, n - 15); i < n; i++) {
    const priorHigh = Math.max(...closes.slice(i - 20, i));
    const priorVol = vols.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
    if (closes[i] > priorHigh && vols[i] > priorVol * 1.5) { breakoutVol = true; break; }
  }
  const rel = (r, ir) => (r != null && ir != null) ? r - ir : null;

  // ---- ChatGPT-review additions: risk & volume metrics ----
  // ATR (14) and ATR%
  let atr = null, atrPct = null;
  if (n >= 15) {
    let sum = 0;
    for (let i = n - 14; i < n; i++) {
      sum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }
    atr = sum / 14;
    atrPct = price ? atr / price * 100 : null;
  }
  // Up-day vs down-day volume (last 20 sessions)
  let upVol = 0, dnVol = 0;
  for (let i = n - 20; i < n; i++) { if (closes[i] >= closes[i - 1]) upVol += vols[i]; else dnVol += vols[i]; }
  const updownVol = dnVol > 0 ? upVol / dnVol : (upVol > 0 ? 5 : null);
  // OBV slope (last 20 vs prior 20)
  let obv = 0, obvRecent = 0, obvPrior = 0;
  for (let i = 1; i < n; i++) {
    obv += closes[i] > closes[i - 1] ? vols[i] : (closes[i] < closes[i - 1] ? -vols[i] : 0);
    if (i >= n - 20) obvRecent = obv;
    if (i === n - 21) obvPrior = obv;
  }
  const obvRising = obvPrior != null ? obvRecent > obvPrior : null;
  // Volatility (annualised std of daily returns, 1Y) and max drawdown from 52W series
  const rets = [];
  for (let i = Math.max(1, n - 252); i < n; i++) rets.push(closes[i] / closes[i - 1] - 1);
  let volatility = null;
  if (rets.length > 20) {
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length);
    volatility = sd * Math.sqrt(252) * 100;
  }
  let maxDD = 0, peak = -Infinity;
  for (const c of closes.slice(-252)) { if (c > peak) peak = c; maxDD = Math.min(maxDD, (c / peak - 1) * 100); }
  const avgTradedValue = avgVol20 * price;
  // Distance from moving averages
  const distMA20 = ema20 ? (price / ema20 - 1) * 100 : null;
  const distMA50 = ema50 ? (price / ema50 - 1) * 100 : null;
  const distMA200 = ema200 ? (price / ema200 - 1) * 100 : null;

  // ---- Support / Resistance / Target (daily update) ----
  // Pivot points from the latest session's H/L/C (classic floor-trader pivots)
  const lastH = highs[n - 1], lastL = lows[n - 1], lastC = closes[n - 1];
  const pivot = (lastH + lastL + lastC) / 3;
  const pivotS1 = 2 * pivot - lastH, pivotR1 = 2 * pivot - lastL;
  const pivotS2 = pivot - (lastH - lastL), pivotR2 = pivot + (lastH - lastL);
  // Recent swing levels (fractal pivots over a 5-session window, last 120 sessions)
  const swingHighs = [], swingLows = [];
  for (let i = n - 120 + 5; i < n - 5; i++) {
    let isHi = true, isLo = true;
    for (let j = i - 5; j <= i + 5; j++) {
      if (j === i || j < 0 || j >= n) continue;
      if (highs[j] >= highs[i]) isHi = false;
      if (lows[j] <= lows[i]) isLo = false;
    }
    if (isHi) swingHighs.push(highs[i]);
    if (isLo) swingLows.push(lows[i]);
  }
  const near = (arr, v, below, exclude) => {
    const c = arr.filter(x => (below ? x <= v : x >= v) && (exclude == null || Math.abs(x - exclude) > 0.01))
                 .sort((a, b) => below ? b - a : a - b);
    return c.length ? c[0] : null;
  };
  const low20 = Math.min(...lows.slice(-20)), high20 = Math.max(...highs.slice(-20));
  const support1 = near(swingLows, price, true) ?? low20;
  const support2 = near(swingLows, support1 ?? price, true, support1) ?? Math.min(low20, ema50 ?? low20, ema200 ?? low20);
  const resistance1 = near(swingHighs, price, false) ?? high20;
  const resistance2 = near(swingHighs, resistance1 ?? price, false, resistance1) ?? high52;
  const targetPrice = resistance1 ?? high52;
  const upsidePct = price ? (targetPrice / price - 1) * 100 : null;

  return {
    price, ema20, ema50, ema200, ema200Prev, rsi, adx,
    ret1m, ret3m, ret6m, ret1y,
    rel1m: rel(ret1m, indexReturns.m1),
    rel3m: rel(ret3m, indexReturns.m3),
    rel6m: rel(ret6m, indexReturns.m6),
    high52, low52, distHigh, volAbove, breakoutVol, avgVol20,
    atr, atrPct, updownVol, obvRising, volatility, maxDD, avgTradedValue,
    distMA20, distMA50, distMA200,
    // Support / resistance / target (daily)
    pivot, pivotS1, pivotS2, pivotR1, pivotR2,
    support1, support2, resistance1, resistance2, targetPrice, upsidePct,
    spark: closes.slice(-60).map(v => Math.round(v * 100) / 100),
  };
}

/* ---------------- screener parsing ---------------- */
function parseScreener(html) {
  const $ = cheerio.load(html);
  const top = {}, topRaw = {};
  $('.company-ratios li').each((i, el) => {
    const n = $(el).find('.name').text().trim();
    // Try .number first, then fall back to whole value span
    const numEl = $(el).find('.number');
    const rawText = numEl.length ? numEl.first().text() : $(el).find('.value').text();
    if (n) { topRaw[n] = rawText.trim(); top[n] = num(rawText); }
  });
  const ranges = {};
  $('table.ranges-table').each((i, t) => {
    const title = $(t).find('th').first().text().trim();
    const o = {};
    $(t).find('tr').slice(1).each((j, tr) => {
      const c = $(tr).find('td');
      const k = $(c[0]).text().trim().replace(':', '');
      o[k] = num($(c[1]).text());
    });
    ranges[title] = o;
  });
  const table = sel => {
    const t = $(sel + ' table.data-table').first();
    if (!t.length) return null;
    const dates = [];
    t.find('thead th[data-date-key]').each((i, th) => dates.push($(th).attr('data-date-key')));
    const rows = {};
    t.find('tbody tr').each((i, tr) => {
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const label = $(tds[0]).text().replace(/\s+/g, ' ').replace(/[\s+]+$/, '').trim();
      const vals = [];
      tds.slice(1).each((j, td) => vals.push(num($(td).text())));
      if (label) rows[label] = vals;
    });
    return { dates, rows };
  };
  return {
    top, topRaw, ranges,
    q: table('#quarters'), pl: table('#profit-loss'),
    bs: table('#balance-sheet'), cf: table('#cash-flow'), rat: table('#ratios'),
  };
}

/* ---------------- fundamentals ---------------- */
function annualOnly(t) {
  if (!t) return null;
  const keep = t.dates.map((d, i) => d && d.endsWith('-03-31') ? i : -1).filter(i => i >= 0);
  const rows = {};
  for (const k of Object.keys(t.rows)) rows[k] = keep.map(i => t.rows[k][i] ?? null);
  return { dates: keep.map(i => t.dates[i]), rows };
}
function cagr(v0, v1, years) {
  if (v0 == null || v1 == null || v0 <= 0 || v1 <= 0 || years <= 0) return null;
  return (Math.pow(v1 / v0, 1 / years) - 1) * 100;
}
function pct(a, b) { return (a == null || b == null || b === 0) ? null : a / b * 100; }
function avg(a) { const v = a.filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; }

function deriveFund(rawS, yFin) {
  if (!rawS) return null;
  // Re-parse raw text values at derive time so cache stays correct across parser fixes
  const top = {};
  for (const [k, v] of Object.entries(rawS.topRaw || rawS.top || {})) top[k] = num(v);
  const { ranges, q: qRaw, pl: plRaw, bs: bsRaw, cf: cfRaw, rat: ratRaw } = rawS;
  // Screener.in suffixes some row labels with " + " (e.g. "Sales +", "Borrowings +").
  // Normalise at derive time so cached data from older parser versions still works.
  const norm = t => t ? { ...t, rows: Object.fromEntries(
    Object.entries(t.rows).map(([k, v]) => [k.replace(/[\s+]+$/, '').trim(), v])
  ) } : t;
  const q = norm(qRaw), pl = norm(plRaw), bs = norm(bsRaw), cf = norm(cfRaw), rat = norm(ratRaw);
  const plA = annualOnly(pl), bsA = annualOnly(bs), cfA = annualOnly(cf), ratA = annualOnly(rat);
  const dates = plA?.dates || [];
  const S = plA?.rows['Sales'] || [];
  const NP = plA?.rows['Net Profit'] || [];
  const EPS = plA?.rows['EPS in Rs'] || [];
  const OPM = plA?.rows['OPM %'] || [];
  const last = arr => arr && arr.length ? arr[arr.length - 1] : null;
  const n = S.length;

  // Try to get from screener.in ranges first, but prefer calculable values over nulls
  const cs = ranges['Compounded Sales Growth'] || {};
  const cp = ranges['Compounded Profit Growth'] || {};
  
  // Check if screener provides valid (non-null) CAGR values
  const rev3Raw = cs['3 Years'];
  const rev5Raw = cs['5 Years'];
  const np3Raw = cp['3 Years'];
  const np5Raw = cp['5 Years'];
  
  // Prefer screener.in values if available AND valid (>0 for growth, or <=-90 for decline), otherwise calculate from P&L
  const rev3 = (rev3Raw != null && rev3Raw !== undefined && ((rev3Raw > -90) || (n >= 4 && S[n - 4] != null))) 
    ? (rev3Raw != null ? rev3Raw : cagr(S[n - 4], S[n - 1], 3)) 
    : (n >= 4 ? cagr(S[n - 4], S[n - 1], 3) : null);
  const rev5 = (rev5Raw != null && rev5Raw !== undefined && ((rev5Raw > -90) || (n >= 6 && S[n - 6] != null))) 
    ? (rev5Raw != null ? rev5Raw : cagr(S[n - 6], S[n - 1], 5)) 
    : (n >= 6 ? cagr(S[n - 6], S[n - 1], 5) : null);
  const np3 = (np3Raw != null && np3Raw !== undefined && ((np3Raw > -90) || (n >= 4 && NP[n - 4] != null))) 
    ? (np3Raw != null ? np3Raw : cagr(NP[n - 4], NP[n - 1], 3)) 
    : (n >= 4 ? cagr(NP[n - 4], NP[n - 1], 3) : null);
  const np5 = (np5Raw != null && np5Raw !== undefined && ((np5Raw > -90) || (n >= 6 && NP[n - 6] != null))) 
    ? (np5Raw != null ? np5Raw : cagr(NP[n - 6], NP[n - 1], 5)) 
    : (n >= 6 ? cagr(NP[n - 6], NP[n - 1], 5) : null);
  const eps5 = n >= 6 ? cagr(EPS[n - 6], EPS[n - 1], 5) : (n >= 4 ? cagr(EPS[n - 4], EPS[n - 1], 3) : null);

  // quarterly YoY
  let qRevYoY = null, qNpYoY = null;
  if (q?.dates?.length >= 5) {
    const qd = q.dates, qs = q.rows['Sales'] || [], qn = q.rows['Net Profit'] || [];
    const lastDate = qd[qd.length - 1];
    const y = parseInt(lastDate.slice(0, 4), 10) - 1;
    let j = qd.findIndex(d => d && d.slice(0, 4) === String(y) && d.slice(5) === lastDate.slice(5));
    if (j < 0 && qd.length >= 5) j = qd.length - 5;
    if (j >= 0 && qs[j] != null && qn[j] != null) {
      const prevRev = Math.abs(qs[j]);
      const prevNp = Math.abs(qn[j]);
      // Handle potential negative values by using absolute value for comparison
      qRevYoY = prevRev > 0 ? (qs[qd.length - 1] - qs[j]) / prevRev * 100 : null;
      qNpYoY = prevNp > 0 ? (qn[qd.length - 1] - qn[j]) / prevNp * 100 : null;
    } else if (q?.dates?.length >= 4) {
      // Try simple sequential YoY if exact match not found
      const idx = qd.length - 1;
      const prevIdx = idx - 4;
      if (prevIdx >= 0 && qs[prevIdx] != null && qn[prevIdx] != null) {
        const prevRev = Math.abs(qs[prevIdx]);
        const prevNp = Math.abs(qn[prevIdx]);
        qRevYoY = prevRev > 0 ? (qs[idx] - qs[prevIdx]) / prevRev * 100 : null;
        qNpYoY = prevNp > 0 ? (qn[idx] - qn[prevIdx]) / prevNp * 100 : null;
      }
    }
  }

  const opmLast = last(OPM);
  const opmPrev3 = avg(OPM.slice(-4, -1));
  const npmSeries = S.map((s, i) => pct(NP[i], s));
  const npmLast = last(npmSeries);
  const npmPrev3 = avg(npmSeries.slice(-4, -1));

  const eqCap = last(bsA?.rows['Equity Capital'] || []);
  const reserves = last(bsA?.rows['Reserves'] || []);
  const equity = (eqCap != null || reserves != null) ? (eqCap || 0) + (reserves || 0) : null;
  const borrowings = last(bsA?.rows['Borrowings'] || []);
  const assets = last(bsA?.rows['Total Assets'] || []);
  const assetsPrev = bsA?.rows['Total Assets']?.[bsA.rows['Total Assets'].length - 2];
  const de = (equity && equity > 0 && borrowings != null) ? borrowings / equity : null;
  const roa = (NP[n - 1] != null && assets != null && assetsPrev != null && (assets + assetsPrev) > 0)
    ? NP[n - 1] / ((assets + assetsPrev) / 2) * 100 : null;

  const opProfit = last(plA?.rows['Operating Profit'] || []);
  const cash = raw(yFin?.totalCash);
  const debt = raw(yFin?.totalDebt) ?? (borrowings != null ? borrowings * 1e7 : null);
  const ebitdaAbs = opProfit != null ? opProfit * 1e7 : raw(yFin?.ebitda);
  const ndEbitda = (debt != null && ebitdaAbs != null && ebitdaAbs > 0)
    ? (debt - (cash || 0)) / ebitdaAbs : null;

  const debtSeries = bsA?.rows['Borrowings'] || [];
  const debt3 = debtSeries.length >= 4 ? debtSeries[debtSeries.length - 4] : null;
  const debtTrend = (borrowings != null && debt3 != null) ? borrowings <= debt3 * 1.05 : null;

  const cfo = cfA?.rows['Cash from Operating Activity'] || [];
  const fcf = cfA?.rows['Free Cash Flow'] || [];
  const cfo5 = cfo.slice(-5), fcf5 = fcf.slice(-5);
  const fcfPos5 = fcf5.filter(v => v != null && v > 0).length;
  const ocfPos5 = cfo5.filter(v => v != null && v > 0).length;
  const np5sum = NP.slice(-5).filter(v => v != null);
  const ocfNp = (cfo5.filter(v => v != null).length && np5sum.reduce((a, b) => a + b, 0) > 0)
    ? cfo5.filter(v => v != null).reduce((a, b) => a + b, 0) / np5sum.reduce((a, b) => a + b, 0) : null;
  const ocf3 = cfo.length >= 4 ? cfo[cfo.length - 4] : null;
  const ocfGrow = (last(cfo) != null && ocf3 != null) ? last(cfo) > ocf3 : null;

  const days = (name) => ratA?.rows[name] || [];
  const debtor = last(days('Debtor Days'));
  const inventory = last(days('Inventory Days'));
  const wcDays = last(days('Working Capital Days'));
  const d3 = arr => arr.length >= 4 ? arr[arr.length - 4] : null;
  const stable = (arr, tol = 1.1) => {
    const l = last(arr), p = d3(arr);
    return (l != null && p != null) ? l <= p * tol + 2 : null;
  };

  const roceSeries = days('ROCE %');
  const roce = top['ROCE'] ?? last(roceSeries);
  const roce3 = d3(roceSeries);
  const roceImproving = (roce != null && roce3 != null) ? roce > roce3 : null;
  const roe = top['ROE'] ?? pct(NP[n - 1], equity);

  // ---- ChatGPT-review additions ----
  // Quarterly earnings acceleration: YoY growth of the last 4 quarters, and the trend
  let qGrowth = [], qAccel = null, qLatestYoY = null;
  if (q?.dates?.length >= 5) {
    const qnp = q.rows['Net Profit'] || [];
    const L = qnp.length;
    for (let i = 4; i < L; i++) {
      const cur = qnp[i], prev = qnp[i - 4];
      if (cur != null && prev != null && Math.abs(prev) > 0) qGrowth.push((cur - prev) / Math.abs(prev) * 100);
    }
    qLatestYoY = qGrowth.length ? qGrowth[qGrowth.length - 1] : null;
    if (qGrowth.length >= 2) qAccel = qGrowth[qGrowth.length - 1] - qGrowth[0]; // >0 = accelerating
  }
  const avgROCE3 = (() => {
    const v = roceSeries.slice(-3).filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  })();
  // Incremental ROCE: change in operating profit / change in capital employed (rough proxy)
  let incRoce = null;
  const opSeries = plA?.rows['Operating Profit'] || [];
  if (opSeries.length >= 4 && equity != null) {
    const curr = last(eqCap) ?? 0, currRes = last(reserves) ?? 0;
    const eqSeries = bsA?.rows['Reserves'] || [];
    const prevRes = eqSeries.length >= 4 ? eqSeries[eqSeries.length - 4] : null;
    const dCap = (currRes - (prevRes ?? currRes)) + ((last(eqCap) ?? 0) - (eqCap ?? 0));
    const dOp = opSeries[opSeries.length - 1] - opSeries[opSeries.length - 4];
    if (dCap != null && dCap > 0 && dOp != null) incRoce = dOp / dCap * 100;
  }
  const currentAssets = last(bsA?.rows['Current Assets'] || []);
  const currentLiab = last(bsA?.rows['Current Liabilities'] || []);
  const currentRatio = (currentAssets != null && currentLiab != null && currentLiab > 0) ? currentAssets / currentLiab : null;
  const totalDebt = debt;
  const evEbitda = (top['Market Cap'] != null && ebitdaAbs != null && ebitdaAbs > 0)
    ? ((top['Market Cap'] * 1e7) + (totalDebt || 0) - (cash || 0)) / ebitdaAbs : null;
  const peg = (top['Stock P/E'] != null && np3 != null && np3 > 0) ? top['Stock P/E'] / np3 : null;
  // Latest annual YoY growth
  const revYoY = (S.length >= 2 && S[n - 2] > 0) ? (S[n - 1] - S[n - 2]) / S[n - 2] * 100 : null;
  const npYoY = (NP.length >= 2 && NP[n - 2] > 0) ? (NP[n - 1] - NP[n - 2]) / NP[n - 2] * 100 : null;

  return {
    marketCap: top['Market Cap'] != null ? top['Market Cap'] * 1e7 : null,
    pe: top['Stock P/E'], bookValue: top['Book Value'], divYield: top['Dividend Yield'],
    roce, roe, roa, de, ndEbitda,
    rev3, rev5, np3, np5, eps5, qRevYoY, qNpYoY,
    opm: opmLast, opmTrend: (opmLast != null && opmPrev3 != null) ? opmLast >= opmPrev3 - 1 : null,
    npm: npmLast, npmTrend: (npmLast != null && npmPrev3 != null) ? npmLast >= npmPrev3 - 0.5 : null,
    debtTrend, fcfPos5, ocfPos5, ocfNp, ocfGrow,
    debtorDays: debtor, inventoryDays: inventory, wcDays,
    debtorTrend: stable(days('Debtor Days')), invTrend: stable(days('Inventory Days')), wcTrend: stable(days('Working Capital Days')),
    roceImproving,
    // ChatGPT-review additions
    qGrowth, qAccel, qLatestYoY, avgROCE3, incRoce, currentRatio, evEbitda, peg, revYoY, npYoY,
    ebitdaAbs,
    latestQuarter: q?.dates?.[q.dates.length - 1] || null,
    latestAnnual: dates[dates.length - 1] || null,
    years: dates.length,
    sales: S, netProfit: NP, epsSeries: EPS, opmSeries: OPM,
    cfo: cfo, fcf: fcf,
  };
}

function fundChecks(f, sectorPe) {
  const c = [];
  const add = (id, cat, label, weight, value, pass, display) => c.push({ id, cat, label, weight, value, pass, display });
  const g = (v, d = 1) => v == null ? '—' : v.toFixed(d) + '%';
  add('rev3', 'Growth', 'Revenue CAGR (3Y) > 12%', 5, f.rev3, f.rev3 != null ? f.rev3 > 12 : null, g(f.rev3));
  add('rev5', 'Growth', 'Revenue CAGR (5Y) > 10%', 4, f.rev5, f.rev5 != null ? f.rev5 > 10 : null, g(f.rev5));
  add('np3', 'Growth', 'Net profit CAGR (3Y) > 15%', 5, f.np3, f.np3 != null ? f.np3 > 15 : null, g(f.np3));
  add('np5', 'Growth', 'Net profit CAGR (5Y) > 12%', 4, f.np5, f.np5 != null ? f.np5 > 12 : null, g(f.np5));
  add('eps5', 'Growth', 'EPS CAGR (5Y) > 12%', 3, f.eps5, f.eps5 != null ? f.eps5 > 12 : null, g(f.eps5));
  add('qrev', 'Growth', 'Quarterly revenue growth (YoY) positive', 2, f.qRevYoY, f.qRevYoY != null ? f.qRevYoY > 0 : null, g(f.qRevYoY));
  add('qnp', 'Growth', 'Quarterly net profit growth (YoY) positive', 2, f.qNpYoY, f.qNpYoY != null ? f.qNpYoY > 0 : null, g(f.qNpYoY));

  add('roce', 'Profitability', 'ROCE > 20%', 5, f.roce, f.roce != null ? f.roce > 20 : null, g(f.roce));
  add('roe', 'Profitability', 'ROE > 15%', 4, f.roe, f.roe != null ? f.roe > 15 : null, g(f.roe));
  add('roa', 'Profitability', 'ROA > 10%', 3, f.roa, f.roa != null ? f.roa > 10 : null, g(f.roa));
  add('opm', 'Profitability', 'Operating margin > 15%', 4, f.opm, f.opm != null ? f.opm > 15 : null, g(f.opm));
  add('npmTrend', 'Profitability', 'Net margin stable or improving', 3, null, f.npmTrend, f.npmTrend == null ? '—' : (f.npmTrend ? 'Stable / up' : 'Declining'));
  add('opmTrend', 'Profitability', 'EBITDA margin stable or improving', 3, null, f.opmTrend, f.opmTrend == null ? '—' : (f.opmTrend ? 'Stable / up' : 'Declining'));
  add('roceTrend', 'Profitability', 'Incremental ROCE improving', 3, null, f.roceImproving, f.roceImproving == null ? '—' : (f.roceImproving ? 'Improving' : 'Flat / down'));

  add('de', 'Financial strength', 'Debt / equity < 0.5x', 6, f.de, f.de != null ? f.de < 0.5 : null, f.de == null ? '—' : f.de.toFixed(2) + 'x');
  add('ndEbitda', 'Financial strength', 'Net debt / EBITDA < 1.5x', 5, f.ndEbitda, f.ndEbitda != null ? f.ndEbitda < 1.5 : null, f.ndEbitda == null ? '—' : f.ndEbitda.toFixed(2) + 'x');
  add('debtTrend', 'Financial strength', 'Borrowings stable or declining', 3, null, f.debtTrend, f.debtTrend == null ? '—' : (f.debtTrend ? 'Stable / down' : 'Rising'));
  add('fcf3', 'Financial strength', 'FCF positive in 3 of last 5 years', 3, f.fcfPos5, f.fcfPos5 >= 3, f.fcfPos5 + '/5');
  add('ocfPos', 'Financial strength', 'Operating cash flow positive most years', 3, f.ocfPos5, f.ocfPos5 >= 3, f.ocfPos5 + '/5');

  add('ocfNp', 'Cash quality', 'OCF / net profit > 0.8 (5Y)', 5, f.ocfNp, f.ocfNp != null ? f.ocfNp > 0.8 : null, f.ocfNp == null ? '—' : f.ocfNp.toFixed(2) + 'x');
  add('fcf5', 'Cash quality', 'FCF positive all 5 years', 3, f.fcfPos5, f.fcfPos5 >= 5, f.fcfPos5 + '/5');
  add('ocfGrow', 'Cash quality', 'Operating cash flow growing', 3, null, f.ocfGrow, f.ocfGrow == null ? '—' : (f.ocfGrow ? 'Growing' : 'Flat / down'));
  add('debtor', 'Cash quality', 'Receivable days stable or declining', 2, f.debtorDays, f.debtorTrend, f.debtorDays == null ? '—' : f.debtorDays.toFixed(0) + ' days');
  add('inv', 'Cash quality', 'Inventory days stable or declining', 1, f.inventoryDays, f.invTrend, f.inventoryDays == null ? '—' : f.inventoryDays.toFixed(0) + ' days');
  add('wc', 'Cash quality', 'Working capital days stable or declining', 1, f.wcDays, f.wcTrend, f.wcDays == null ? '—' : f.wcDays.toFixed(0) + ' days');

  let vRatio = null, vDisplay = '—';
  if (f.pe != null && f.pe > 0 && sectorPe != null) {
    vRatio = f.pe < sectorPe ? 1 : (f.pe < sectorPe * 1.2 ? 0.5 : 0);
    vDisplay = f.pe.toFixed(1) + 'x vs ' + sectorPe.toFixed(1) + 'x sector';
  } else if (f.pe != null && f.pe > 0) vDisplay = f.pe.toFixed(1) + 'x';
  c.push({ id: 'pe', cat: 'Valuation', label: 'P/E below sector median', weight: 15, value: f.pe, pass: vRatio == null ? null : vRatio >= 1, ratio: vRatio, display: vDisplay });

  for (const x of c) if (x.ratio == null && x.pass != null) x.ratio = x.pass ? 1 : 0;
  const avail = c.filter(x => x.ratio != null);
  const earned = avail.reduce((a, x) => a + x.weight * x.ratio, 0);
  const availW = avail.reduce((a, x) => a + x.weight, 0);
  const cats = {};
  for (const cat of ['Growth', 'Profitability', 'Financial strength', 'Cash quality', 'Valuation']) {
    const cc = c.filter(x => x.cat === cat && x.ratio != null);
    const w = cc.reduce((a, x) => a + x.weight, 0);
    const e = cc.reduce((a, x) => a + x.weight * x.ratio, 0);
    cats[cat] = { score: w ? e / w * 100 : null, earned: e, available: w };
  }
  return { checks: c, score: availW ? earned / availW * 100 : null, coverage: availW, cats };
}

function techChecks(t, bench) {
  bench = bench || 'NIFTY 500';
  const c = [];
  const add = (id, cat, label, weight, pass, display, ratio) => c.push({ id, cat, label, weight, pass, display, ratio: ratio ?? (pass == null ? null : (pass ? 1 : 0)) });
  const p = (v, d = 1) => v == null ? '—' : v.toFixed(d);
  add('above200', 'Long-term trend', 'Close above 200 EMA', 10, t.ema200 == null ? null : t.price > t.ema200, p(t.ema200));
  add('ema50_200', 'Long-term trend', '50 EMA above 200 EMA', 10, (t.ema50 == null || t.ema200 == null) ? null : t.ema50 > t.ema200, t.ema50 && t.ema200 ? p(t.ema50) + ' / ' + p(t.ema200) : '—');
  add('ema200Rise', 'Long-term trend', '200 EMA higher than 20 sessions ago', 5, (t.ema200 == null || t.ema200Prev == null) ? null : t.ema200 > t.ema200Prev, t.ema200Prev == null ? '—' : p(t.ema200Prev));
  add('ema20_50', 'Momentum', '20 EMA above 50 EMA', 5, (t.ema20 == null || t.ema50 == null) ? null : t.ema20 > t.ema50, t.ema20 && t.ema50 ? p(t.ema20) + ' / ' + p(t.ema50) : '—');
  let rsiRatio = null;
  if (t.rsi != null) rsiRatio = (t.rsi >= 55 && t.rsi <= 70) ? 1 : ((t.rsi >= 50 && t.rsi <= 75) ? 0.5 : 0);
  add('rsi', 'Momentum', 'RSI (14) between 55 and 70', 8, t.rsi == null ? null : (t.rsi >= 55 && t.rsi <= 70), p(t.rsi), rsiRatio);
  let adxRatio = null;
  if (t.adx != null) adxRatio = t.adx > 20 ? 1 : (t.adx > 15 ? 0.5 : 0);
  add('adx', 'Momentum', 'ADX (14) above 20', 7, t.adx == null ? null : t.adx > 20, p(t.adx), adxRatio);
  add('ret1m', 'Price performance', '1-month return positive', 4, t.ret1m == null ? null : t.ret1m > 0, p(t.ret1m) + '%');
  add('ret3m', 'Price performance', '3-month return positive', 6, t.ret3m == null ? null : t.ret3m > 0, p(t.ret3m) + '%');
  add('ret6m', 'Price performance', '6-month return positive', 5, t.ret6m == null ? null : t.ret6m > 0, p(t.ret6m) + '%');
  add('rel1m', 'Relative strength', '1-month return vs ' + bench + ' positive', 5, t.rel1m == null ? null : t.rel1m > 0, p(t.rel1m) + ' pp');
  add('rel3m', 'Relative strength', '3-month return vs ' + bench + ' positive', 15, t.rel3m == null ? null : t.rel3m > 0, p(t.rel3m) + ' pp');
  add('rel6m', 'Relative strength', '6-month return vs ' + bench + ' positive', 5, t.rel6m == null ? null : t.rel6m > 0, p(t.rel6m) + ' pp');
  add('vol', 'Volume', 'Volume above 20-day average', 5, t.volAbove, t.volAbove ? 'Yes' : 'No');
  add('breakout', 'Volume', 'Breakout day with >1.5x volume', 5, t.breakoutVol, t.breakoutVol ? 'Yes' : 'No');
  add('high52', '52W proximity', 'Within 10% of 52-week high', 5, t.distHigh == null ? null : t.distHigh >= -10, p(t.distHigh) + '%');

  const avail = c.filter(x => x.ratio != null);
  const earned = avail.reduce((a, x) => a + x.weight * x.ratio, 0);
  const availW = avail.reduce((a, x) => a + x.weight, 0);
  const cats = {};
  for (const cat of ['Long-term trend', 'Momentum', 'Price performance', 'Relative strength', 'Volume', '52W proximity']) {
    const cc = c.filter(x => x.cat === cat && x.ratio != null);
    const w = cc.reduce((a, x) => a + x.weight, 0);
    const e = cc.reduce((a, x) => a + x.weight * x.ratio, 0);
    cats[cat] = { score: w ? e / w * 100 : null, earned: e, available: w };
  }
  const condIds = ['above200', 'ema50_200', 'ema20_50', 'ema200Rise', 'rsi', 'adx', 'ret3m', 'rel3m', 'high52'];
  const conds = condIds.map(id => c.find(x => x.id === id)?.pass === true);
  const volPass = c.find(x => x.id === 'vol').pass || c.find(x => x.id === 'breakout').pass;
  conds.push(!!volPass);
  return { checks: c, score: availW ? earned / availW * 100 : null, coverage: availW, cats, conditions: conds.filter(Boolean).length };
}

/* ---------------- investment decision engine (ChatGPT review) ---------------- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pctRank = (arr, v) => {
  if (v == null || !arr.length) return null;
  const below = arr.filter(x => x != null && x < v).length;
  return Math.round(below / arr.length * 100);
};

function buildDecision(stocks, newsBySymbol) {
  // Universe-relative: RS Rating = percentile of 3M relative return vs benchmark
  const relArr = stocks.map(s => s.t?.rel3m).filter(v => v != null);
  // Sector strength
  const sectors = {};
  for (const s of stocks) (sectors[s.sector] ||= []).push(s);
  const sectorStats = {};
  for (const [sec, list] of Object.entries(sectors)) {
    const rets = list.map(s => s.t?.ret3m).filter(v => v != null).sort((a, b) => a - b);
    const above50 = list.filter(s => s.t?.ema50 != null && s.price > s.t.ema50).length;
    const above200 = list.filter(s => s.t?.ema200 != null && s.price > s.t.ema200).length;
    sectorStats[sec] = {
      ret3m: rets.length ? rets[rets.length >> 1] : null,
      breadth50: list.length ? above50 / list.length * 100 : null,
      breadth200: list.length ? above200 / list.length * 100 : null,
      count: list.length,
    };
  }

  for (const s of stocks) {
    const f = s.f || {}, t = s.t || {};
    // RS Rating across universe
    s.rsRating = pctRank(relArr, t.rel3m);
    s.sectorStrength = sectorStats[s.sector] || null;

    // ---- News score from per-stock headlines ----
    const n = newsBySymbol[s.symbol];
    let newsScore = 50, newsCount = 0, newsSummary = null;
    if (n && n.headlines?.length) {
      newsCount = n.headlines.length;
      const scored = n.headlines.filter(h => h.sentiment != null);
      if (scored.length) {
        const weighted = scored.reduce((a, h) => a + ((h.sentiment + 100) / 2) * (0.5 + h.materiality / 200), 0);
        const wsum = scored.reduce((a, h) => a + (0.5 + h.materiality / 200), 0);
        newsScore = wsum ? clamp(weighted / wsum, 0, 100) : 50;
      }
      newsSummary = n.headlines.slice(0, 3).map(h => ({ title: h.title, sentiment: h.sentiment, materiality: h.materiality, link: h.link, source: h.source }));
    }
    s.news = { score: Math.round(newsScore), count: newsCount, headlines: newsSummary || [] };

    // ---- Risk score (higher = lower risk) ----
    let risk = 100;
    if (t.volatility != null) risk -= clamp((t.volatility - 20) * 0.8, 0, 25);
    if (t.maxDD != null) risk -= clamp((-t.maxDD - 15) * 0.5, 0, 20);
    if (f.de != null) risk -= clamp((f.de - 0.3) * 25, 0, 20);
    if (f.ocfNp != null && f.ocfNp < 0.8) risk -= (0.8 - f.ocfNp) * 20;
    if (t.avgTradedValue != null && t.avgTradedValue < 5e7) risk -= 10;
    s.riskScore = Math.round(clamp(risk, 0, 100));

    // ---- Stage 1: eligibility hard checks ----
    const flags = [];
    if (f.ocfNp != null && f.ocfNp < 0.3) flags.push({ level: 'INVESTIGATE', label: 'Weak cash conversion', detail: 'OCF/PAT ' + f.ocfNp.toFixed(2) + 'x' });
    if (f.de != null && f.de > 1.5) flags.push({ level: 'REJECT', label: 'Excessive leverage', detail: 'D/E ' + f.de.toFixed(2) + 'x' });
    if (f.np3 != null && f.np3 < 0) flags.push({ level: 'REJECT', label: 'Earnings deterioration', detail: 'PAT CAGR ' + f.np3.toFixed(0) + '%' });
    if (f.pe != null && f.sectorPe != null && f.pe > f.sectorPe * 2) flags.push({ level: 'RESTRICT', label: 'Extreme valuation', detail: 'P/E ' + f.pe.toFixed(0) + 'x vs ' + f.sectorPe.toFixed(0) + 'x sector' });
    if (t.avgTradedValue != null && t.avgTradedValue < 1e7) flags.push({ level: 'REJECT', label: 'Insufficient liquidity', detail: '₹' + (t.avgTradedValue / 1e7).toFixed(1) + ' Cr avg' });
    if (!s.f) flags.push({ level: 'UNKNOWN', label: 'Incomplete fundamental data' });
    if (!s.t) flags.push({ level: 'UNKNOWN', label: 'Incomplete price history' });
    // No governance data available from our sources -> mark UNKNOWN honestly
    flags.push({ level: 'UNKNOWN', label: 'Governance / auditor checks', detail: 'Not covered by data sources' });
    const hasReject = flags.some(x => x.level === 'REJECT');
    const eligibility = hasReject ? 'REJECT' : (flags.some(x => x.level === 'INVESTIGATE' || x.level === 'RESTRICT') ? 'CAUTION' : (flags.some(x => x.level === 'UNKNOWN') ? 'REVIEW' : 'ELIGIBLE'));
    s.eligibility = { status: eligibility, flags };

    // ---- Stage 2: attractiveness composite (100 pts) ----
    const fScore = f.score ?? 0, tScore = t.score ?? 0;
    let valScore = 50;
    if (f.peg != null && f.peg > 0) valScore = clamp(120 - f.peg * 40, 0, 100);
    else if (f.pe != null && f.sectorPe != null) valScore = f.pe < f.sectorPe ? 75 : 40;
    const comp =
      fScore * 0.35 + tScore * 0.25 + newsScore * 0.15 + s.riskScore * 0.15 + valScore * 0.10;
    s.composite = Math.round(clamp(comp, 0, 100));
    s.compositeParts = {
      fundamental: Math.round(fScore * 0.35), technical: Math.round(tScore * 0.25),
      news: Math.round(newsScore * 0.15), risk: Math.round(s.riskScore * 0.15), valuation: Math.round(valScore * 0.10),
    };

    // Minimum conditions & classification
    let cls = s.composite >= 85 ? 'Strong Buy Candidate' : s.composite >= 75 ? 'Buy Candidate'
      : s.composite >= 65 ? 'Watchlist' : s.composite >= 50 ? 'Neutral' : 'Avoid';
    if (hasReject || fScore < 70) cls = 'Avoid';
    else {
      // RESTRICT / INVESTIGATE flags and weak technicals cap the classification at Watchlist
      const softFlag = flags.some(x => x.level === 'RESTRICT' || x.level === 'INVESTIGATE');
      if (softFlag && (cls === 'Strong Buy Candidate' || cls === 'Buy Candidate')) cls = 'Watchlist';
      if (tScore < 65 && (cls === 'Strong Buy Candidate' || cls === 'Buy Candidate')) cls = 'Watchlist';
    }
    s.classification = cls;

    // ---- Strategy buckets ----
    const strategies = [];
    if (fScore >= 80 && tScore >= 60 && f.np3 >= 15 && f.roce >= 18 && (f.peg == null || f.peg < 2)) strategies.push('Quality Growth');
    if (fScore >= 70 && tScore >= 80 && s.rsRating >= 80 && f.qAccel > 0) strategies.push('Growth Momentum');
    if (fScore >= 55 && (f.peg != null && f.peg < 1 || (f.pe != null && f.sectorPe != null && f.pe < f.sectorPe * 0.8)) && f.qAccel > 0 && (t.distMA200 ?? -100) > -5) strategies.push('Value + Turnaround');
    s.strategies = strategies;

    // ---- Thesis bullets (auto-generated from data) ----
    const thesis = [], risks = [];
    if (f.rev3 > 12) thesis.push('Revenue compounding at ' + f.rev3.toFixed(0) + '% (3Y CAGR)');
    if (f.qAccel > 0) thesis.push('Quarterly earnings accelerating (+' + f.qAccel.toFixed(0) + ' pp YoY trend)');
    if (f.roce > 18) thesis.push('ROCE ' + f.roce.toFixed(0) + '% — strong capital efficiency');
    if (f.ocfNp > 0.8) thesis.push('Cash conversion healthy (OCF/PAT ' + f.ocfNp.toFixed(2) + 'x)');
    if (s.rsRating >= 70) thesis.push('Top-' + (100 - s.rsRating) + '% relative strength vs universe');
    if (t.breakoutVol) thesis.push('Volume-confirmed breakout');
    if (newsScore > 60) thesis.push('Positive news tone (score ' + Math.round(newsScore) + ')');
    if (f.np3 < 0) risks.push('PAT CAGR negative (' + f.np3.toFixed(0) + '%)');
    if (f.de > 0.5) risks.push('Leverage elevated (D/E ' + f.de.toFixed(2) + 'x)');
    if (f.ocfNp != null && f.ocfNp < 0.8) risks.push('Cash conversion weak (OCF/PAT ' + f.ocfNp.toFixed(2) + 'x)');
    if (t.distHigh < -15) risks.push('Well below 52W high (' + t.distHigh.toFixed(0) + '%)');
    if (t.maxDD < -30) risks.push('High historical drawdown (' + t.maxDD.toFixed(0) + '%)');
    if (newsScore < 40 && newsCount) risks.push('Negative news tone');
    for (const fl of flags) if (fl.level === 'REJECT' || fl.level === 'INVESTIGATE') risks.push(fl.label);
    s.thesis = thesis; s.thesisRisks = risks;
  }
  return { sectorStats };
}

/* ---------------- main ---------------- */
(async () => {
  console.log('Fetching ' + TITLE + ' constituents...');
  const csv = await (await fetch('https://archives.nseindia.com/content/indices/' + CSV_FILE, { headers: { 'User-Agent': UA } })).text();
  const constituents = csv.trim().split(/\r?\n/).slice(1).map(line => {
    const m = line.match(/^(.*),([^,]*),([^,]*),([^,]*),([^,]*)$/);
    if (!m) return null;
    return { name: m[1].trim(), sector: m[2].trim(), symbol: m[3].trim(), isin: m[5].trim() };
  }).filter(Boolean);
  if (LIMIT) constituents.length = Math.min(LIMIT, constituents.length);
  console.log('Universe:', constituents.length);

  await yahooSession();

  // index history
  const idxChart = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/%5ECRSLDX?range=2y&interval=1d');
  const idxRes = idxChart?.chart?.result?.[0];
  const idxCloses = (idxRes?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  const ir = bars => idxCloses.length > bars ? (idxCloses[idxCloses.length - 1] / idxCloses[idxCloses.length - 1 - bars] - 1) * 100 : null;
  const indexReturns = { m1: ir(21), m3: ir(63), m6: ir(126), m12: ir(252) };
  const indexMeta = idxRes?.meta || {};

  // quotes
  const quoteMap = {};
  for (let i = 0; i < constituents.length; i += 40) {
    const batch = constituents.slice(i, i + 40);
    const syms = batch.map(c => encodeURIComponent(c.symbol) + '.NS').join(',');
    const j = await getJson('https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + syms + '&crumb=' + encodeURIComponent(session.crumb));
    for (const q of (j?.quoteResponse?.result || [])) {
      const sym = decodeURIComponent(q.symbol.replace(/\.NS$/, ''));
      quoteMap[sym] = q;
    }
    await sleep(200);
  }
  console.log('Quotes:', Object.keys(quoteMap).length);

  // charts
  console.log('Price history...');
  let done = 0;
  await pool(constituents.filter(c => !techCache.has(c.symbol)), 6, async (c) => {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(c.symbol) + '.NS?range=2y&interval=1d&includePrePost=false';
    const j = await getJson(url);
    const tech = j ? buildTech(c.symbol, j, indexReturns) : null;
    if (tech) { techCache.set(c.symbol, tech); appendCache('cache-tech.jsonl', c.symbol, tech); }
    done++;
    if (done % 50 === 0) console.log('  charts', done);
    await sleep(40);
  });

  // For NIFTY 200 there is no Yahoo index symbol — compute a cap-weighted synthetic benchmark
  // from the constituent returns, then recompute each stock's relative returns against it.
  let activeIndexReturns = indexReturns;
  if (INDEX === '200') {
    const fieldMap = { m1: 'ret1m', m3: 'ret3m', m6: 'ret6m', m12: 'ret1y' };
    const synth = {};
    for (const p of Object.keys(fieldMap)) {
      let numW = 0, denW = 0;
      for (const c of constituents) {
        const t = techCache.get(c.symbol);
        const r = t ? t[fieldMap[p]] ?? null : null;
        const mc = num(quoteMap[c.symbol]?.marketCap);
        if (r != null && mc != null && mc > 0) { numW += r * mc; denW += mc; }
      }
      synth[p] = denW ? numW / denW : indexReturns[p];
    }
    activeIndexReturns = synth;
    // Recompute relative returns stored in the tech cache objects for this universe
    for (const c of constituents) {
      const t = techCache.get(c.symbol);
      if (!t) continue;
      for (const [suffix, p] of [['1m', 'm1'], ['3m', 'm3'], ['6m', 'm6']]) {
        const r = t['ret' + suffix];
        t['rel' + suffix] = (r != null && synth[p] != null) ? r - synth[p] : null;
      }
    }
    console.log('  synthetic benchmark returns', JSON.stringify(synth));
  }

  // screener — sequential with delay; Screener.in rate-limits concurrent/rapid requests aggressively
  console.log('Fundamentals (Screener.in) — sequential with rate-limit protection...');
  const needFund = constituents.filter(c => !fundCache.has(c.symbol));
  done = 0;
  for (const c of needFund) {
    const url = 'https://www.screener.in/company/' + encodeURIComponent(c.symbol) + '/consolidated/';
    const html = await getHtml(url);
    if (html) {
      try {
        const parsed = parseScreener(html);
        if (parsed.top['Market Cap'] != null || parsed.top['Stock P/E'] != null) {
          fundCache.set(c.symbol, parsed);
          appendCache('cache-fund.jsonl', c.symbol, parsed);
        }
      } catch (e) { console.log('  parse fail', c.symbol, e.message); }
    }
    done++;
    if (done % 25 === 0) console.log('  fundamentals', done, '/', needFund.length);
    await sleep(420);
  }

  // yahoo cash/debt
  console.log('Cash & debt...');
  done = 0;
  await pool(constituents.filter(c => !finCache.has(c.symbol)), 5, async (c) => {
    const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(c.symbol) + '.NS?modules=financialData&crumb=' + encodeURIComponent(session.crumb);
    const j = await getJson(url);
    const f = j?.quoteSummary?.result?.[0]?.financialData;
    if (f) { finCache.set(c.symbol, f); appendCache('cache-fin.jsonl', c.symbol, f); }
    done++;
    if (done % 50 === 0) console.log('  cash/debt', done);
    await sleep(60);
  });

  // derive
  const funds = constituents.map(c => ({ c, f: fundCache.has(c.symbol) ? deriveFund(fundCache.get(c.symbol), finCache.get(c.symbol)) : null }));
  const sectorPE = {};
  const bySector = {};
  for (const { c, f } of funds) {
    if (f?.pe != null && f.pe > 0) (bySector[c.sector] ||= []).push(f.pe);
  }
  for (const [s, arr] of Object.entries(bySector)) {
    arr.sort((a, b) => a - b);
    sectorPE[s] = arr[arr.length >> 1];
  }

  const stocks = constituents.map((c, i) => {
    const q = quoteMap[c.symbol] || {};
    const fRaw = funds[i].f;
    const f = fRaw ? { ...fRaw, sectorPe: sectorPE[c.sector] ?? null } : null;
    const fs = f ? fundChecks(f, sectorPE[c.sector]) : null;
    const t = techCache.get(c.symbol) || null;
    const ts = t ? techChecks(t, BENCH) : null;
    const price = num(q.regularMarketPrice) ?? t?.price ?? null;
    return {
      symbol: c.symbol, name: c.name.replace(/\s+Ltd\.?$/, '').replace(/\s+Co\.?$/, '').trim(), fullName: c.name,
      sector: c.sector,
      price, changePct: num(q.regularMarketChangePercent),
      volume: num(q.regularMarketVolume) ?? null,
      avgVolume: num(q.averageDailyVolume3Month) ?? num(q.averageVolume) ?? null,
      turnover: (num(q.regularMarketVolume) != null && num(q.regularMarketPrice) != null)
        ? q.regularMarketVolume * q.regularMarketPrice : null,
      marketCap: num(q.marketCap) ?? f?.marketCap ?? null,
      pe: f?.pe ?? num(q.trailingPE), pb: num(q.priceToBook), divYield: f?.divYield ?? num(q.dividendYield),
      eps: num(q.epsTrailingTwelveMonths), bookValue: f?.bookValue ?? num(q.bookValue), beta: num(q.beta),
      f: f ? { ...fs, ...f, score: fs.score, coverage: fs.coverage } : null,
      t: t ? { ...ts, ...t } : null,
      spark: t?.spark || [],
    };
  });

  // Investment decision engine: RS rating, sector strength, eligibility, composite score
  let newsBySymbol = {};
  try { newsBySymbol = JSON.parse(fs.readFileSync('news.json', 'utf8')).stocks || {}; } catch {}
  const { sectorStats } = buildDecision(stocks, newsBySymbol);
  console.log('Decision engine:', stocks.filter(s => s.classification === 'Buy Candidate' || s.classification === 'Strong Buy Candidate').length, 'buy candidates |', stocks.filter(s => s.strategies?.length).length, 'strategy matches');

  const asOf = new Date(Math.max(...Object.values(quoteMap).map(q => q.regularMarketTime || 0).filter(Boolean)) * 1000);
  const out = {
    title: TITLE,
    sectorStats,
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    index: {
      symbol: INDEX === '200' ? 'SYNTHETIC' : (indexMeta.symbol || '^CRSLDX'),
      name: TITLE,
      price: indexMeta.regularMarketPrice ?? (idxCloses.at(-1) || null),
      changePct: indexMeta.regularMarketChangePercent ?? null,
      high52: indexMeta.fiftyTwoWeekHigh ?? (idxCloses.length ? Math.max(...idxCloses.slice(-252)) : null),
      low52: indexMeta.fiftyTwoWeekLow ?? (idxCloses.length ? Math.min(...idxCloses.slice(-252)) : null),
      ret1m: activeIndexReturns.m1, ret3m: activeIndexReturns.m3, ret6m: activeIndexReturns.m6, ret1y: activeIndexReturns.m12,
      spark: idxCloses.slice(-60),
    },
    stocks,
  };
  const outFile = 'data' + INDEX + '.json';
  fs.writeFileSync(outFile, JSON.stringify(out));
  const withF = stocks.filter(s => s.f?.score != null).length;
  const withT = stocks.filter(s => s.t?.score != null).length;
  console.log('Wrote ' + outFile + ':', stocks.length, 'stocks |', withF, 'fundamental', '|', withT, 'technical | as of', out.asOf);
  const missingF = stocks.filter(s => !s.f).map(s => s.symbol);
  if (missingF.length) console.log('Missing fundamentals:', missingF.join(', '));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
