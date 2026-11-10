// Ximilar collectibles photo-ID (paid per credit — capped, cached forever per item).
// POST https://api.ximilar.com/collectibles/v2/sport_id
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const CACHE_FILE = join(ROOT, "data", "cache", "ximilar.json");
const SPEND_FILE = join(ROOT, "data", "cache", "ximilar-spend.json");
const LOG = join(ROOT, "logs", "ximilar.log");

const log = (m) => {
  mkdirSync(join(ROOT, "logs"), { recursive: true });
  appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);
};

function loadJson(f, fallback) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } }
function saveJson(f, v) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v)); }

export function spendToday() {
  const s = loadJson(SPEND_FILE, {});
  const today = new Date().toISOString().slice(0, 10);
  return s.date === today ? s.calls : 0;
}
function recordSpend() {
  const today = new Date().toISOString().slice(0, 10);
  const s = loadJson(SPEND_FILE, {});
  saveJson(SPEND_FILE, { date: today, calls: (s.date === today ? s.calls : 0) + 1 });
}

export function ximilarEnabled() { return !!CONFIG.XIMILAR_TOKEN; }
export function capReached() { return spendToday() >= CONFIG.XIMILAR_DAILY_CAP; }

// identify a card from a photo URL; itemId keys the forever-cache
export async function identifyCard(itemId, imageUrl) {
  if (!CONFIG.XIMILAR_TOKEN) return { error: "no XIMILAR_TOKEN in config" };
  const cache = loadJson(CACHE_FILE, {});
  if (cache[itemId]) return { ...cache[itemId], cached: true };
  if (capReached()) return { error: `daily cap reached (${CONFIG.XIMILAR_DAILY_CAP} calls)`, capped: true };

  let resp;
  try {
    const r = await fetch("https://api.ximilar.com/collectibles/v2/sport_id", {
      method: "POST",
      headers: { "Authorization": `Token ${CONFIG.XIMILAR_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        records: [{ _url: imageUrl }],
        // Without magic_ai the catalogue match alone is used and best_match comes
        // back null on anything not already indexed — verified on real listings.
        magic_ai: true,
        slab_id: true,
        slab_grade: true,
        price_stats: true,
      }),
    });
    if (r.ok) recordSpend(); // rejected calls consume no credits — don't bill the cap for them
    if (!r.ok) {
      log(`ERR item=${itemId} http=${r.status}`);
      // The collectibles endpoints need a Business 100K+ plan; the same token
      // authenticates fine on Ximilar's general endpoints, so a 401 here means
      // the service isn't unlocked on the account rather than a bad token.
      if (r.status === 401) {
        return { error: "Ximilar collectibles service not enabled on this account — it needs a Business 100K+ plan, or ask tech@ximilar.com for trial access. Your token itself is valid." };
      }
      return { error: `ximilar http ${r.status}` };
    }
    resp = await r.json();
  } catch (e) {
    log(`ERR item=${itemId} ${e.message}`);
    return { error: e.message };
  }

  const rec = resp.records?.[0] ?? {};
  const objects = rec._objects ?? [];
  const cardObj = objects.find((o) => o._identification?.best_match) ?? rec;
  const best = cardObj._identification?.best_match ?? rec._identification?.best_match;
  // attribute tags come back even when identification fails, and are useful on
  // their own (is it a sports card at all? which sport? is it signed?)
  const tag = (n) => cardObj._tags?.[n]?.[0]?.name ?? null;
  if (!best || !best.name) {
    log(`item=${itemId} no identification (est. 10 credits)`);
    const miss = { error: "no confident identification" };
    cache[itemId] = miss; // cache misses too — don't pay twice for the same item
    saveJson(CACHE_FILE, cache);
    return miss;
  }

  // slab grade if Ximilar read one off the label
  const slab = objects.find((o) => o["Subcategory"] === "Card/Slab" || o.slab_grade || o.slab);
  const gradeInfo = best.grade ?? slab?.slab_grade ?? null;

  const result = {
    player: best.name,
    year: best.year ?? best.season?.slice(0, 4) ?? null,
    company: best.company ?? null,
    set_name: best.set_name ?? null,
    sub_set: best.sub_set ?? null,
    card_number: best.card_number ?? null,
    serial_number: best.serial_number ?? null,
    subcategory: best.subcategory ?? best.Subcategory ?? null,
    card_type: best.card_type ?? null,
    team: best.team ?? null,
    full_name: best.full_name ?? null,
    grade: gradeInfo,
    signed: tag("Autograph") === "signed",
    price_stats: best.price_stats ?? null,
    calls_today: spendToday(),
  };
  cache[itemId] = result;
  saveJson(CACHE_FILE, cache);
  log(`item=${itemId} id="${result.full_name ?? result.player}" (est. 10-20 credits, ${result.calls_today}/${CONFIG.XIMILAR_DAILY_CAP} today)`);
  return result;
}

// build a comp-engine title from an identification
export function idToTitle(idres) {
  // Ximilar's own canonical string already folds in the parallel name
  // ("… Gold Refractor"), which our field-by-field rebuild can drop.
  if (idres.full_name) {
    const fn = idres.full_name.trim();
    const extra = [];
    // full_name sometimes already carries the serial — don't append it twice
    if (idres.serial_number && !/\d+\s*\/\s*\d+|\/\d+/.test(fn)) {
      const run = String(idres.serial_number).match(/(\d+)\s*$/);
      if (run) extra.push("/" + run[1]);
    }
    if (idres.card_number && !fn.includes(String(idres.card_number))) extra.push("#" + idres.card_number);
    if (idres.grade?.grader && idres.grade?.grade) extra.push(`${idres.grade.grader} ${idres.grade.grade}`);
    return [idres.full_name.trim(), ...extra].join(" ");
  }

  const parts = [idres.player];
  if (idres.year) parts.push(idres.year);
  if (idres.company) parts.push(idres.company);
  if (idres.set_name) parts.push(idres.set_name);
  if (idres.sub_set) parts.push(idres.sub_set);
  if (idres.card_number) parts.push("#" + idres.card_number);
  // "67/99" means card 67 OF 99 — the print run is what identifies the parallel
  // and what the market searches on. Keep the denominator, drop the copy number.
  if (idres.serial_number) {
    const run = String(idres.serial_number).match(/(\d+)\s*$/);
    if (run) parts.push("/" + run[1]);
  }
  if (idres.signed) parts.push("auto");
  if (idres.grade?.grader && idres.grade?.grade) parts.push(`${idres.grade.grader} ${idres.grade.grade}`);
  return parts.filter(Boolean).join(" ");
}
