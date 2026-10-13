import type { NavigationMap } from "./navmap-types.js";

/** A free, rule-based first read of a failed test — from the error text alone, no AI. It only
 *  suggests where to look (and whether a plain rerun is the cheaper first move); the triage agent
 *  makes the actual call. */
export type HintCategory = "environment" | "session" | "locator-ambiguous" | "locator-missing" | "navigation" | "assertion" | "unknown";

export interface TriageHint {
  category: HintCategory;
  reason: string;
  /** A plain rerun is the sensible first step (no quota). */
  rerunFirst: boolean;
}

const ENVIRONMENT_RE = /page\.goto: (Timeout|net::ERR_)|net::ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|socket hang up/;
// Also printed when the TEST times out mid-action — only an environment signal when the test wasn't
// stuck waiting for an element (see the locator-missing rule, checked first).
const CLOSED_RE = /Target page, context or browser has been closed/;
const ARRIVAL_RE = /expected to arrive on "([^"]+)"/;
const STRICT_RE = /strict mode violation/;
const WAITING_RE = /waiting for (locator|getBy\w+)\(/;
const TIMEOUT_RE = /Timeout \d+ms exceeded|Test timeout of \d+ms exceeded/;
const URL_EXPECT_RE = /toHaveURL/;
// The expected URL is usually a regex source, so its dots arrive escaped ("www\.facebook\.com").
const EXPECTED_PATTERN_RE = /Expected (pattern|string): *\/?\^?(https?:\\?\/\\?\/(?:[^\s/\\(]|\\\.)+)/;
const RECEIVED_RE = /Received(?: string)?: *"(https?:\/\/[^/"]+)/;
const VALUE_EXPECT_RE = /to(HaveText|BeCloseTo|HaveCount|ContainText|HaveValue)\b[\s\S]*Expected[\s\S]*Received/;

function unescapeHost(s: string): string {
  return s.replace(/\\/g, "");
}

export function hintFor(error: string | null, map: NavigationMap): TriageHint {
  const text = error ?? "";
  if (ENVIRONMENT_RE.test(text)) {
    return { category: "environment", reason: "The page didn't load or the browser connection dropped — usually the site or network, not the test.", rerunFirst: true };
  }
  const arrival = ARRIVAL_RE.exec(text);
  if (arrival) {
    const loginEdge = Object.values(map.edges).find((e) => e.authFormLocators);
    const loginPage = loginEdge ? map.pages[loginEdge.fromPageId] : undefined;
    const bouncedToLogin = loginPage?.sampleUrls.some((u) => text.includes(u.replace(/\/$/, ""))) ?? false;
    return bouncedToLogin
      ? { category: "session", reason: `Expected "${arrival[1]}" but landed on the login page — the saved session is probably stale.`, rerunFirst: true }
      : { category: "navigation", reason: `Didn't arrive on "${arrival[1]}" — a redirect, or the page needs prior state.`, rerunFirst: false };
  }
  if (STRICT_RE.test(text)) {
    return { category: "locator-ambiguous", reason: "A locator matched more than one element — it needs to be more specific.", rerunFirst: false };
  }
  if (URL_EXPECT_RE.test(text)) {
    const expected = EXPECTED_PATTERN_RE.exec(text)?.[2];
    const received = RECEIVED_RE.exec(text)?.[1];
    if (expected && received && unescapeHost(expected) !== received) {
      return {
        category: "navigation",
        reason: `Expected to reach ${unescapeHost(expected)} but stayed on ${received} — the link may open a new tab, or not navigate at all.`,
        rerunFirst: false,
      };
    }
  }
  if (VALUE_EXPECT_RE.test(text)) {
    return { category: "assertion", reason: "An element was found but its value differs from what the test expects.", rerunFirst: false };
  }
  if (WAITING_RE.test(text) && TIMEOUT_RE.test(text) && /locator resolved to/.test(text)) {
    return {
      category: "environment",
      reason: "The element was found but never became ready to act on — a slow page, an animation or an overlay; try a rerun first.",
      rerunFirst: true,
    };
  }
  if (WAITING_RE.test(text) && TIMEOUT_RE.test(text)) {
    return { category: "locator-missing", reason: "Timed out waiting for an element — its locator may no longer match the page.", rerunFirst: false };
  }
  if (CLOSED_RE.test(text)) {
    return { category: "environment", reason: "The browser connection dropped mid-test — usually the site or network, not the test.", rerunFirst: true };
  }
  return { category: "unknown", reason: "No rule matched — the triage agent can look at the page and the trace.", rerunFirst: false };
}
