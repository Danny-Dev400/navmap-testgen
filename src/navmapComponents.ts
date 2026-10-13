import type { ActionEdge, IntentCategory, Locator, NavigationMap } from "./navmap-types.js";
import { slugify } from "./navmap-ids.js";

export interface ComponentAction {
  id: string;
  label: string;
  intentCategory: IntentCategory;
  locator: Locator;
  memberEdges: ActionEdge[];
  pageIds: string[];
  targetPageIds: string[];
}

/** One string per Locator variant, strategy-prefixed so values from different strategies can
 *  never collide. This is the "DOM fingerprint" half of the detection key. */
export function locatorFingerprint(locator: Locator): string {
  switch (locator.strategy) {
    case "role":
      return `role:${locator.role}:${locator.name ?? ""}:${locator.exact ? "1" : "0"}`;
    case "text":
      return `text:${locator.text}:${locator.exact ? "1" : "0"}`;
    case "label":
      return `label:${locator.label}`;
    case "placeholder":
      return `placeholder:${locator.placeholder}`;
    case "testId":
      return `testId:${locator.testId}`;
    case "css":
      return `css:${locator.css}`;
  }
}

export function componentActionId(semanticIntent: string, locator: Locator): string {
  return `component:${slugify(semanticIntent)}:${slugify(locatorFingerprint(locator))}`;
}

/** Two ActionEdges are "the same component action" iff they share both locator fingerprint AND
 *  semanticIntent, and that pair occurs as an outgoing edge from 2+ distinct fromPageIds — same
 *  >=2 threshold precedent as computeClusters' memberIds.length >= 2.
 *
 *  label: never "mixed" — semanticIntent is part of the grouping key, so every member has a
 *  byte-identical semanticIntent. intentCategory: not part of the key, so members could in
 *  principle disagree, but it's meant to be a deterministic classification of a given
 *  semanticIntent — just take members[0] rather than invent a "mixed" fallback for a case that
 *  shouldn't occur. targetPageIds: deliberately NOT part of the key and NOT a filter — a
 *  context-sensitive component (e.g. "Cancel checkout" returning to wherever checkout started)
 *  is still one real reusable component with branching behavior; excluding on target-variance
 *  would throw away true positives. Exposed for display only. */
export function computeComponents(map: NavigationMap): Map<string, ComponentAction> {
  const byKey = new Map<string, ActionEdge[]>();
  for (const edge of Object.values(map.edges)) {
    const key = `${locatorFingerprint(edge.locator)}::${edge.semanticIntent}`;
    const bucket = byKey.get(key) ?? [];
    bucket.push(edge);
    byKey.set(key, bucket);
  }

  const components = new Map<string, ComponentAction>();
  for (const members of byKey.values()) {
    const pageIds = [...new Set(members.map((e) => e.fromPageId))].sort();
    if (pageIds.length < 2) continue;
    const targetPageIds = [...new Set(members.map((e) => e.toPageId))].sort();
    const first = members[0];
    const id = componentActionId(first.semanticIntent, first.locator);
    components.set(id, {
      id,
      label: first.semanticIntent,
      intentCategory: first.intentCategory,
      locator: first.locator,
      memberEdges: members,
      pageIds,
      targetPageIds,
    });
  }
  return components;
}

/** Reverse index: every member edge's id -> its component's id. Mirrors buildPageIdToGroup's
 *  precedent (primary compute function + a small reverse-lookup helper next to it). */
export function buildEdgeIdToComponentId(components: Map<string, ComponentAction>): Map<string, string> {
  const map = new Map<string, string>();
  for (const component of components.values()) {
    for (const edge of component.memberEdges) map.set(edge.id, component.id);
  }
  return map;
}
