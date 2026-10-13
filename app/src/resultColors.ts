import { createContext } from "react";

/** Map coloring by last test result ("heatmap"). Kept separate from intent colors so the legend can
 *  switch cleanly between the two modes. */
export type ResultKey = "passed" | "failed" | "flaky" | "skipped" | "fixme" | "never";

export const RESULT_COLORS: Record<ResultKey, string> = {
  passed: "#1a7f37",
  failed: "#cf222e",
  flaky: "#bc4c00",
  skipped: "#9a6700",
  fixme: "#9a6700",
  never: "#8c959f",
};

export const RESULT_LABELS: Record<ResultKey, string> = {
  passed: "Passed",
  failed: "Failed",
  flaky: "Flaky",
  skipped: "Skipped",
  fixme: "Fixme (not generated as runnable)",
  never: "Never run",
};

// Worst first: a merged edge (several actions between the same two pages) shows its worst member.
const SEVERITY: ResultKey[] = ["failed", "flaky", "skipped", "fixme", "never", "passed"];

export function worstResult(results: ResultKey[]): ResultKey {
  for (const r of SEVERITY) if (results.includes(r)) return r;
  return "never";
}

/** null = color by intent (the default); otherwise edgeId -> last result. */
export const EdgeResultContext = createContext<Record<string, ResultKey> | null>(null);
