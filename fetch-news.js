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

async function fetchHeadlines(query) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=en-IN&gl=IN&ceid=IN:en';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map(m => {
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

(async () => {
  console.log('Fetching macro headlines...');
  for (const m of MACRO) {
    m.headlines = await fetchHeadlines(m.query);
    console.log(' ', m.id, m.headlines.length, 'headlines');
    await sleep(300);
  }
  const out = { generatedAt: new Date().toISOString(), macro: MACRO };
  fs.writeFileSync('news.json', JSON.stringify(out, null, 2));
  console.log('Wrote news.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
