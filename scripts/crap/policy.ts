import type { BaselineEntry } from "./baseline.js";
import type { FunctionMetric } from "./model.js";

export type QualityStatus = "pass" | "warn" | "fail";
export type QualityResult = FunctionMetric & { status: QualityStatus; reason?: string };

/**
 * Existing violations are warnings only while unchanged. A changed function, or an
 * unchanged function whose score regresses beyond its recorded score, is a failure.
 */
export function evaluate(
  metric: FunctionMetric,
  baseline: BaselineEntry | undefined,
  changed: boolean,
): QualityResult {
  if (!baseline || changed) {
    return {
      ...metric,
      status: metric.crap <= 6 ? "pass" : "fail",
      reason:
        metric.crap <= 6
          ? undefined
          : changed
            ? "changed function exceeds CRAP 6"
            : "new function exceeds CRAP 6",
    };
  }
  if (metric.crap > baseline.crap || metric.coverage < baseline.coverage) {
    return { ...metric, status: "fail", reason: "unchanged function regressed from baseline" };
  }
  if (metric.crap <= 6) return { ...metric, status: "pass" };
  return { ...metric, status: "warn", reason: "legacy CRAP violation" };
}
