// SportsCardsPro (pricecharting) scraper: search + product-page comps.
// eBay sold-search is login-gated as of mid-2026, so comps come from SCP's
// eBay-derived sales data instead (free, no bot wall).
import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

let browser = null;

async function getPage() {
  if (!browser) {
    browser = await chromium.launch({
      channel: "chromium",
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
  });
  return ctx.newPage();
}

export async function closeBrowser() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

// 90s watchdog: SCP is stable but keep the same guard we need for Vinted.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export async function searchProducts(query) {
  const page = await getPage();
  try {
    return await withTimeout((async () => {
      await page.goto(
        "https://www.sportscardspro.com/search-products?q=" + encodeURIComponent(query) + "&type=prices",
        { waitUntil: "domcontentloaded", timeout: 45000 }
      );
      await page.waitForSelector("a[href*='/game/']", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
      return page.evaluate(() => {
        const rows = [];
        for (const tr of document.querySelectorAll("table tr")) {
          // multiple /game/ anchors per row (icons etc.) — take the one with text
          let a = null;
          for (const cand of tr.querySelectorAll("a[href*='/game/']")) {
            if (cand.innerText.trim() && (!a || cand.innerText.length > a.innerText.length)) a = cand;
          }
          if (!a) continue;
          const tds = [...tr.querySelectorAll("td")];
          const prices = tds
            .map((td) => td.innerText.trim())
            .filter((t) => /^\$[\d,]+(\.\d{2})?$/.test(t))
            .map((t) => parseFloat(t.replace(/[$,]/g, "")));
          const setTd = tds.find((td) => /\b(19|20)\d{2}\b/.test(td.innerText) && !td.querySelector("a[href*='/game/']"));
          rows.push({
            title: a.innerText.trim(),
            set: setTd ? setTd.innerText.trim() : "",
            url: a.href,
            prices, // column order on search page: Ungraded, Grade 9, PSA 10 (missing cols omitted)
          });
        }
        return rows;
      });
    })(), 90000, "SCP search");
  } finally {
    await page.context().close().catch(() => {});
  }
}

// Score a search row against parsed attributes; higher = better match.
export function scoreRow(parsed, row) {
  let score = 0;
  const rt = row.title.toLowerCase();
  const rs = row.set.toLowerCase();

  // card number: "#136" in row title
  if (parsed.number) {
    const m = rt.match(/#([a-z]*-?\d+)/i);
    if (m && m[1].replace(/^[a-z]+-?/i, "") === parsed.number) score += 4;
    else if (m) score -= 2; // wrong number is a strong negative
  }
  // year
  if (parsed.year) {
    const y = parsed.year.slice(0, 4);
    if (rs.includes(y)) score += 2;
  }
  // set words
  if (parsed.set) {
    const words = parsed.set.toLowerCase().split(" ");
    if (words.every((w) => rs.includes(w))) score += 2;
  }
  // player surname
  if (parsed.player) {
    const last = parsed.player.toLowerCase().split(" ").pop();
    if (rt.includes(last)) score += 2;
    else return -100; // wrong player = never match
  }
  // Autographs: never cross-comp auto vs non-auto. SCP marks autos either in the
  // card title ("[Autograph]") or in the set name ("… Archival Autograph"), so
  // both have to be checked or whole sets get wrongly rejected.
  const wantAuto = parsed.variant.some((v) => /^auto/.test(v));
  const rowAuto = /\bauto/i.test(rt) || /\bauto/i.test(rs);
  if (wantAuto !== rowAuto) return -100;

  // variant: SCP encodes parallels as [Silver], [Pink Ice]...
  const bracket = (rt.match(/\[([^\]]+)\]/g) || [])
    .map((b) => b.toLowerCase().slice(1, -1))
    .filter((b) => b !== "rc" && !/^auto/.test(b));
  const wantVariant = parsed.variant.filter((v) => !/^auto/.test(v));
  if (wantVariant.length) {
    if (bracket.some((b) => wantVariant.includes(b))) score += 3; // exact parallel
    else if (bracket.some((b) => wantVariant.some((v) => b.includes(v)))) score += 1; // partial ([black hologlow] for hologlow)
    else score -= 2; // asked for a parallel, row is base/other
  } else {
    if (bracket.length === 0) score += 2; // no variant wanted → prefer base
    else score -= 3; // don't comp base card against a parallel
  }
  // A serial-numbered parallel (/50, /99) is a different card from the base and
  // trades at a different price — refuse rather than comp against an unmarked row.
  if (parsed.serial && !wantAuto && bracket.length === 0 && !rowAuto) return -100;
  return score;
}

// Map parsed grade to SCP price-guide column label.
export function gradeColumn(parsed) {
  if (!parsed.grader) return { col: "Ungraded", approx: false };
  const g = parseFloat(parsed.grade);
  if (parsed.grader === "PSA" && g === 10) return { col: "PSA 10", approx: false };
  if (g === 10) return { col: "Grade 9.5", approx: true }; // BGS/SGC 10 ≈ 9.5 bucket
  if (g === 9.5) return { col: "Grade 9.5", approx: parsed.grader !== "BGS" };
  if (g === 9) return { col: "Grade 9", approx: false };
  if (g === 8 || g === 8.5) return { col: "Grade 8", approx: g === 8.5 };
  if (g === 7) return { col: "Grade 7", approx: false };
  return { col: "Ungraded", approx: true }; // low grades trade near raw
}

// SCP/PriceCharting legacy container classes → card grade columns (verified
// empirically against guide prices on live product pages).
const COL_CLASS = {
  "Ungraded": "used", "Grade 7": "cib", "Grade 8": "new",
  "Grade 9": "graded", "Grade 9.5": "box-only", "PSA 10": "manual-only",
};

export async function productComps(productUrl, colLabel) {
  const page = await getPage();
  try {
    return await withTimeout((async () => {
      await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector("#price_data", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);
      return page.evaluate(({ wantCol, cls }) => {
        // price-guide columns, in order
        const guide = [];
        const pd = document.querySelector("#price_data");
        if (pd) {
          const headers = [...pd.querySelectorAll("th, td.title")].map((h) => h.innerText.trim()).filter(Boolean);
          const priceCells = [...pd.querySelectorAll("td")].map((td) => {
            const m = td.innerText.match(/\$([\d,]+\.\d{2})/);
            return m ? parseFloat(m[1].replace(/,/g, "")) : null;
          }).filter((v) => v !== null);
          for (let i = 0; i < headers.length; i++) {
            guide.push({ col: headers[i], guideUsd: priceCells[i] ?? null });
          }
        }
        // pick the sales container by its semantic class; pages carry duplicate
        // empty containers, so take the one that actually has rows
        let table = null;
        if (cls) {
          for (const d of document.querySelectorAll(`div.completed-auctions-${cls}`)) {
            const t = d.querySelector("table.hoverable-rows");
            if (t && t.querySelector("tbody tr")) { table = t; break; }
          }
        }
        let sales = [];
        if (table) {
          for (const tr of table.querySelectorAll("tbody tr")) {
            const tds = [...tr.querySelectorAll("td")];
            if (tds.length < 3) continue;
            const date = (tr.innerText.match(/\d{4}-\d{2}-\d{2}/) || [null])[0];
            const priceM = tr.innerText.match(/\$([\d,]+\.\d{2})/);
            // title cell: longest td text that isn't the tooltip boilerplate
            let title = "";
            for (const td of tds) {
              const t = td.innerText.replace(/Time Warp[^]*?OK/g, "").replace(/Report It/g, "").trim();
              if (t.length > title.length && !/^\$|^\d{4}-\d{2}-\d{2}$/.test(t)) title = t;
            }
            if (date && priceM) {
              sales.push({ date, title: title.replace(/\s+/g, " ").slice(0, 120), priceUsd: parseFloat(priceM[1].replace(/,/g, "")) });
            }
          }
        }
        return { guide, sales: sales.slice(0, 10), sales30: sales, found: !!table };
      }, { wantCol: colLabel, cls: COL_CLASS[colLabel] });
    })(), 90000, "SCP product");
  } finally {
    await page.context().close().catch(() => {});
  }
}
