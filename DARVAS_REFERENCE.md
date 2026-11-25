# Darvas Box Strategy — Reference (from ChatGPT shared guide 2026-11-24)

## Core idea
Trend-following breakout system by Nicolas Darvas. Buy strength on consolidation breakouts, ride the trend with dynamic trailing stops using moving boxes. Four elements: strong stocks, consolidation/breakout, volume confirmation, dynamic stops.

## Box identification (chronological, no look-ahead)
1. Identify candidate high H.
2. Wait 3 completed candles. If any subsequent HIGH >= H → reject. Else confirm box top = H.
3. After top confirmation, identify candidate low L from subsequent action.
4. Wait 3 completed candles. If any subsequent LOW <= L → reject & re-identify. Else confirm box bottom = L.
5. Box = [L, H]. Top and bottom are NOT confirmed simultaneously — bottom comes after top.
6. Use completed candles only. Avoid repainting.

## Entry
- Daily CLOSE above confirmed box top (recommended over intraday).
- Volume >= 1.5x 20-day average.
- Prefer price above 50 & 200 DMA, near 52-week high.
- Nifty & sector not in severe downtrend.
- Avoid extended breakouts (don't chase gaps).

## Initial stop
- Below confirmed box bottom with volatility-appropriate buffer (e.g. box bottom − 2, or ATR-based).
- Skip if risk distance too large. Filter by max box height (test 10/12/15%).
- Position size: fixed % of capital at risk (e.g. 1%). Qty = (capital × risk%) / (entry − SL).

## Trailing stop (the key)
- Wait for next COMPLETE HIGHER box; confirm its top AND bottom.
- Only then move stop below the new bottom. Never lower the stop.
- Don't move stop just because price made a new high / new top identified — bottom must be confirmed.
- If a new box has a lower bottom than current SL, ignore it for trailing.
- Fast advance with no consolidation → ghost-box supplementary stop = recent swing high − previous box height (test separately).

## Exit
- Exit if active stop hit. Don't wait for a new box after breach.
- No averaging down, no widening stops, no arbitrary 5-10% profit exits.

## Lower boxes
- Lower top and bottom = weakening structure. Don't add, don't reduce stop, watch for stop trigger.

## Pyramiding (optional, disabled initially)
- Add only on new confirmed breakout AFTER existing position protected.
- Recalculate total combined position risk; keep within portfolio limit.

## States
BOX FORMING → BREAKOUT/HOLDING → STOP TRIGGERED

## Scanner fields
Active box top/bottom, formation date, status, previous box top/bottom, position, entry, initial SL, trailing SL, next breakout price, volume ratio, box height %.

## Recommended starting params (NSE)
Universe NIFTY 250; Daily; 3-session top & bottom confirmation; close > box top; 1.5x volume; above 50/200 DMA; positive 3M RS vs Nifty; max 1% risk; box height test 10/12/15%; SL = box bottom − buffer; trailing = latest confirmed higher box bottom − buffer; no profit target; no pyramiding initially.

## Backtests to run independently
A pure; B +volume; C +DMA; D +RS; E +ATR buffer; F +ghost box; G +pyramiding.
Compare net P&L, max DD, profit factor, win rate, avg win/loss, expectancy, holding period, MFE/MAE, trade count, regime performance. Use survivorship-bias-free universe, adjusted prices, next-session fills, realistic charges/slippage/gaps.

## Final principles
Use Darvas to identify/hold trends, not predict short-term moves. Never lower a stop, never average down, never let profit turn into uncontrolled loss.
