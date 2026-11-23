# NIFTY Research Dashboard

Scored fundamental + technical screening with a macro-news section mapping events to sector impact. Current build: **NIFTY 200**.

## Output
- `dashboard.html` — self-contained dashboard (open in any browser; data & news embedded, no server needed).

## Sections
0. **Market Today** — daily snapshot: index level, advancers/decliners, total volume & turnover, a **market-cap-sized heatmap** coloured by % change, and a sortable table of price, volume, avg volume, volume ratio, turnover and day range for every constituent. Searchable by name/symbol and filterable by sector, gainers/losers and high volume.
1. **Investment Decision** — a two-stage engine built from the ChatGPT review:
   - **Stage 1 – Eligibility** hard checks (excessive leverage, earnings deterioration, weak cash conversion, extreme valuation, illiquidity, governance UNKNOWN). A REJECT cannot be a Buy regardless of score.
   - **Stage 2 – Attractiveness** composite /100 = Fundamental 35 + Technical 25 + News 15 + Risk 15 + Valuation 10.
   - Classification: Strong Buy / Buy / Watchlist / Neutral / Avoid, with minimum conditions (Fundamental ≥70, Technical ≥65 for momentum).
   - Three strategies: **Quality Growth**, **Growth Momentum**, **Value + Turnaround**.
   - RS Rating (percentile vs universe), sector strength/breadth, per-stock news with sentiment/materiality scoring, and expandable research cards with thesis + invalidation risks.
1. **Fundamentals** — score /100 from the master checklist:
   - Growth (revenue/PAT/EPS CAGRs, quarterly YoY)
   - Profitability (ROCE, ROE, ROA, margins, incremental ROCE)
   - Financial strength (D/E, net debt/EBITDA, borrowings, FCF)
   - Cash flow quality (OCF/PAT, FCF, working-capital days)
   - Valuation (P/E vs sector median)
   - Click a row to expand every check with pass/fail, value and weight.
2. **Technicals** — 10-point screening checklist plus a weighted /100 score (trend 25, momentum 20, relative strength 25, price performance 15, volume 10, 52W proximity 5), sparklines, full indicator detail, and daily **support (S1/S2), resistance (R1/R2), target price and upside %** from swing pivots and 20-day highs/lows.
3. **Darvas Box** — Nicolas Darvas breakout method rebuilt daily: 20-session box top/bottom, volume-confirmed breakouts, old box top as support, box bottom as stop, and a measured-move target (box top + box height). Darvas score /100 from box structure (25), breakout+volume (25), holding support (20), trend (20) and risk/reward (10). Includes breakout filters and CSV export.
4. **Macro & News** — RBI, inflation, US Fed, elections, GST and FII cards with sector-impact notes and live Google News headlines.

Search on all stock tabs matches both company name and symbol (plus full legal name).

## Universe
- `npm run refresh` builds for **NIFTY 200** (default).
- `node fetch-all.js --index=500` builds the NIFTY 500 dataset (`data500.json`).
- `node build-dashboard.js data500.json dashboard.html` renders the 500-stock dashboard.
- There is no official NSE "NIFTY 250" list; if needed, use the top 250 NIFTY 500 names by market cap.

For NIFTY 200, Yahoo Finance has no index symbol, so relative returns are computed against a **cap-weighted synthetic benchmark** of the 200 constituents.

## Refresh
```bash
npm run refresh          # fetch stock data + news, rebuild dashboard (full)
npm run refresh:news     # just refresh headlines, rebuild (fast)
npm run build:only       # rebuild dashboard.html from cached data
```

Granular:
```bash
node fetch-all.js --index=200 [--limit=50] [--refresh]
node fetch-news.js
node build-dashboard.js data200.json dashboard.html
```

## Data sources
- **Constituents:** NSE official index CSV lists
- **Prices / indicators / market cap:** Yahoo Finance (NSE, delayed)
- **Fundamentals / CAGRs / ratios / cash flow:** Screener.in (consolidated)
- **Macro headlines / company news:** Google News RSS (with heuristic sentiment & materiality scoring)

## Caching & rate limits
- `cache-tech.jsonl`, `cache-fund.jsonl`, `cache-fin.jsonl` store per-symbol data (raw text kept for fundamentals so parser fixes need no re-fetch).
- Screener.in is fetched sequentially with ~420 ms delay; only missing symbols are fetched on repeat runs.

## Put it online

The dashboard is a single self-contained HTML file, so any static host works.

**Quickest — Netlify Drop:** go to <https://app.netlify.com/drop>, drag in `dashboard.html`, and you get a public URL instantly. Sign up for a free account to keep it permanently.

**Recommended — GitHub Pages with automatic daily refresh:**

1. Create a GitHub repository and push this folder to it (the included `.github/workflows/refresh.yml` handles the rest).
2. In the repo, go to **Settings → Pages → Build and deployment**, set **Source: Deploy from a branch**, choose the `gh-pages` branch, and save.
3. Your site will be live at `https://<username>.github.io/<repo-name>/`.

The workflow fetches fresh data and headlines every day at 06:30 IST, commits the updated data, and redeploys the site. You can also trigger it any time from the **Actions** tab → **Refresh dashboard data** → **Run workflow**.

> **Note on the "Refresh headlines" button:** on a static host it re-reads the deployed `news.json`; it cannot fetch fresh headlines by itself because static sites have no server-side code. Use the GitHub Action (or `npm run refresh:news` locally + push) for genuinely new headlines.

**Disclaimer:** For information and education only — not investment advice. Verify all figures with NSE / the company before acting.
