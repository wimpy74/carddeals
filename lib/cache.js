import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "cache");

function load(file) {
  try { return JSON.parse(readFileSync(join(DIR, file), "utf8")); } catch { return {}; }
}
function save(file, obj) {
  writeFileSync(join(DIR, file), JSON.stringify(obj, null, 1));
}

const COMP_TTL_MS = 24 * 60 * 60 * 1000;

export function getCachedComp(query) {
  const db = load("comps.json");
  const e = db[query];
  if (e && Date.now() - e.ts < COMP_TTL_MS) return e.result;
  return null;
}

export function setCachedComp(query, result) {
  const db = load("comps.json");
  // prune expired entries while we're here
  for (const k of Object.keys(db)) if (Date.now() - db[k].ts >= COMP_TTL_MS) delete db[k];
  db[query] = { ts: Date.now(), result };
  save("comps.json", db);
}

// Backoff: after 3 consecutive empty extractions, pause scraping for 10 min.
const BACKOFF_MS = 10 * 60 * 1000;

export function backoffActive() {
  const s = load("backoff.json");
  return s.until && Date.now() < s.until ? s.until : null;
}

export function recordExtraction(empty) {
  const s = load("backoff.json");
  if (empty) {
    s.emptyStreak = (s.emptyStreak || 0) + 1;
    if (s.emptyStreak >= 3) {
      s.until = Date.now() + BACKOFF_MS;
      s.emptyStreak = 0;
    }
  } else {
    s.emptyStreak = 0;
    delete s.until;
  }
  save("backoff.json", s);
}
