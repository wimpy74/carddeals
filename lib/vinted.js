// Vinted.lt scraper. Known hazards: pages crash headless chromium ~1-in-3
// loads AND can hang without throwing — every scrape runs under a 90s
// watchdog and the browser is relaunched on any failure.
import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

let browser = null;

async function launch() {
  browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

export async function closeVintedBrowser() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} watchdog: hung >${ms}ms`)), ms)),
  ]);
}

// Tile title attr packs: "NAME, prekių ženklas: X, būklė: Y, 12,30 €, 13,50 € įskaitant..."
export function parseTile(titleAttr) {
  if (!titleAttr) return null;
  const name = titleAttr.split(/, prekių ženklas:|, brand:|, бренд:/)[0].trim();
  const brandM = titleAttr.match(/(?:prekių ženklas|brand|бренд):\s*([^,]+)/);
  const condM = titleAttr.match(/(?:būklė|condition|состояние):\s*([^,]+)/);
  const priceM = titleAttr.match(/(\d+(?:\s?\d{3})*[.,]\d{2})\s*€/);
  return {
    name,
    brand: brandM ? brandM[1].trim() : null,
    condition: condM ? condM[1].trim() : null,
    priceEur: priceM ? parseFloat(priceM[1].replace(/\s/g, "").replace(",", ".")) : null,
  };
}

export async function scrapeFeed(url, { maxItems = 48 } = {}) {
  if (!browser) await launch();
  let ctx;
  try {
    return await withTimeout((async () => {
      ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 }, locale: "lt-LT" });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('a[data-testid$="--overlay-link"]', { timeout: 20000 }).catch(() => {});
      const raw = await page.evaluate((max) => {
        const out = [];
        for (const a of document.querySelectorAll('a[data-testid$="--overlay-link"]')) {
          const id = (a.getAttribute("data-testid").match(/product-item-id-(\d+)/) || [])[1];
          if (!id) continue;
          const grid = a.closest("[data-testid^='grid-item'], .feed-grid__item") || a.parentElement;
          const img = grid ? grid.querySelector("img") : null;
          out.push({
            id,
            titleAttr: a.getAttribute("title"),
            url: a.href,
            thumb: img ? img.src : null,
          });
          if (out.length >= max) break;
        }
        return out;
      }, maxItems);
      const items = [];
      for (const r of raw) {
        const t = parseTile(r.titleAttr);
        if (!t || !t.name) continue;
        items.push({
          id: r.id,
          title: t.name,
          brand: t.brand,
          condition: t.condition,
          priceEur: t.priceEur,
          url: r.url,
          // Thumb URLs are signature-signed per size ("…/310x430/…?s=<sig>"), so
          // rewriting the size 404s. A larger image needs the item page fetched.
          thumb: r.thumb,
        });
      }
      return items;
    })(), 90000, "vinted");
  } catch (e) {
    // crash or hang — burn the browser, next call relaunches
    await closeVintedBrowser();
    throw e;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

// Keyword searches carry the same catalog/brand/price filters as the saved feed,
// otherwise "psa 10" drags in Pokemon slabs and Polish dog products ("psa" = dog).
export function searchUrl(domain, query, { catalog, brandIds = [], minPrice } = {}) {
  const p = new URLSearchParams();
  p.set("search_text", query);
  if (catalog) p.append("catalog[]", catalog);
  for (const b of brandIds) p.append("brand_ids[]", b);
  if (minPrice) { p.set("price_from", String(minPrice)); p.set("currency", "EUR"); }
  p.set("order", "newest_first");
  return `https://www.${domain}/catalog?${p.toString()}`;
}
