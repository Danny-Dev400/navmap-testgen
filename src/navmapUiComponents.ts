import type { ActionEdge, IntentCategory, Locator, NavigationMap } from "./navmap-types.js";
import { slugify } from "./navmap-ids.js";
import { componentActionId, locatorFingerprint } from "./navmapComponents.js";

export interface UiComponentElement {
  id: string;
  label: string;
  intentCategory: IntentCategory;
  locator: Locator;
  memberEdges: ActionEdge[];
  pageIds: string[];
  targetPageIds: string[];
}

export interface UiComponent {
  id: string;
  regionName: string;
  elements: UiComponentElement[];
  pageIds: string[];
}

export function uiComponentId(regionName: string): string {
  return `uiregion:${slugify(regionName)}`;
}

/** A UiComponent is an explicitly-tagged structural region (ActionEdge.uiRegion) — e.g. a
 *  navbar's several distinct links — reused across 2+ distinct fromPageIds *at the region
 *  level* (same >=2 threshold precedent as computeClusters/computeComponents, just applied to
 *  the whole region's edges rather than one element at a time). An individual element inside a
 *  qualifying region does NOT need its own >=2 pages — e.g. a "Logout" link might only ever get
 *  clicked once during exploration but is still structurally part of the shared navbar. */
export function computeUiComponents(map: NavigationMap): Map<string, UiComponent> {
  const byRegion = new Map<string, ActionEdge[]>();
  for (const edge of Object.values(map.edges)) {
    if (!edge.uiRegion) continue;
    const bucket = byRegion.get(edge.uiRegion) ?? [];
    bucket.push(edge);
    byRegion.set(edge.uiRegion, bucket);
  }

  const components = new Map<string, UiComponent>();
  for (const [regionName, regionEdges] of byRegion) {
    const pageIds = [...new Set(regionEdges.map((e) => e.fromPageId))].sort();
    if (pageIds.length < 2) continue;

    const byElement = new Map<string, ActionEdge[]>();
    for (const edge of regionEdges) {
      const key = `${locatorFingerprint(edge.locator)}::${edge.semanticIntent}`;
      const bucket = byElement.get(key) ?? [];
      bucket.push(edge);
      byElement.set(key, bucket);
    }

    const elements: UiComponentElement[] = [...byElement.values()].map((members) => {
      const first = members[0];
      return {
        id: componentActionId(first.semanticIntent, first.locator),
        label: first.semanticIntent,
        intentCategory: first.intentCategory,
        locator: first.locator,
        memberEdges: members,
        pageIds: [...new Set(members.map((e) => e.fromPageId))].sort(),
        targetPageIds: [...new Set(members.map((e) => e.toPageId))].sort(),
      };
    });

    const id = uiComponentId(regionName);
    components.set(id, { id, regionName, elements, pageIds });
  }
  return components;
}

/** Reverse index: every member edge's id -> its UiComponent's id. Mirrors
 *  buildEdgeIdToComponentId's precedent. */
export function buildEdgeIdToUiComponentId(components: Map<string, UiComponent>): Map<string, string> {
  const map = new Map<string, string>();
  for (const component of components.values()) {
    for (const element of component.elements) {
      for (const edge of element.memberEdges) map.set(edge.id, component.id);
    }
  }
  return map;
}
