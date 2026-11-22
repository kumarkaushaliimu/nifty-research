/**
 * Build dashboard.html by injecting data + news into dashboard-template.html.
 * The universe name in DATA.title replaces "NIFTY 500" throughout the page.
 * Usage: node build-dashboard.js [data-file] [output-file]
 */
const fs = require('fs');

const dataFile = process.argv[2] || 'data500.json';
const outFile = process.argv[3] || 'dashboard.html';

function readJson(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return JSON.stringify(fallback); }
}

const data = readJson(dataFile, { stocks: [], generatedAt: new Date().toISOString(), asOf: new Date().toISOString(), index: {}, title: 'NIFTY 500' });
const news = readJson('news.json', { generatedAt: new Date().toISOString(), macro: [] });
let html = fs.readFileSync('dashboard-template.html', 'utf8');

html = html.replace('__DATA_JSON__', data).replace('__NEWS_JSON__', news);

// Make the dashboard universe-agnostic: swap in DATA.title for the default label
let title = 'NIFTY 500';
try { title = JSON.parse(data).title || 'NIFTY 500'; } catch {}
if (title !== 'NIFTY 500') html = html.replace(/NIFTY 500/g, title);

fs.writeFileSync(outFile, html);
console.log(`Wrote ${outFile} (${(html.length / 1024).toFixed(0)} KB) — universe: ${title}, stocks: ${(JSON.parse(data).stocks || []).length}`);
