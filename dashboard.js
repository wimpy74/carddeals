#!/usr/bin/env node
// Deal dashboard + market-watch tracker. No dependencies.
// Serves public/index.html, /data JSON, /thumb image proxy, fav/dismiss actions.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { getComps, closeBrowser } from "./lib/comps.js";
import { computeVerdict } from "./lib/verdict.js";
import { detectSlab } from "./lib/parse.js";
import { ximilarEnabled, identifyCard, idToTitle, spendToday } from "./lib/ximilar.js";
import { psaEnabled, lookupCert, certToTitle } from "./lib/psa.js";
import { cardhedgerEnabled, lookupByCert, callsToday as chCallsToday } from "./lib/cardhedger.js";
import { usdToEurRate } from "./lib/fx.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const EVALS_CSV = join(ROOT, "data", "evaluations.csv");
const FINDS_CSV = join(ROOT, "data", "finds.csv");
const MARKET_CSV = join(ROOT, "data", "market.csv");
const WATCH_CSV = join(ROOT, "data", "watchlist-hits.csv");
const LISTINGS_CSV = join(ROOT, "data", "listings.csv");
const UI_STATE = join(ROOT, "data", "ui-state.json");
const SCANNER_LOG = join(ROOT, "logs", "scanner.log");
const LOG = join(ROOT, "logs", "dashboard.log");

const log = (m) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

// ---------- CSV ----------
function parseCsv(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const rows = [];
  let field = "", row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; if (row.some((f) => f !== "")) rows.push(row); row = []; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f !== "")) rows.push(row); }
  if (rows.length < 1) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function loadUiState() {
  try { return JSON.parse(readFileSync(UI_STATE, "utf8")); } catch { return { favorites: {}, dismissed: {} }; }
}
function saveUiState(s) { writeFileSync(UI_STATE, JSON.stringify(s)); }

