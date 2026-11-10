#!/usr/bin/env node
// Vinted deal scanner — long-running launchd service (or `--once` for one cycle).
// Notify-only: nothing is ever bought, hearted, or messaged automatically.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeFeed, searchUrl, closeVintedBrowser } from "./lib/vinted.js";
import { getComps, closeBrowser as closeScpBrowser } from "./lib/comps.js";
import { isLotOrBundle } from "./lib/parse.js";
import { computeVerdict } from "./lib/verdict.js";
import { ximilarEnabled, capReached, identifyCard, idToTitle } from "./lib/ximilar.js";
import { detectSlab } from "./lib/parse.js";
import { cardhedgerEnabled, capReached as chCapReached, lookupByPhoto } from "./lib/cardhedger.js";
import { usdToEurRate } from "./lib/fx.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const STATE_FILE = join(ROOT, "data", "state.json");
const FINDS_CSV = join(ROOT, "data", "finds.csv");
const EVALS_CSV = join(ROOT, "data", "evaluations.csv");
const LOG = join(ROOT, "logs", "scanner.log");

const once = process.argv.includes("--once");

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { evaluated: {}, alerted: {} }; }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s)); }

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
function appendCsv(file, header, row) {
  if (!existsSync(file)) appendFileSync(file, header + "\n");
  appendFileSync(file, row.map(csvEscape).join(",") + "\n");
}

const LISTINGS_CSV = join(ROOT, "data", "listings.csv");
const LISTINGS_HEADER = "first_seen,id,title,brand,condition,ask_eur,feed,vinted_url,thumb";
const WATCH_CSV = join(ROOT, "data", "watchlist-hits.csv");
const WATCH_HEADER = "ts,id,watch_name,title,ask_eur,vinted_url,thumb";
const FINDS_HEADER = "ts,id,verdict,title,ask_eur,comp_median_eur,ratio,confidence,n_solds,grade,vinted_url,comp_url,thumb";
const EVALS_HEADER = "ts,id,verdict,title,ask_eur,comp_median_eur,ratio,confidence,vinted_url,thumb";

