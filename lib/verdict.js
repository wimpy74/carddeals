// Ratio→verdict banding shared by scanner and dashboard re-evaluation.
export function computeVerdict(comp, priceEur, CONFIG) {
  if (comp.transient) return { verdict: "transient", transient: true };
  if (comp.confidence === "low" || comp.comp_median == null) return { verdict: "low_confidence" };

  const ratio = comp.comp_median / priceEur;

  // Estimates from active asking prices are not sold data. They can flag
  // something worth a human look, but must never fire a headline deal alert.
  if (comp.confidence === "advisory") {
    if (ratio >= CONFIG.SUSPECT_RATIO) return { verdict: "suspect_ratio", ratio };
    return { verdict: ratio >= CONFIG.WORKLIST_RATIO ? "worklist" : "no_deal", ratio, advisory: true };
  }
  const raw = !comp.parsed?.grader;

  if (ratio >= CONFIG.SUSPECT_RATIO) return { verdict: "suspect_ratio", ratio };
  if (raw && comp.comp_median > CONFIG.RAW_SUSPECT_EUR && ratio >= CONFIG.WORKLIST_RATIO) {
    return { verdict: "suspect_authenticity", ratio };
  }
  // One or two sales is a hint, not a market price — cap it at worklist so a
  // thin sample can't fire a buy alert on its own.
  if (comp.thin_data && ratio >= CONFIG.WORKLIST_RATIO) return { verdict: "worklist", ratio, thin: true };
  if (ratio >= CONFIG.ALERT_RATIO) return { verdict: "deal", ratio };
  if (ratio >= CONFIG.WORKLIST_RATIO) return { verdict: "worklist", ratio };
  if (ratio >= 1 / CONFIG.OFFER_MAX_ASK_OVER_COMP) return { verdict: "offer", ratio };
  return { verdict: "no_deal", ratio };
}
