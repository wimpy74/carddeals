// eBay Browse API — ACTIVE listings only (sold data lives behind Marketplace
// Insights, which is limited-release and not granted to small sellers).
//
// Active asking prices are a weaker signal than solds: sellers list above market,
// and unsold inventory sits for months. So this is deliberately used as a FALLBACK
// only, with a haircut applied and confidence capped — it must never on its own
// justify a headline "deal" alert.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { usdToEurRate } from "./fx.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const TOKEN_FILE = join(ROOT, "data", "cache", "ebay-token.json");

export function ebayEnabled() {
  return !!(CONFIG.EBAY_CLIENT_ID && CONFIG.EBAY_CLIENT_SECRET);
}

function loadJson(f, fb) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fb; } }
function saveJson(f, v) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v)); }

async function getToken() {
  const cached = loadJson(TOKEN_FILE, null);
  if (cached && cached.expires > Date.now() + 60000) return cached.token;

  const basic = Buffer.from(`${CONFIG.EBAY_CLIENT_ID}:${CONFIG.EBAY_CLIENT_SECRET}`).toString("base64");
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!r.ok) throw new Error(`ebay oauth ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  saveJson(TOKEN_FILE, { token: j.access_token, expires: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// A keyword search returns the base card alongside its parallels and autos, whose
// asks can be 50× higher — Wembanyama #136 came back spanning €330 to €26,392.
// Keep only titles that carry the card's own identifiers, and drop titles naming a
// parallel we did not ask for. Titles are inspected in memory and never stored.
function titleMatches(title, must, forbidParallels) {
  const t = title.toLowerCase();
  if (!must.every((m) => t.includes(m))) return false;
  if (forbidParallels && /\b(silver|gold|green|red|blue|orange|purple|pink|mojo|prizm ice|ice|shimmer|wave|refractor|auto|autograph|patch|\/\d{1,3}\b)/.test(t)) return false;
  return true;
}

// Search active listings; returns EUR statistics or null.
export async function activeListingStats(query, { limit = 50, must = [], forbidParallels = false } = {}) {
  if (!ebayEnabled()) return { error: "no eBay keyset in config.json" };
  let token;
  try { token = await getToken(); } catch (e) { return { error: e.message }; }

  const url = "https://api.ebay.com/buy/browse/v1/item_summary/search"
    + "?q=" + encodeURIComponent(query)
    + "&category_ids=212"                 // Sports Trading Cards
    + "&filter=" + encodeURIComponent("buyingOptions:{FIXED_PRICE}")
    + "&limit=" + limit;

  let j;
  try {
    const r = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        // EBAY_ENCA/EBAY_DE etc. change currency; DE keeps prices in EUR natively
        "X-EBAY-C-MARKETPLACE-ID": CONFIG.EBAY_MARKETPLACE ?? "EBAY_DE",
        "Accept": "application/json",
      },
    });
    if (!r.ok) return { error: `ebay browse ${r.status}: ${(await r.text()).slice(0, 140)}` };
    j = await r.json();
  } catch (e) {
    return { error: e.message };
  }

  // EBAY_US quotes USD, EBAY_DE quotes EUR — normalise everything to EUR here so
  // the ratio maths downstream never mixes currencies.
  const rate = await usdToEurRate();
  const items = (j.itemSummaries ?? [])
    .map((it) => {
      const raw = parseFloat(it.price?.value ?? "NaN");
      const cur = it.price?.currency;
      return {
        title: it.title,
        price: cur === "USD" ? raw * rate : raw,
        currency: cur,
        url: it.itemWebUrl,
      };
    })
    .filter((it) => Number.isFinite(it.price) && (it.currency === "EUR" || it.currency === "USD"))
    .filter((it) => titleMatches(it.title, must, forbidParallels));

  if (items.length < 3) return { error: `only ${items.length} matching active listings`, n: items.length };

  let prices = items.map((i) => i.price).sort((a, b) => a - b);
  // Trim the tails: a mispriced listing or a leftover parallel skews everything.
  if (prices.length >= 8) {
    const cut = Math.floor(prices.length * 0.1);
    prices = prices.slice(cut, prices.length - cut);
  }
  // Sellers ask above market and stale inventory lingers, so the low quartile of
  // asks tracks realistic sale prices far better than the median ask does.
  const q1 = prices[Math.floor(prices.length * 0.25)];
  return {
    source: "ebay-active",
    n: prices.length,
    ask_median: Math.round(median(prices) * 100) / 100,
    ask_q1: Math.round(q1 * 100) / 100,
    estimate: Math.round(q1 * (CONFIG.EBAY_ACTIVE_HAIRCUT ?? 0.85) * 100) / 100,
    low: prices[0],
    high: prices[prices.length - 1],
    // Deliberately no listing titles, item URLs or ids: we keep only derived
    // statistics so nothing from eBay is persisted to disk. This keeps the
    // marketplace-account-deletion exemption declaration accurate.
    samples: [],
  };
}
