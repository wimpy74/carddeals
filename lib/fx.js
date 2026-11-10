import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "cache", "fx.json");
const TTL_MS = 12 * 60 * 60 * 1000;

export async function usdToEurRate() {
  try {
    const c = JSON.parse(readFileSync(CACHE, "utf8"));
    if (Date.now() - c.ts < TTL_MS) return c.rate;
  } catch {}
  const res = await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR");
  if (!res.ok) throw new Error(`frankfurter HTTP ${res.status}`);
  const data = await res.json();
  const rate = data.rates.EUR;
  writeFileSync(CACHE, JSON.stringify({ ts: Date.now(), rate }));
  return rate;
}
