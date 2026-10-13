import type { AssertionType } from "../../src/types";

/** Same verb-sniffing heuristic as src/navmap-test-generator.ts's actionStatement — kept in
 *  sync by hand since one builds Playwright source strings server-side and this one just picks
 *  a display icon client-side; if that heuristic's verb list changes, update this too. */
export function actionIcon(action: string): string {
  const a = action.toLowerCase();
  if (a.includes("fill") || a.includes("type") || a.includes("enter")) return "⌨️";
  if (a.includes("select")) return "🔽";
  if (a.includes("check")) return "☑️";
  if (a.includes("hover")) return "🖐️";
  if (a.includes("press")) return "⏎";
  return "🖱️";
}

export type CheckKind = "visible" | "hidden" | "has_text" | "url" | "count";

/** The icon for what the generated test really asserts: the structured check when there is one,
 *  otherwise the legacy assertion type. */
export function checkIcon(checkKind: CheckKind | undefined, assertionType: AssertionType): string {
  switch (checkKind) {
    case "visible":
      return "👁️";
    case "hidden":
      return "🚫";
    case "has_text":
      return "🔤";
    case "count":
      return "🔢";
    case "url":
      return "🔗";
    default:
      return assertionIcon(assertionType);
  }
}

export function assertionIcon(assertionType: AssertionType): string {
  switch (assertionType) {
    case "url_matches":
      return "🔗";
    case "text_visible":
    case "element_visible":
      return "👁️";
    case "value_equals":
      return "🟰";
    case "status_ok":
      return "📡";
  }
}