// ---------- market tracker (runs inside this service) ----------
const MARKET_HEADER = "ts,name,avg,median,min,max,n";
async function trackerTick() {
  for (const w of CONFIG.MARKET_WATCH) {
    try {
      const c = await getComps(w.title, null, { fresh: true });
      if (c.comp_median == null || !c.solds?.length) { log(`tracker ${w.name}: no data`); continue; }
      const prices = c.solds.map((s) => s.eur);
      const row = [
        new Date().toISOString(), w.name,
        Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
        c.comp_median, Math.min(...prices), Math.max(...prices), prices.length,
      ];
      if (!existsSync(MARKET_CSV)) appendFileSync(MARKET_CSV, MARKET_HEADER + "\n");
      appendFileSync(MARKET_CSV, row.join(",") + "\n");
      log(`tracker ${w.name}: median €${c.comp_median} n=${prices.length}`);
    } catch (e) {
      log(`tracker ERR ${w.name}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
  }
  await closeBrowser().catch(() => {});
}
setTimeout(trackerTick, 20 * 1000); // first tick shortly after boot
setInterval(trackerTick, CONFIG.TRACKER_INTERVAL_MIN * 60 * 1000);

// ---------- re-evaluation (Phase 4 paid/free ID escalation) ----------
const FINDS_HEADER = "ts,id,verdict,title,ask_eur,comp_median_eur,ratio,confidence,n_solds,grade,vinted_url,comp_url,thumb";
const EVALS_HEADER = "ts,id,verdict,title,ask_eur,comp_median_eur,ratio,confidence,vinted_url,thumb";
function csvEscape(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s; }
function appendCsv(file, header, row) {
  if (!existsSync(file)) appendFileSync(file, header + "\n");
  appendFileSync(file, row.map(csvEscape).join(",") + "\n");
}
function notify(title, body) {
  const esc = (s) => String(s).replaceAll("\\", "").replaceAll('"', "'");
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

async function reevaluate({ id, mode, cert }) {
  const evals = parseCsv(EVALS_CSV);
  const row = [...evals].reverse().find((e) => e.id === id);
  if (!row) return { error: `unknown item id ${id}` };
  const ask = parseFloat(row.ask_eur);

  let newTitle, source;
  if (mode === "cert") {
    // Cert lookup returns a valued card directly — no title parsing, no comp
    // scrape. Prefer Card Hedge (working) over the PSA API (not yet approved).
    if (cardhedgerEnabled()) {
      const c = await lookupByCert(cert);
      if (c.error) return c;
      const rate = await usdToEurRate();
      const eur = Math.round(c.price_usd * rate * 100) / 100;
      const v = computeVerdict(
        { comp_median: eur, confidence: c.confidence_grade === "A" ? "high" : "medium", parsed: { grader: c.grader, grade: c.grade } },
        ask, CONFIG
      );
      const ratio = v.ratio ? Math.round(v.ratio * 100) / 100 : "";
      const ts = new Date().toISOString();
      const label = `${row.title} ⟲ cert ${c.cert}: ${c.description ?? ""}`;
      appendCsv(EVALS_CSV, EVALS_HEADER, [ts, id, v.verdict, label, ask, eur, ratio, `cert-${c.confidence_grade ?? "?"}`, row.vinted_url, row.thumb]);
      if (["deal", "worklist", "offer", "suspect_ratio", "suspect_authenticity"].includes(v.verdict)) {
        appendCsv(FINDS_CSV, FINDS_HEADER, [ts, id, v.verdict, label, ask, eur, ratio, `cert-${c.confidence_grade ?? "?"}`,
          c.sample_count ?? "", `${c.grader} ${c.grade}`, row.vinted_url, "", row.thumb]);
      }
      if (v.verdict === "deal") notify(`Cert deal ${ratio}x — €${ask}`, `${c.description} | FMV €${eur}`);
      log(`reeval ${id} via cert ${c.cert}: ${c.description} → ${v.verdict} ratio=${ratio || "-"}`);
      dataCache.ts = 0;
      return {
        ok: true, verdict: v.verdict, new_title: `${c.description} · ${c.grade}`,
        comp_median: eur, ratio, confidence: `FMV grade ${c.confidence_grade}, ${c.sample_count} sales, ${c.freshness_days}d old`,
        range: c.low_usd ? `$${c.low_usd}–$${c.high_usd}` : null,
        population: c.population,
        source: `Card Hedge cert (${chCallsToday()} calls today)`,
      };
    }
    if (!psaEnabled()) return { error: "no CARDHEDGER_TOKEN or PSA_TOKEN in config.json" };
    const c = await lookupCert(cert);
    if (c.error) return c;
    newTitle = certToTitle(c);
    source = `psa cert ${c.cert}`;
  } else {
    if (!ximilarEnabled()) return { error: "no XIMILAR_TOKEN in config.json" };
    if (!row.thumb) return { error: "no photo stored for this listing" };
    const idres = await identifyCard(id, row.thumb);
    if (idres.error) return idres;
    newTitle = idToTitle(idres);
    source = `ximilar (${spendToday()} calls today)`;
  }

  const comp = await getComps(newTitle);
  const v = computeVerdict(comp, ask, CONFIG);
  if (v.transient) return { error: "comp source temporarily unavailable — try again in a few minutes" };
  const ratio = v.ratio ? Math.round(v.ratio * 100) / 100 : "";
  const ts = new Date().toISOString();

  appendCsv(EVALS_CSV, EVALS_HEADER, [ts, id, v.verdict, `${row.title} ⟲ ${newTitle}`, ask, comp.comp_median ?? "", ratio, comp.confidence ?? "", row.vinted_url, row.thumb]);
  if (["deal", "worklist", "offer", "suspect_ratio", "suspect_authenticity"].includes(v.verdict)) {
    appendCsv(FINDS_CSV, FINDS_HEADER, [
      ts, id, v.verdict, `${row.title} ⟲ ${newTitle}`, ask, comp.comp_median, ratio, comp.confidence,
      comp.n_solds, comp.parsed?.grader ? `${comp.parsed.grader} ${comp.parsed.grade}` : "raw",
      row.vinted_url, comp.sample_urls?.[0] ?? "", row.thumb,
    ]);
  }
  if (v.verdict === "deal") notify(`Re-eval deal ${ratio}x — €${ask}`, `${newTitle} | comp €${comp.comp_median}`);
  log(`reeval ${id} via ${source}: "${newTitle}" → ${v.verdict} ratio=${ratio || "-"}`);
  dataCache.ts = 0;
  return { ok: true, verdict: v.verdict, new_title: newTitle, comp_median: comp.comp_median, ratio, confidence: comp.confidence, source };
}

// ---------- /data ----------
let dataCache = { ts: 0, body: null };
function buildData() {
  if (Date.now() - dataCache.ts < 5000) return dataCache.body;
  const ui = loadUiState();
  const evals = parseCsv(EVALS_CSV);
  // dedupe by id keeping the latest row, so re-evaluations replace old verdicts
  const latestById = new Map();
  for (const f of parseCsv(FINDS_CSV)) latestById.set(f.id, f);
  const finds = [...latestById.values()]
    .filter((f) => !ui.dismissed[f.id])
    .map((f) => ({ ...f, fav: !!ui.favorites[f.id] }));

  const now = Date.now();
  const activity = Array.from({ length: 24 }, (_, i) => ({ h: i, n: 0 }));
  const verdicts = {};
  for (const e of evals) {
    verdicts[e.verdict] = (verdicts[e.verdict] || 0) + 1;
    const age = now - Date.parse(e.ts);
    if (age >= 0 && age < 24 * 3600 * 1000) {
      activity[23 - Math.floor(age / 3600 / 1000)].n++;
    }
  }
  const fee = CONFIG.EBAY_FEE_PCT;
  let profit = 0, nDeals = 0, nWork = 0, nSuspect = 0, nOffer = 0;
  for (const f of finds) {
    const net = parseFloat(f.comp_median_eur) * (1 - fee) - parseFloat(f.ask_eur);
    if (f.verdict === "deal") { nDeals++; profit += Math.max(0, net); }
    else if (f.verdict === "worklist") { nWork++; profit += Math.max(0, net); }
    else if (f.verdict === "offer") nOffer++; // negotiation targets — speculative, not in profit
    else nSuspect++; // suspect_* excluded from profit
  }
  const market = {};
  for (const r of parseCsv(MARKET_CSV)) {
    (market[r.name] ??= []).push({ ts: r.ts, avg: +r.avg, median: +r.median, min: +r.min, max: +r.max, n: +r.n });
  }
  for (const k of Object.keys(market)) market[k].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)); // backfill appends out of order
  const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
  const body = JSON.stringify({
    now,
    config: {
      alert: CONFIG.ALERT_RATIO, worklist: CONFIG.WORKLIST_RATIO, fee,
      // A cycle is the sleep plus however long the work takes; with photo-ID and
      // cert calls in the loop that can be 20min+. Derive the health threshold
      // from the configured interval so a slow-but-healthy cycle isn't flagged.
      scan_interval_min: CONFIG.SCAN_INTERVAL_MIN,
      tracker_interval_min: CONFIG.TRACKER_INTERVAL_MIN,
    },
    health: {
      scanner_age_s: mtime(SCANNER_LOG) ? Math.round((now - mtime(SCANNER_LOG)) / 1000) : null,
      tracker_age_s: mtime(MARKET_CSV) ? Math.round((now - mtime(MARKET_CSV)) / 1000) : null,
    },
    stats: { profit: Math.round(profit * 100) / 100, deals: nDeals, worklist: nWork, offers: nOffer, suspects: nSuspect, evaluated: evals.length },
    verdicts, activity,
    ticker: evals.slice(-30).reverse(),
    evals: (() => {
      const m = new Map(); // latest per id — re-evals replace originals
      for (const e of evals) m.set(e.id, e);
      return [...m.values()].slice(-200).reverse().map((e) => ({ ...e, vinted_url: e.vinted_url || `https://www.vinted.lt/items/${e.id}` }));
    })(),
    id_services: {
      ximilar: ximilarEnabled(), psa: psaEnabled(),
      cert: cardhedgerEnabled() || psaEnabled(),
      ximilar_calls_today: spendToday(), ximilar_cap: CONFIG.XIMILAR_DAILY_CAP,
      cardhedger_calls_today: chCallsToday(),
    },
    listings: (() => {
      const verdictById = new Map(evals.map((e) => [e.id, {
        verdict: e.verdict, comp: e.comp_median_eur, ratio: e.ratio,
        // the cert/photo-ID re-evaluations tag their title; surface it as a flag
        via_cert: /⟲ cert/.test(e.title), resolved_as: /⟲/.test(e.title) ? e.title.split("⟲")[1].trim() : null,
      }]));
      const watchById = new Map(parseCsv(WATCH_CSV).map((w) => [w.id, w.watch_name]));
      const maxId = Math.max(0, ...parseCsv(LISTINGS_CSV).map((l) => Number(l.id) || 0));
      return parseCsv(LISTINGS_CSV)
        .filter((l) => !ui.dismissed[l.id])
        .map((l) => {
          const slab = detectSlab(l.title);
          return {
            ...l,
            ...(verdictById.get(l.id) ?? {}),
            watch: watchById.get(l.id) ?? null,
            fav: !!ui.favorites[l.id],
            slab: slab ? `${slab.grader === "UNKNOWN" ? "" : slab.grader + " "}${slab.grade}`.trim() : null,
          };
        })
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, 600);
    })(),
    watchlist: parseCsv(WATCH_CSV).filter((w) => !ui.dismissed[w.id]).reverse().slice(0, 100),
    watch_config: { names: (CONFIG.WATCHLIST ?? []).map((w) => w.name), min: CONFIG.WATCHLIST_MIN_EUR },
    finds: finds.reverse(),
    market,
  });
  dataCache = { ts: Date.now(), body };
  return body;
}

