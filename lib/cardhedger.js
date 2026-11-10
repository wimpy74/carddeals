// Card Hedge API — verified against live responses 2026-07-29.
//
// /v1/cards/card-search returns prices for every grade inline, so a single call
// answers "what is this card worth raw / PSA 9 / PSA 10". Prices are USD.
//
// Coverage note (measured, not assumed): strong on mainstream base cards in both
// raw and graded, including soccer. Weak on low-population autograph parallels —
// all 162 catalogued Ethan Nwaneri cards contained zero Museum and zero autograph
// entries. Treat it as a second opinion and a RAW price source, not a cure for
// the thin-market problem.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const CACHE_FILE = join(ROOT, "data", "cache", "cardhedger.json");
const SPEND_FILE = join(ROOT, "data", "cache", "cardhedger-spend.json");
const LOG = join(ROOT, "logs", "cardhedger.log");
const BASE = "https://api.cardhedger.com/v1/cards";

const log = (m) => { mkdirSync(join(ROOT, "logs"), { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); };
function loadJson(f, fb) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fb; } }
function saveJson(f, v) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v)); }

export function cardhedgerEnabled() { return !!CONFIG.CARDHEDGER_TOKEN; }
export function callsToday() {
  const s = loadJson(SPEND_FILE, {});
  return s.date === new Date().toISOString().slice(0, 10) ? s.calls : 0;
}
function recordCall() {
  const today = new Date().toISOString().slice(0, 10);
  const s = loadJson(SPEND_FILE, {});
  saveJson(SPEND_FILE, { date: today, calls: (s.date === today ? s.calls : 0) + 1 });
}
export function capReached() { return callsToday() >= (CONFIG.CARDHEDGER_DAILY_CAP ?? 100); }

