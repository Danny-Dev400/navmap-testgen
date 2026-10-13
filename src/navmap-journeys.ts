import { createHash } from "node:crypto";
import type { NavigationMap } from "./navmap-types.js";
import type { CasePlan } from "./navmap-test-generator.js";

/** End-to-end journeys through the map — no AI. A journey is a maximal simple path of
 *  page-changing actions from the entry page: it keeps going while it reaches pages it hasn't
 *  visited and ends at a page with nowhere new to go (e.g. an order confirmation). Logout and
 *  external links are left out; one journey is kept per distinct goal page first, so menus that
 *  reach everything don't multiply near-identical journeys. */

export interface Journey {
  id: string;
  pages: string[];
  edges: string[];
}

const MAX_DEPTH = 10;
const MAX_JOURNEYS = 25;
const MAX_PATHS_EXPLORED = 5000;

export function computeJourneys(map: NavigationMap): Journey[] {
  const start = map.entryPageId && map.pages[map.entryPageId] ? map.entryPageId : Object.keys(map.pages)[0];
  if (!start) return [];
  const out = new Map<string, string[]>(); // pages key -> edges
  const outPages = new Map<string, string[]>();
  let explored = 0;

  const exits = (pageId: string) =>
    Object.values(map.edges).filter(
      (e) =>
        e.fromPageId === pageId &&
        e.toPageId !== e.fromPageId &&
        !e.external &&
        !(e.intentCategory === "auth" && !e.authFormLocators) && // logout-like
        !!map.pages[e.toPageId],
    );

  const walk = (pages: string[], edges: string[]) => {
    if (++explored > MAX_PATHS_EXPLORED) return;
    const here = pages[pages.length - 1];
    const next = pages.length > MAX_DEPTH ? [] : exits(here).filter((e) => !pages.includes(e.toPageId));
    if (next.length === 0) {
      if (edges.length > 0) {
        const key = pages.join(">");
        if (!out.has(key)) {
          out.set(key, edges);
          outPages.set(key, pages);
        }
      }
      return;
    }
    for (const e of next) walk([...pages, e.toPageId], [...edges, e.id]);
  };
  walk([start], []);

  // Prefer distinct goal pages: the longest journey to each goal first, then the rest by length.
  const all = [...out.keys()].map((key) => ({ key, pages: outPages.get(key)!, edges: out.get(key)! }));
  all.sort((a, b) => b.edges.length - a.edges.length);
  const picked: typeof all = [];
  const goals = new Set<string>();
  for (const j of all) {
    const goal = j.pages[j.pages.length - 1];
    if (!goals.has(goal)) {
      goals.add(goal);
      picked.push(j);
    }
  }
  for (const j of all) if (picked.length < MAX_JOURNEYS && !picked.includes(j)) picked.push(j);
  return picked.slice(0, MAX_JOURNEYS).map((j) => ({ id: createHash("sha1").update(j.key).digest("hex").slice(0, 12), pages: j.pages, edges: j.edges }));
}

/** The actions an approved case executes, in order (setup from precondition links, required
 *  cases' steps, its own steps). */
export function executedEdges(plan: CasePlan): string[] {
  return [...plan.setup.map((s) => s.edge.id), ...plan.steps.map((s) => s.edge.id)];
}

export interface JourneyCoverage extends Journey {
  covered: boolean;
  coveredBy: string[];
  /** Share of the journey's actions that some approved case executes (0–1). */
  partial: number;
}

/** A case covers a journey when it executes the journey's actions in order (other actions in
 *  between are fine). The login action is skipped when matching: tests start with a saved session
 *  instead of logging in, so a journey through login is covered by the cases after it. */
export function journeyCoverage(map: NavigationMap, journeys: Journey[], approvedPlans: { caseId: string; plan: CasePlan }[]): {
  journeys: JourneyCoverage[];
  edgeCoverage: Record<string, number>;
} {
  const edgeCoverage: Record<string, number> = {};
  const sequences = approvedPlans.map(({ caseId, plan }) => {
    const seq = executedEdges(plan);
    for (const id of new Set(seq)) edgeCoverage[id] = (edgeCoverage[id] ?? 0) + 1;
    return { caseId, seq };
  });
  const isLogin = (id: string) => !!map.edges[id]?.authFormLocators;
  const inOrder = (needle: string[], hay: string[]) => {
    let i = 0;
    for (const id of hay) if (id === needle[i]) i++;
    return i === needle.length;
  };
  return {
    edgeCoverage,
    journeys: journeys.map((j) => {
      const needle = j.edges.filter((id) => !isLogin(id));
      const coveredBy = needle.length ? sequences.filter((s) => inOrder(needle, s.seq)).map((s) => s.caseId) : [];
      const touched = needle.filter((id) => edgeCoverage[id]).length;
      return { ...j, covered: coveredBy.length > 0, coveredBy, partial: needle.length ? touched / needle.length : 0 };
    }),
  };
}
