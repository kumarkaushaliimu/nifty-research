/**
 * Fetch macro news for the dashboard.
 *  - Curated macro cards (RBI, Fed, Inflation, Elections, Govt policy, FII/FX)
 *  - Live headlines from Google News RSS per topic
 * Output: news.json
 */
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Curated macro context (updated from web research, refreshed via headlines below)
const MACRO = [
  {
    id: 'rbi', icon: '🏦', tag: 'Monetary policy', title: 'RBI hikes repo rate to 5.50%',
    date: 'Nov 2026', tone: 'negative',
    summary: 'The MPC voted unanimously to raise the policy repo rate by 25 bps to 5.50% (SDF 5.25%, MSF 5.75%) to contain inflation that has breached the upper tolerance band.',
    impact: 'Banking & NBFCs: margin pass-through helps lenders with sticky deposit costs; near-term pressure on rate-sensitive sectors — real estate, auto, infrastructure, and long-duration growth stocks.',
    sectors: ['Banks', 'NBFCs', 'Real Estate', 'Auto', 'Infrastructure'],
    query: 'RBI repo rate monetary policy',
  },
  {
    id: 'inflation', icon: '📈', tag: 'Inflation', title: 'CPI inflation jumps to 6.09% in October',
    date: 'Oct 2026', tone: 'negative',
    summary: 'Retail CPI rose to 6.09% from 5.54%, the 12th consecutive monthly increase, breaching the RBI’s 6% upper tolerance band. Food and fuel were the main drivers.',
    impact: 'High inflation limits RBI’s room for rate cuts and keeps borrowing costs elevated. Hits consumer discretionary and input-heavy manufacturers; favours firms with strong pricing power.',
    sectors: ['FMCG', 'Consumer Robustness', 'Cement', 'Metals'],
    query: 'India CPI inflation October 2026',
  },
  {
    id: 'fed', icon: '🇺🇸', tag: 'US Federal Reserve', title: 'Fed holds rates at 3.75%–4.00%',
    date: 'Oct–Nov 2026', tone: 'neutral',
    summary: 'The FOMC kept the federal funds target range unchanged at 3.75%–4.00% after a 25 bps hike in September. Markets price a hold or at most one cut in December.',
    impact: 'A higher-for-longer US rate keeps the rate differential in favour of the dollar, pressuring the rupee and limiting FII risk appetite. A dovish pivot would be a positive catalyst for Indian equities.',
    sectors: ['IT', 'Pharma', 'Export-oriented', 'REITs'],
    query: 'Federal Reserve FOMC interest rate decision',
  },
  {
    id: 'elections', icon: '🗳️', tag: 'Elections', title: 'State poll verdicts reshape regional policy',
    date: 'May 2026', tone: 'neutral',
    summary: 'West Bengal saw a record BJP win while Tamil Nadu’s TVK emerged as the largest party. State-level policy shifts influence local industry, infrastructure and welfare spending.',
    impact: 'Election outcomes drive state-specific sectors — infrastructure, road construction, power distribution and regional banks. Policy continuity affects industrial corridor investments.',
    sectors: ['Infrastructure', 'Construction', 'Power', 'Regional Banks'],
    query: 'India assembly election results 2026',
  },
  {
    id: 'gst', icon: '📋', tag: 'Government policy', title: 'Next-Gen GST reforms roll out from Nov 1',
    date: 'Nov 2026', tone: 'positive',
    summary: 'GST shifts to a "Trust First, Verify Later" regime with phased compliance reforms, faster refunds, higher prosecution threshold (₹1 Cr → ₹5 Cr) and lower penalties. Gross GST collections grew 11.6% YoY to ~₹12.46 lakh crore in H1.',
    impact: 'Easier compliance and faster refunds ease working capital for MSMEs and manufacturers. Boosts e-commerce, logistics, FMCG and formal-sector consumption.',
    sectors: ['E-commerce', 'Logistics', 'FMCG', 'MSME', 'Manufacturing'],
    query: 'GST council reforms India November 2026',
  },
  {
    id: 'fii', icon: '💰', tag: 'Capital flows', title: 'FIIs pour ~₹66,300 Cr into equities in November',
    date: 'Nov 2026', tone: 'positive',
    summary: 'Foreign investors net bought roughly ₹66,300 crore in the first seven sessions of November (full-month net ~₹1.01 lakh crore), driving benchmarks to nine-month highs. The rupee strengthened above 92.67/USD.',
    impact: 'Strong FII flows benefit large-cap, high-liquidity names and banking/IT heavyweights. A reversal would hit the same segments first. Rupee strength helps importers and hurts exporters’ rupee realisations.',
    sectors: ['Large Caps', 'Banking', 'IT', 'Imports'],
    query: 'FII inflows Indian equities November 2026 rupee',
  },
];

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, '');
}

async function fetchHeadlines(query, limit = 6) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=en-IN&gl=IN&ceid=IN:en';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map(m => {
      const b = m[1];
      const title = (b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const src = (b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || 'Google News';
      return { title: decode(title), link, source: decode(src), date: pub ? new Date(pub).toISOString() : null };
    });
    return items;
  } catch { return []; }
}

