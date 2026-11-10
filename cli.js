#!/usr/bin/env node
// Usage: node cli.js "listing title" [--grade "PSA 10"] [--json]
import { getComps, closeBrowser } from "./lib/comps.js";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const gi = args.indexOf("--grade");
const grade = gi >= 0 ? args[gi + 1] : null;
const title = args.filter((a, i) => a !== "--json" && a !== "--grade" && (gi < 0 || i !== gi + 1))[0];

if (!title) {
  console.error('Usage: node cli.js "listing title" [--grade "PSA 10"] [--json]');
  process.exit(1);
}

const r = await getComps(title, grade);
await closeBrowser();

if (jsonOut) {
  console.log(JSON.stringify(r, null, 2));
} else {
  const p = r.parsed;
  console.log(`\nTITLE   ${p.title}`);
  console.log(`PARSED  player=${p.player} year=${p.year} set=${p.set} #=${p.number} serial=${p.serial} variant=[${p.variant}] grade=${p.grader ? p.grader + " " + p.grade : "raw"} rookie=${p.rookie} parse-conf=${p.confidence}`);
  console.log(`QUERY   ${r.query_used ?? "(skipped)"}`);
  if (r.matched_product) console.log(`MATCH   ${r.matched_product}  [${r.grade_col}]`);
  if (r.reason) console.log(`NOTE    ${r.reason}`);
  if (r.comp_median != null) {
    console.log(`COMPS   median €${r.comp_median}  avg €${r.comp_avg}  guide €${r.scp_guide_eur}  n=${r.n_solds}  confidence=${r.confidence}${r.cached ? "  (cached)" : ""}`);
    for (const s of r.solds ?? []) console.log(`  €${String(s.eur).padStart(8)}  ${s.date}  ${s.title.slice(0, 70)}`);
    for (const u of r.sample_urls) console.log(`  ${u}`);
  } else {
    console.log(`COMPS   none (n=${r.n_solds}, confidence=${r.confidence})`);
  }
}