async function search(body) {
  const r = await fetch(BASE + "/card-search", {
    method: "POST",
    headers: { "X-API-Key": CONFIG.CARDHEDGER_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  recordCall();
  if (!r.ok) throw new Error(`cardhedger ${r.status}: ${(await r.text()).slice(0, 140)}`);
  return r.json();
}

// Our parsed grade → Card Hedge's grade label.
export function chGradeLabel(parsed) {
  if (!parsed.grader) return "Raw";
  if (parsed.grader === "UNKNOWN") return `PSA ${parsed.grade}`;
  return `${parsed.grader} ${parsed.grade}`;
}

// Rank a catalog row against parsed attributes. Same discipline as the SCP
// matcher: a wrong number or a base row for a serial card must not win.
export function scoreCard(parsed, c) {
  let s = 0;
  const set = (c.set || "").toLowerCase();
  const variant = (c.variant || "").toLowerCase();
  const player = (c.player || "").toLowerCase();

  if (parsed.player) {
    const last = parsed.player.toLowerCase().split(" ").pop();
    if (!player.includes(last)) return -100;
    s += 2;
  }
  if (parsed.number) {
    if (String(c.number || "").toLowerCase() === String(parsed.number).toLowerCase()) s += 4;
    else if (c.number) s -= 2;
  }
  if (parsed.year && set.includes(parsed.year.slice(0, 4))) s += 2;

  // The catalog carries no serial-number field, so a "/50" or "/99" parallel can
  // never be positively confirmed here — and the wrong parallel is a wrong price.
  // Refuse rather than guess. (Observed: a Topps /50 matched a Panini "Blue Ice".)
  if (parsed.serial) return -100;

  // A named set must actually be present. Without this a search for a Museum
  // autograph happily matches a $2 base card from an unrelated set.
  if (parsed.set) {
    const words = parsed.set.toLowerCase().split(" ");
    const specific = words.filter((w) => w !== "topps" && w !== "panini");
    // bare manufacturer still has to match the manufacturer
    if (!specific.length) { if (!words.every((w) => set.includes(w))) return -100; }
    else if (!specific.every((w) => set.includes(w))) return -100;
    s += 2;
  }

  // Autographs are a different card from the base and trade at a different price.
  const wantAuto = parsed.variant.some((v) => /^auto/.test(v));
  const rowAuto = /auto/.test(variant) || /auto/.test(set) || /auto/.test((c.subset || "").toLowerCase());
  if (wantAuto && !rowAuto) return -100;

  const wantVariant = parsed.variant.filter((v) => !/^auto/.test(v));
  if (wantVariant.length) {
    if (wantVariant.some((v) => variant.includes(v))) s += 3;
    else s -= 2;
  } else if (variant === "base" || !variant) s += 1;

  return s;
}

// Cert lookup — the strongest path we have for slabs. A cert number is a unique
// key, so this bypasses title parsing entirely (the actual bottleneck: half of
// failed slab comps were refused titles, not missing prices). Returns a fair
// market value with a confidence grade and a stated methodology.
export async function lookupByCert(certNumber) {
  if (!cardhedgerEnabled()) return { error: "no CARDHEDGER_TOKEN in config.json" };
  const cert = String(certNumber).replace(/\D/g, "");
  if (!cert) return { error: "invalid cert number" };
  if (capReached()) return { error: `Card Hedge daily cap reached (${CONFIG.CARDHEDGER_DAILY_CAP})`, capped: true };

  const cache = loadJson(CACHE_FILE, {});
  const key = "cert:" + cert;
  const hit = cache[key];
  if (hit && Date.now() - hit.at < (CONFIG.CARDHEDGER_CACHE_HOURS ?? 24) * 3600e3) return { ...hit.value, cached: true };

  let value;
  try {
    const r = await fetch(BASE + "/fmv-by-cert", {
      method: "POST",
      headers: { "X-API-Key": CONFIG.CARDHEDGER_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ cert }),
    });
    recordCall();
    if (!r.ok) return { error: `cardhedger fmv-by-cert ${r.status}: ${(await r.text()).slice(0, 140)}` };
    const j = await r.json();
    const ci = j.cert_info ?? {};
    const f = j.fmv ?? {};
    if (!f.price) return { error: "cert found but no FMV", cert_desc: ci.description ?? null };
    value = {
      source: "cardhedger-cert",
      cert,
      grader: (ci.grader || "").toUpperCase(),
      grade: ci.grade ?? null,
      description: ci.description ?? j.card?.description ?? null,
      population: ci.gem_total ?? null,
      price_usd: f.price,
      low_usd: f.price_low ?? null,
      high_usd: f.price_high ?? null,
      confidence_grade: f.confidence_grade ?? null,
      freshness_days: f.freshness_days ?? null,
      sample_count: f.fmv_sample_count ?? null,
      method: f.price_explanation ?? f.method ?? null,
      // A "price" can be an old print nudged by a modelled index — one cert came
      // back 636 days stale. Same rule as sold comps: too old is not a price.
      stale: (f.freshness_days ?? 0) > (CONFIG.CERT_MAX_STALE_DAYS ?? 120),
    };
  } catch (e) {
    log(`ERR cert ${cert}: ${e.message}`);
    return { error: e.message };
  }

  cache[key] = { at: Date.now(), value };
  saveJson(CACHE_FILE, cache);
  log(`CERT ${cert} → ${value.description?.slice(0, 50)} ${value.grade} $${value.price_usd} (conf ${value.confidence_grade}, n=${value.sample_count}) [${callsToday()} calls today]`);
  return value;
}

// Photo → cert → valuation in one call. Verified on real Vinted thumbnails:
// PSA slabs resolve correctly at 310×430; CGC lookups currently 502 upstream.
export async function lookupByPhoto(itemId, imageUrl) {
  if (!cardhedgerEnabled()) return { error: "no CARDHEDGER_TOKEN in config.json" };
  if (capReached()) return { error: `Card Hedge daily cap reached (${CONFIG.CARDHEDGER_DAILY_CAP})`, capped: true };

  const cache = loadJson(CACHE_FILE, {});
  const key = "ocr:" + itemId;
  if (cache[key]) return { ...cache[key].value, cached: true }; // photos don't change — cache forever

  let value;
  try {
    const r = await fetch(BASE + "/prices-by-cert-ocr", {
      method: "POST",
      headers: { "X-API-Key": CONFIG.CARDHEDGER_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: imageUrl }),
    });
    recordCall();
    const body = await r.text();
    if (!r.ok) {
      // upstream grader-data errors are transient; don't cache them
      const transient = /GemRate API error|50\d/.test(body);
      const err = { error: `cert-ocr ${r.status}: ${body.slice(0, 90)}`, transient };
      if (!transient) { cache[key] = { at: Date.now(), value: err }; saveJson(CACHE_FILE, cache); }
      return err;
    }
    const j = JSON.parse(body);
    const ci = j.cert_info ?? {};
    if (!ci.cert) {
      value = { error: "no cert readable in photo" };
    } else {
      const f = j.fmv ?? {};
      const prices = j.prices ?? [];
      const latest = f.price ?? (prices.length ? prices[prices.length - 1].price : null);
      if (latest == null) {
        // The OCR endpoint often returns the cert without a valuation. The cert
        // is the hard part — spend one more call to price it properly.
        const byCert = await lookupByCert(ci.cert);
        value = byCert.error ? { error: byCert.error, cert: ci.cert } : { ...byCert, source: "cardhedger-ocr+cert" };
      } else {
        value = {
          source: "cardhedger-ocr",
          cert: ci.cert,
          grader: (ci.grader || "").toUpperCase(),
          grade: ci.grade ?? null,
          description: ci.description ?? null,
          population: ci.gem_total ?? null,
          price_usd: +latest,
          confidence_grade: f.confidence_grade ?? null,
          sample_count: f.fmv_sample_count ?? null,
          stale: (f.freshness_days ?? 0) > (CONFIG.CERT_MAX_STALE_DAYS ?? 120),
        };
      }
    }
  } catch (e) {
    return { error: e.message, transient: true };
  }

  cache[key] = { at: Date.now(), value };
  saveJson(CACHE_FILE, cache);
  log(`OCR item=${itemId} → ${value.error ?? `cert ${value.cert} ${value.grade} $${value.price_usd}`} [${callsToday()} calls today]`);
  return value;
}

export async function lookupPrices(parsed) {
  if (!cardhedgerEnabled()) return { error: "no CARDHEDGER_TOKEN in config.json" };
  if (capReached()) return { error: `Card Hedge daily cap reached (${CONFIG.CARDHEDGER_DAILY_CAP})`, capped: true };

  const q = [parsed.player, parsed.year, parsed.set, parsed.number, ...parsed.variant].filter(Boolean).join(" ");
  const grade = chGradeLabel(parsed);
  const key = (q + "@" + grade).toLowerCase();

  const cache = loadJson(CACHE_FILE, {});
  const hit = cache[key];
  if (hit && Date.now() - hit.at < (CONFIG.CARDHEDGER_CACHE_HOURS ?? 24) * 3600e3) return { ...hit.value, cached: true };

  let value;
  try {
    const j = await search({ search: q, page: 1, page_size: 25 });
    const ranked = (j.cards || []).map((c) => ({ c, s: scoreCard(parsed, c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (!ranked.length) {
      value = { error: `no catalog match (${j.count ?? 0} loose matches)` };
    } else {
      const c = ranked[0].c;
      const priced = (c.prices || []).filter((p) => p.grade && +p.price > 0);
      const exact = priced.find((p) => p.grade === grade);
      value = exact
        ? {
            source: "cardhedger",
            card: c.description,
            set: c.set,
            number: c.number,
            variant: c.variant,
            grade,
            price_usd: +exact.price,
            all_grades: priced.map((p) => ({ grade: p.grade, usd: +p.price })),
            sales_30d: c["30 Day Sales"] ?? null,
            sales_7d: c["7 Day Sales"] ?? null,
          }
        : {
            error: `card found but no ${grade} price`,
            card: c.description,
            all_grades: priced.map((p) => ({ grade: p.grade, usd: +p.price })),
          };
    }
  } catch (e) {
    log(`ERR ${key}: ${e.message}`);
    return { error: e.message };
  }

  cache[key] = { at: Date.now(), value };
  saveJson(CACHE_FILE, cache);
  log(`${value.error ? "MISS" : "HIT "} "${key}" → ${value.error ?? `$${value.price_usd} (${value.sales_30d ?? "?"} sales/30d)`} [${callsToday()} calls today]`);
  return value;
}