// ---------- thumb proxy ----------
const THUMB_HOSTS = [".vinted.net", ".vinted.lt", ".pricecharting.com", ".ebayimg.com", ".sportscardspro.com"];
async function thumb(req, res, u) {
  try {
    const url = new URL(u);
    if (!["https:"].includes(url.protocol) || !THUMB_HOSTS.some((h) => url.hostname.endsWith(h))) {
      res.writeHead(403); res.end("host not allowed"); return;
    }
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) { res.writeHead(502); res.end(); return; }
    res.writeHead(200, { "content-type": r.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=86400" });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch { res.writeHead(500); res.end(); }
}

// ---------- server ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(ROOT, "public", "index.html")));
  } else if (url.pathname === "/data") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(buildData());
  } else if (url.pathname === "/thumb") {
    await thumb(req, res, url.searchParams.get("u") || "");
  } else if (url.pathname === "/reeval" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const result = await reevaluate(JSON.parse(body));
        res.writeHead(result.error ? 422 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (url.pathname === "/action" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { op, id } = JSON.parse(body);
        const ui = loadUiState();
        if (op === "fav") ui.favorites[id] ? delete ui.favorites[id] : (ui.favorites[id] = Date.now());
        else if (op === "dismiss") ui.dismissed[id] = Date.now();
        saveUiState(ui);
        dataCache.ts = 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
    });
  } else {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(CONFIG.DASHBOARD_PORT, "0.0.0.0", () => {
  log(`dashboard listening on 0.0.0.0:${CONFIG.DASHBOARD_PORT}`);
  console.log(`dashboard: http://localhost:${CONFIG.DASHBOARD_PORT}`);
});