function notify(title, body) {
  const esc = (s) => s.replaceAll("\\", "").replaceAll('"', "'");
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

// Watchlist: fires on ANY new listing matching a tracked name, regardless of
// whether the card can be comped — these are "tell me it exists" alerts.
function matchWatchlist(item, freshIdFloor) {
  if (!item.priceEur || item.priceEur < CONFIG.WATCHLIST_MIN_EUR) return null;
  // Vinted ids increase over time. Only alert on listings newer than anything we
  // had already seen, so draining a backlog can't alert on two-week-old cards.
  if (freshIdFloor && Number(item.id) <= freshIdFloor) return null;
  const t = " " + item.title.toLowerCase() + " ";
  for (const w of CONFIG.WATCHLIST ?? []) {
    if (w.terms.some((term) => t.includes(term.toLowerCase()))) return w.name;
  }
  return null;
}

// verdict for one listing; returns {verdict, transient, comp, ratio}
let ximilarUsedThisCycle = 0;
let certOcrThisCycle = 0;
async function evaluate(item) {
  if (isLotOrBundle(item.title)) return { verdict: "skip_lot", transient: false, comp: null };
  if (!item.priceEur || item.priceEur <= 0) return { verdict: "skip_no_price", transient: false, comp: null };

  let comp = await getComps(item.title);
  let v = computeVerdict(comp, item.priceEur, CONFIG);

  // A slab carries a cert number in its photo, and a cert is a unique key — far
  // stronger than parsing a Vinted title. Try it whenever the title route failed.
  if (
    (v.verdict === "low_confidence" || comp.confidence === "advisory") &&
    CONFIG.CERT_OCR_AUTO && cardhedgerEnabled() && !chCapReached() &&
    certOcrThisCycle < CONFIG.CERT_OCR_PER_CYCLE &&
    detectSlab(item.title) && item.thumb && item.priceEur <= CONFIG.MAX_BUY_EUR
  ) {
    certOcrThisCycle++;
    const c = await lookupByPhoto(item.id, item.thumb);
    if (c.stale) log(`cert-ocr ${item.id}: cert ${c.cert} price is ${c.freshness_days}d stale — ignored`);
    if (!c.error && c.price_usd && !c.stale) {
      const rate = await usdToEurRate();
      const eur = Math.round(c.price_usd * rate * 100) / 100;
      comp = {
        parsed: { grader: c.grader, grade: c.grade },
        comp_median: eur, comp_avg: eur,
        n_solds: c.sample_count ?? 0,
        confidence: c.confidence_grade === "A" ? "high" : "medium",
        sample_urls: [], source: "cert-ocr", cert: c.cert,
        matched_product: `${c.description} [cert ${c.cert}]`,
      };
      v = computeVerdict(comp, item.priceEur, CONFIG);
      log(`cert-ocr ${item.id}: cert ${c.cert} → ${c.description?.slice(0, 45)} €${eur}`);
    }
  }

  // opt-in paid escalation: photo-ID low-confidence listings worth buying
  if (
    v.verdict === "low_confidence" && CONFIG.XIMILAR_AUTO && ximilarEnabled() && !capReached() &&
    ximilarUsedThisCycle < CONFIG.XIMILAR_PER_CYCLE && item.thumb && item.priceEur <= CONFIG.MAX_BUY_EUR
  ) {
    ximilarUsedThisCycle++;
    const idres = await identifyCard(item.id, item.thumb);
    if (!idres.error) {
      // The seller knows their own card. Where the listing states a print run,
      // keep it — Ximilar's serial has been wrong (listing "05/25" → "/03/25").
      const listed = comp.parsed?.serial;
      if (listed) idres.serial_number = listed.replace(/^\//, "");
      const newTitle = idToTitle(idres);
      log(`ximilar rescue ${item.id}: "${item.title.slice(0, 40)}" → "${newTitle}"`);
      comp = await getComps(newTitle);
      v = computeVerdict(comp, item.priceEur, CONFIG);
      comp.photo_id = true;
    }
  }
  return { ...v, transient: !!v.transient, comp, ratio: v.ratio };
}

async function cycle() {
  ximilarUsedThisCycle = 0;
  certOcrThisCycle = 0;
  const state = loadState();
  const feeds = [
    ...CONFIG.FEEDS.map((f) => ({ name: f.name, url: f.url })),
    ...CONFIG.SEARCHES.map((q) => ({
      name: `search:${q}`,
      url: searchUrl(CONFIG.VINTED_DOMAIN, q, {
        catalog: CONFIG.SEARCH_CATALOG,
        brandIds: CONFIG.SEARCH_BRAND_IDS,
        minPrice: CONFIG.MIN_ASK_EUR,
      }),
    })),
  ];

  // Watermark from the previous cycle: anything at or below it is not "new".
  const freshIdFloor = state.maxIdSeen ?? 0;
  let maxIdThisCycle = freshIdFloor;

  let seen = 0, fresh = 0, evaluated = 0, deals = 0, errors = 0, watchHits = 0;
  const budget = CONFIG.MAX_EVAL_PER_CYCLE;

  for (const feed of feeds) {
    let items;
    try {
      items = await scrapeFeed(feed.url);
    } catch (e) {
      errors++;
      log(`ERR feed ${feed.name}: ${e.message}`);
      continue;
    }
    seen += items.length;

    for (const item of items) {
      if (Number(item.id) > maxIdThisCycle) maxIdThisCycle = Number(item.id);

      // Log every tile we see, not just the ones we can afford to comp — this is
      // what the dashboard's Listings browser reads.
      if (!(state.catalogued ??= {})[item.id]) {
        state.catalogued[item.id] = Date.now();
        appendCsv(LISTINGS_CSV, LISTINGS_HEADER, [
          new Date().toISOString(), item.id, item.title, item.brand ?? "", item.condition ?? "",
          item.priceEur ?? "", feed.name, item.url, item.thumb ?? "",
        ]);
      }

      if (state.evaluated[item.id]) continue;
      // Cheap listings aren't worth a comp lookup or an alert.
      if (item.priceEur && item.priceEur < CONFIG.MIN_ASK_EUR) { state.evaluated[item.id] = Date.now(); continue; }
      fresh++;

      // Watchlist fires before the comp budget check — a tracked player should
      // alert the moment it is listed, even if the card can't be comped.
      const watchName = matchWatchlist(item, freshIdFloor);
      if (watchName && !(state.watched ??= {})[item.id]) {
        state.watched[item.id] = Date.now();
        watchHits++;
        appendCsv(WATCH_CSV, WATCH_HEADER, [new Date().toISOString(), item.id, watchName, item.title, item.priceEur, item.url, item.thumb ?? ""]);
        // Everything is recorded, but only the first few per cycle pop a
        // notification — draining a backlog must not fire 30 alerts at once.
        if (watchHits <= CONFIG.WATCHLIST_MAX_NOTIFY_PER_CYCLE) {
          notify(`⭐ ${watchName} listed — €${item.priceEur}`, item.title.slice(0, 90));
        } else if (watchHits === CONFIG.WATCHLIST_MAX_NOTIFY_PER_CYCLE + 1) {
          notify(`⭐ more watchlist hits`, `${watchHits}+ this cycle — see the dashboard`);
        }
        log(`WATCH ${watchName} ${item.id} "${item.title.slice(0, 55)}" €${item.priceEur}${watchHits > CONFIG.WATCHLIST_MAX_NOTIFY_PER_CYCLE ? " (silent)" : ""}`);
        saveState(state); // persist immediately so a crash can't re-alert
      }

      if (evaluated >= budget) continue; // leave for next cycle

      let res;
      try {
        res = await evaluate(item);
      } catch (e) {
        errors++;
        log(`ERR eval ${item.id}: ${e.message}`);
        continue; // stays un-seen, retried next cycle
      }
      if (res.transient) continue; // stays un-seen, retried next cycle

      evaluated++;
      state.evaluated[item.id] = Date.now();
      const c = res.comp;
      const ratio = res.ratio ? Math.round(res.ratio * 100) / 100 : "";
      const ts = new Date().toISOString();

      appendCsv(EVALS_CSV, EVALS_HEADER, [ts, item.id, res.verdict, item.title, item.priceEur, c?.comp_median ?? "", ratio, c?.confidence ?? "", item.url, item.thumb ?? ""]);
      log(`eval ${item.id} [${res.verdict}] "${item.title.slice(0, 60)}" ask=€${item.priceEur} comp=€${c?.comp_median ?? "-"} ratio=${ratio || "-"}`);

      if (["deal", "worklist", "offer", "suspect_ratio", "suspect_authenticity"].includes(res.verdict)) {
        appendCsv(FINDS_CSV, FINDS_HEADER, [
          ts, item.id, res.verdict, item.title, item.priceEur, c.comp_median, ratio,
          c.confidence, c.n_solds, c.parsed.grader ? `${c.parsed.grader} ${c.parsed.grade}` : "raw",
          item.url, c.sample_urls[0] ?? "", item.thumb ?? "",
        ]);
      }
      if (res.verdict === "deal" && !state.alerted[item.id]) {
        state.alerted[item.id] = Date.now();
        deals++;
        notify(`Card deal ${ratio}x — €${item.priceEur}`, `${item.title.slice(0, 80)} | comp €${c.comp_median} (n=${c.n_solds} ${c.confidence})`);
      }
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000)); // gentle on SCP
    }
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500)); // gentle on Vinted
  }

  state.maxIdSeen = maxIdThisCycle;
  saveState(state);
  log(`heartbeat: feeds=${feeds.length} tiles=${seen} new=${fresh} evaluated=${evaluated} deals=${deals} watchlist=${watchHits} errors=${errors} totalSeen=${Object.keys(state.evaluated).length}`);
}

log(`scanner start (${once ? "one-shot" : `service, every ${CONFIG.SCAN_INTERVAL_MIN}min`})`);
try {
  await cycle();
  while (!once) {
    await new Promise((r) => setTimeout(r, CONFIG.SCAN_INTERVAL_MIN * 60 * 1000));
    await cycle();
  }
} finally {
  await closeVintedBrowser();
  await closeScpBrowser();
}
log("scanner exit");