// ---- News sentiment & materiality scoring (heuristic, from headline text) ----
const POSITIVE = ['gain','rise','rises','jump','surge','soar','profit','growth','grow','win','wins','order','upgrade','beat','record','strong','high','surge','expansion','expands','bullish','outperform','buy','rally','boost','approval','launch','revenue','dividend','buyback'];
const NEGATIVE = ['fall','falls','drop','decline','loss','losses','crash','downgrade','miss','probe','fraud','resign','warning','cut','cuts','weak','sell','underperform','investigation','regulatory','penalty','fine','default','debt','concern','delay','slowdown','layoff','fraud','sebi','scam'];
const MATERIAL = { 'order':90,'acquisition':95,'merger':95,'result':90,'guidance':85,'regulatory':95,'sebi':95,'fraud':95,'resign':85,'downgrade':80,'upgrade':80,'buyback':70,'dividend':60,'expansion':70,'launch':60,'stake':70,'rating':65 };

function scoreHeadline(title) {
  const s = title.toLowerCase();
  const pos = POSITIVE.filter(w => s.includes(w)).length;
  const neg = NEGATIVE.filter(w => s.includes(w)).length;
  let sentiment = (pos - neg) / Math.max(1, pos + neg) * 100;
  // Negate when a negative context word dominates
  if (neg > pos) sentiment = -Math.abs(sentiment);
  let materiality = 45;
  for (const [k, v] of Object.entries(MATERIAL)) if (s.includes(k)) materiality = Math.max(materiality, v);
  let horizon = 'Medium term';
  if (s.includes('order') || s.includes('result')) horizon = 'Short term';
  if (s.includes('expansion') || s.includes('capex')) horizon = 'Long term';
  return { sentiment: Math.round(sentiment), materiality, horizon };
}

// Global & domestic factor cards (ChatGPT review section 3A/3B)
const FACTORS = [
  { id:'dxy', icon:'💵', tag:'Global factor', title:'US Dollar & USD/INR', tone:'neutral',
    summary:'A strong dollar and elevated USD/INR pressure import-dependent businesses and cap FII risk appetite, while a softer dollar helps IT/pharma exporters and emerging-market liquidity.',
    impact:'Track DXY and USD/INR together with FII flows. Falling crude + stable rupee is the most favourable combination for Indian equities.',
    sectors:['IT','Pharma','Oil & Gas','Airlines'] },
  { id:'commodities', icon:'🛢️', tag:'Global factor', title:'Crude, Gold & Copper', tone:'neutral',
    summary:'Crude affects airlines/paints/chemicals inversely to upstream oil; gold signals risk sentiment; copper is a bellwether for metals and industrial demand. China PMI influences metals and chemicals.',
    impact:'Avoid simplistic one-to-one mappings — verify whether a company actually benefits from lower input costs and whether savings are retained in margins.',
    sectors:['Oil & Gas','Airlines','Paints','Metals','Chemicals'] },
  { id:'domestic', icon:'🇮🇳', tag:'Domestic indicators', title:'PMI, GST, Credit & Capex', tone:'positive',
    summary:'Manufacturing/services PMI, GST collections, credit growth, government capex and IIP growth are leading indicators of sector earnings — often before quarterly results appear.',
    impact:' Rising GST and capex favour infrastructure, cement and capital goods; credit growth supports banks. Weak PMI signals caution for cyclicals.',
    sectors:['Infrastructure','Cement','Capital Goods','Banks'] },
];

(async () => {
  console.log('Fetching macro headlines...');
  for (const m of MACRO) {
    m.headlines = await fetchHeadlines(m.query);
    console.log(' ', m.id, m.headlines.length, 'headlines');
    await sleep(300);
  }
  for (const f of FACTORS) {
    f.headlines = await fetchHeadlines(f.title + ' India outlook', 4);
    await sleep(300);
  }

  // Per-stock company news (ChatGPT review: biggest gap)
  const stocks = [];
  try {
    const d = JSON.parse(fs.readFileSync('data200.json', 'utf8'));
    // Prioritise top 60 by fundamental+technical score to keep runtime reasonable
    stocks.push(...d.stocks.filter(s => s.f || s.t).sort((a,b) => ((b.f?.score||0)+(b.t?.score||0)) - ((a.f?.score||0)+(a.t?.score||0))).slice(0, 60));
    if (!stocks.length && d.stocks.length) stocks.push(...d.stocks.slice(0, 40));
  } catch {}

  const bySymbol = {};
  console.log('Fetching company-specific news for', stocks.length, 'stocks...');
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    const q = '"' + s.name + '" (' + s.symbol + ') NSE results order guidance';
    const headlines = await fetchHeadlines(q, 3).then(hs => hs.map(h => ({ ...h, ...scoreHeadline(h.title) })));
    bySymbol[s.symbol] = { headlines };
    if ((i + 1) % 10 === 0) console.log(' ', i + 1, '/', stocks.length);
    await sleep(220);
  }

  const out = { generatedAt: new Date().toISOString(), macro: MACRO, factors: FACTORS, stocks: bySymbol };
  fs.writeFileSync('news.json', JSON.stringify(out, null, 2));
  console.log('Wrote news.json with', Object.keys(bySymbol).length, 'stock news sets');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
