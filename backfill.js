#!/usr/bin/env node
// One-shot, idempotent: reconstruct daily market history for each MARKET_WATCH
// entry from SCP's recent-sales table (30 sales span weeks), grouped by sale date.
// Existing (ts,name) days in market.csv are never duplicated.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTitle } from "./lib/parse.js";
import { buildQuery } from "./lib/comps.js";
import { searchProducts, scoreRow, gradeColumn, productComps, closeBrowser } from "./lib/scp.js";
import { usdToEurRate } from "./lib/fx.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const MARKET_CSV = join(ROOT, "data", "market.csv");
const HEADER = "ts,name,avg,median,min,max,n";

const existing = new Set();
if (existsSync(MARKET_CSV)) {
  for (const line of readFileSync(MARKET_CSV, "utf8").split("\n").slice(1)) {
    const [ts, name] = line.split(",");
    if (ts) existing.add(ts.slice(0, 10) + "|" + name);
  }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const rate = await usdToEurRate();
let wrote = 0;

for (const w of CONFIG.MARKET_WATCH) {
  try {
    const parsed = parseTitle(w.title);
    const query = buildQuery(parsed);
    const { col } = gradeColumn(parsed);
    let rows = [], pc = null;
    for (let attempt = 0; attempt < 2 && !pc?.sales30?.length; attempt++) {
      rows = (await searchProducts(query)).map((r) => ({ ...r, score: scoreRow(parsed, r) })).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
      if (rows.length) pc = await productComps(rows[0].url, col);
    }
    if (!rows.length) { console.log(`backfill ${w.name}: no product match`); continue; }
    const byDay = {};
    for (const s of pc.sales30 ?? pc.sales) (byDay[s.date] ??= []).push(s.priceUsd * rate);
    const days = Object.keys(byDay).sort();
    for (const day of days) {
      if (existing.has(day + "|" + w.name)) continue;
      const p = byDay[day];
      const row = [
        day + "T12:00:00.000Z", w.name,
        Math.round((p.reduce((a, b) => a + b, 0) / p.length) * 100) / 100,
        Math.round(median(p) * 100) / 100,
        Math.round(Math.min(...p) * 100) / 100,
        Math.round(Math.max(...p) * 100) / 100,
        p.length,
      ];
      if (!existsSync(MARKET_CSV)) appendFileSync(MARKET_CSV, HEADER + "\n");
      appendFileSync(MARKET_CSV, row.join(",") + "\n");
      wrote++;
    }
    console.log(`backfill ${w.name}: ${days.length} days seen, wrote new rows`);
  } catch (e) {
    console.log(`backfill ${w.name}: ERR ${e.message}`);
  }
}
console.log(`backfill done — ${wrote} rows appended`);
await closeBrowser();
