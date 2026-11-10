// PSA public cert API — free ~100 lookups/day, deterministic for slabs.
// GET https://api.psacard.com/publicapi/cert/GetByCertNumber/{cert}
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const CACHE_FILE = join(ROOT, "data", "cache", "psa.json");
const SPEND_FILE = join(ROOT, "data", "cache", "psa-spend.json");
const LOG = join(ROOT, "logs", "ximilar.log"); // shared paid-ID log

const log = (m) => { mkdirSync(join(ROOT, "logs"), { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); };
function loadJson(f, fallback) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } }
function saveJson(f, v) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v)); }

export function psaEnabled() { return !!CONFIG.PSA_TOKEN; }

export async function lookupCert(certNumber) {
  if (!CONFIG.PSA_TOKEN) return { error: "no PSA_TOKEN in config" };
  const cert = String(certNumber).replace(/\D/g, "");
  if (!cert) return { error: "invalid cert number" };
  const cache = loadJson(CACHE_FILE, {});
  if (cache[cert]) return { ...cache[cert], cached: true };

  const today = new Date().toISOString().slice(0, 10);
  const s = loadJson(SPEND_FILE, {});
  const used = s.date === today ? s.calls : 0;
  if (used >= CONFIG.PSA_DAILY_CAP) return { error: `PSA daily cap reached (${CONFIG.PSA_DAILY_CAP})`, capped: true };

  try {
    const r = await fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${cert}`, {
      headers: { "authorization": `bearer ${CONFIG.PSA_TOKEN}` },
    });
    saveJson(SPEND_FILE, { date: today, calls: used + 1 });
    if (r.status === 403) {
      return { error: "PSA public API says 'limited to approved customers' — the token exists but the account isn't approved yet. Request access via your psacard.com public API dashboard." };
    }
    if (!r.ok) return { error: `psa http ${r.status}` };
    const j = await r.json();
    const c = j.PSACert ?? j;
    if (!c || !c.Subject) return { error: "cert not found" };
    const result = {
      cert,
      player: c.Subject,
      year: c.Year ?? null,
      brand: c.Brand ?? null,           // e.g. "Panini Prizm"
      card_number: c.CardNumber ?? null,
      variety: c.Variety ?? null,
      grade: c.CardGrade ?? null,       // e.g. "GEM MT 10"
      category: c.Category ?? null,
    };
    cache[cert] = result;
    saveJson(CACHE_FILE, cache);
    log(`psa cert=${cert} "${result.player}" ${result.grade} (free, ${used + 1}/${CONFIG.PSA_DAILY_CAP} today)`);
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

export function certToTitle(c) {
  const gradeNum = (String(c.grade ?? "").match(/(\d+(?:\.\d)?)\s*$/) ?? [])[1];
  const parts = [c.player];
  if (c.year) parts.push(c.year);
  if (c.brand) parts.push(c.brand);
  if (c.variety) parts.push(c.variety);
  if (c.card_number) parts.push("#" + c.card_number);
  if (gradeNum) parts.push("PSA " + gradeNum);
  return parts.join(" ");
}
