import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTitle } from "./parse.js";
import { usdToEurRate } from "./fx.js";
import { getCachedComp, setCachedComp, backoffActive, recordExtraction } from "./cache.js";
import { searchProducts, scoreRow, gradeColumn, productComps, closeBrowser } from "./scp.js";
import { ebayEnabled, activeListingStats } from "./ebay.js";

export { closeBrowser };

const CONFIG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "config.json"), "utf8"));
const MAX_AGE_MS = (CONFIG.MAX_COMP_AGE_DAYS ?? 365) * 86400 * 1000;
const isRecent = (dateStr) => Date.now() - Date.parse(dateStr) <= MAX_AGE_MS;

export function buildQuery(parsed) {
  if (parsed.confidence === "low") return null;
  const parts = [parsed.player];
  if (parsed.set) parts.push(parsed.set);
  if (parsed.number) parts.push(parsed.number);
  const wantVariant = parsed.variant.filter((v) => v !== "auto" && v !== "autograph");
  if (wantVariant.length) parts.push(wantVariant[0]);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function normalizeQuery(q, gradeCol) {
  return (q + " @" + gradeCol).toLowerCase().replace(/\s+/g, " ").trim();
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const eur = (usd, rate) => Math.round(usd * rate * 100) / 100;

export async function getComps(title, knownGrade = null, { fresh = false } = {}) {
  const parsed = parseTitle(title, knownGrade);
  const empty = (extra) => ({
    parsed, query_used: null, comp_median: null, comp_avg: null,
    n_solds: 0, confidence: "low", sample_urls: [], ...extra,
  });

  if (parsed.confidence === "low") {
    return empty({ reason: "uncompable title (need player + set/year/number)" });
  }

  const query = buildQuery(parsed);
  const { col, approx } = gradeColumn(parsed);
  const norm = normalizeQuery(query, col);

  const cached = fresh ? null : getCachedComp(norm);
  if (cached) return { parsed, ...cached, cached: true };

  // When SCP has nothing, fall back to eBay active asks — never as a headline
  // deal, only as an advisory estimate for review.
  const ebayFallback = async (scpResult) => {
    if (!CONFIG.EBAY_FALLBACK || !ebayEnabled()) return scpResult;
    const gradeSuffix = parsed.grader ? ` ${parsed.grader} ${parsed.grade}` : "";
    // Require the identifiers that pin the card down, and exclude parallels when
    // the listing didn't ask for one.
    const must = [parsed.player.toLowerCase().split(" ").pop()];
    if (parsed.number) must.push(String(parsed.number).toLowerCase());
    if (parsed.grader) must.push(String(parsed.grade));
    const e = await activeListingStats(query + gradeSuffix, {
      must,
      forbidParallels: parsed.variant.length === 0 && !parsed.serial,
    });
    if (e.error) return { ...scpResult, ebay_note: e.error };
    return {
      ...scpResult,
      comp_median: e.estimate,
      comp_avg: e.estimate,
      n_solds: 0,
      active_n: e.n,
      confidence: "advisory", // banded below deal level by design
      source: "ebay-active",
      sample_urls: scpResult.sample_urls ?? [], // no eBay URLs stored — see lib/ebay.js

      reason: `no sold data — estimate from ${e.n} active eBay asks (Q1 €${e.ask_q1} × ${CONFIG.EBAY_ACTIVE_HAIRCUT}); verify before buying`,
    };
  };

  const bo = backoffActive();
  if (bo) {
    return empty({ query_used: query, reason: `backoff active until ${new Date(bo).toLocaleTimeString()}`, transient: true });
  }

  let rows;
  try {
    rows = await searchProducts(query);
  } catch (e) {
    recordExtraction(true);
    return empty({ query_used: query, reason: `search scrape error: ${e.message}`, transient: true });
  }
  recordExtraction(rows.length === 0);

  const scored = rows
    .map((r) => ({ ...r, score: scoreRow(parsed, r) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    let result = { query_used: query, comp_median: null, comp_avg: null, n_solds: 0, confidence: "low", sample_urls: [], reason: `no matching product on SCP (${rows.length} candidates)` };
    result = await ebayFallback(result);
    if (rows.length > 0) setCachedComp(norm, result); // real miss — cache it; empty page may be transient
    return { parsed, ...result };
  }

  // If the title never named a card number, several catalogue entries can tie on
  // score while being different cards at very different prices (Yamal Megacracks
  // #108-BIS vs #423 differ by more than 2×). Picking one is a coin flip that can
  // cost real money, so refuse and say why.
  if (!parsed.number && scored.length > 1) {
    const top = scored[0].score;
    const tied = scored.filter((r) => r.score >= top - 1);
    const priceOf = (r) => (r.prices || []).find((p) => p > 0) ?? null;
    const prices = tied.map(priceOf).filter((p) => p != null);
    if (tied.length > 1 && prices.length > 1) {
      const spread = Math.max(...prices) / Math.min(...prices);
      if (spread >= (CONFIG.AMBIGUOUS_SPREAD ?? 1.5)) {
        const result = {
          query_used: query,
          comp_median: null, comp_avg: null, n_solds: 0, confidence: "low",
          sample_urls: tied.slice(0, 3).map((r) => r.url),
          candidates: tied.slice(0, 3).map((r) => `${r.title} — ${r.set}`),
          reason: `ambiguous: ${tied.length} equally-plausible cards priced $${Math.min(...prices)}–$${Math.max(...prices)} (${spread.toFixed(1)}× apart) and the title gives no card number`,
        };
        setCachedComp(norm, result);
        return { parsed, ...result };
      }
    }
  }

  const best = scored[0];
  let pc;
  try {
    pc = await productComps(best.url, col);
  } catch (e) {
    recordExtraction(true);
    return empty({ query_used: query, reason: `product scrape error: ${e.message}`, transient: true });
  }

  const rate = await usdToEurRate();
  const guideEntry = pc.guide.find((g) => g.col === col);
  // SCP shows $0.00 for cards with no sales history — that's "no data", not a price
  const guideEur = guideEntry?.guideUsd ? eur(guideEntry.guideUsd, rate) : null;

  // stale sales are not comps — a 2023 price says nothing about today's market
  const recentSales = pc.sales.filter((s) => isRecent(s.date));
  const staleDropped = pc.sales.length - recentSales.length;
  if (recentSales.length === 0 && pc.sales.length > 0) {
    const result = {
      query_used: query,
      matched_product: best.title + " — " + best.set,
      grade_col: col,
      comp_median: null, comp_avg: null, scp_guide_eur: guideEur,
      n_solds: 0, confidence: "low", sample_urls: [best.url],
      reason: `all ${pc.sales.length} sales older than ${CONFIG.MAX_COMP_AGE_DAYS} days (latest ${pc.sales[0].date}) — market too illiquid to comp`,
    };
    setCachedComp(norm, result);
    return { parsed, ...result };
  }

  let prices = recentSales.map((s) => s.priceUsd * rate);
  let result;
  if (prices.length >= 3) {
    if (prices.length >= 5) {
      const sorted = [...prices].sort((a, b) => a - b);
      prices = sorted.slice(1, -1); // drop top/bottom outlier
    }
    result = {
      query_used: query,
      matched_product: best.title + " — " + best.set,
      grade_col: col + (approx ? " (approximated grade bucket)" : ""),
      comp_median: Math.round(median(prices) * 100) / 100,
      comp_avg: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
      scp_guide_eur: guideEur,
      n_solds: recentSales.length,
      confidence: recentSales.length >= 5 && parsed.confidence === "high" && !approx ? "high" : "medium",
      sample_urls: [best.url],
      fx_rate: rate,
      reason: staleDropped ? `${staleDropped} stale sale(s) excluded` : undefined,
      solds: recentSales.map((s) => ({ date: s.date, eur: eur(s.priceUsd, rate), title: s.title })),
    };
  } else if (recentSales.length > 0) {
    // 1-2 recent sales. These beat SCP's guide price, which is computed from the
    // full sales history — including the stale sales we just excluded, so it can
    // disagree wildly (seen: guide €86 against recent sales of €15-17).
    const thin = prices.map((p) => Math.round(p * 100) / 100);
    const med = Math.round(median(prices) * 100) / 100;
    const guideDiverges = guideEur != null && (guideEur > Math.max(...thin) * 2 || guideEur < Math.min(...thin) / 2);
    result = {
      query_used: query,
      matched_product: best.title + " — " + best.set,
      grade_col: col + (approx ? " (approximated grade bucket)" : ""),
      comp_median: med,
      comp_avg: med,
      scp_guide_eur: guideEur,
      n_solds: recentSales.length,
      confidence: "medium",
      sample_urls: [best.url],
      fx_rate: rate,
      reason: `only ${recentSales.length} recent sale(s)${staleDropped ? `, ${staleDropped} stale excluded` : ""}`
        + (guideDiverges ? ` — SCP guide €${guideEur} contradicts them, guide ignored` : ""),
      thin_data: true,
      solds: recentSales.map((s) => ({ date: s.date, eur: eur(s.priceUsd, rate), title: s.title })),
    };
  } else if (guideEur != null) {
    // no recent sales at all — the guide is all we have, and it may be built from
    // stale data, so treat it as advisory rather than a comp to buy on
    result = {
      query_used: query,
      matched_product: best.title + " — " + best.set,
      grade_col: col + (approx ? " (approximated grade bucket)" : ""),
      comp_median: guideEur,
      comp_avg: guideEur,
      scp_guide_eur: guideEur,
      n_solds: 0,
      confidence: "advisory",
      sample_urls: [best.url],
      fx_rate: rate,
      reason: `no recent sales — SCP guide price only${staleDropped ? `, ${staleDropped} stale sale(s) excluded` : ""}; verify before buying`,
      solds: [],
    };
  } else {
    result = {
      query_used: query,
      matched_product: best.title + " — " + best.set,
      grade_col: col,
      comp_median: null, comp_avg: null, scp_guide_eur: null,
      n_solds: recentSales.length, confidence: "low",
      sample_urls: [best.url],
      reason: `no recent sales and no guide price for ${col}`,
    };
    result = await ebayFallback(result);
  }
  setCachedComp(norm, result);
  return { parsed, ...result };
}
