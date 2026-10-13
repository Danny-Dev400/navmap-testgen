import type { Edge, Node } from "@xyflow/react";
import type { ActionEdge, IntentCategory, PageNode } from "../../src/navmap-types";
import type { NavMapEdgeData, NavMapNodeData, PageClusterNodeData, PageNodeData } from "./navmapGraph";

export type AuthFilter = "all" | "public" | "auth";

export interface NavMapFilterState {
  searchText: string;
  activeCategories: ReadonlySet<IntentCategory>;
  authFilter: AuthFilter;
  staleOnly: boolean;
  /** Exact-id spotlight set from a catalog "Highlight" action, bypassing every other filter
   *  below — set this way because a UI component's elements can have different semanticIntents,
   *  so text search can't express "highlight exactly these edges" the way it can for a single
   *  repeated action. null means no active highlight (the normal filter logic applies). */
  highlightEdgeIds: ReadonlySet<string> | null;
}

/** Same freshness definition the skill's own coverage-prioritization step already uses: not
 *  verified within today (compared on the ISO date prefix — avoids timezone-parsing ambiguity;
 *  this is a human-facing filter, not the skill's own re-walk decision, so a same-day-boundary
 *  mismatch between the two is cosmetic, not a correctness bug). */
export function isStale(lastVerifiedAt: string, now: Date = new Date()): boolean {
  return lastVerifiedAt.slice(0, 10) !== now.toISOString().slice(0, 10);
}

function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function pageMatchesSearch(page: PageNode, searchText: string): boolean {
  const q = searchText.trim();
  return q !== "" && (includesCI(page.title, q) || includesCI(page.urlPattern, q));
}

export function edgeMatchesSearch(edge: ActionEdge, searchText: string): boolean {
  const q = searchText.trim();
  return q !== "" && includesCI(edge.semanticIntent, q);
}

function authOk(requiresAuth: boolean | undefined, filter: AuthFilter): boolean {
  if (filter === "all") return true;
  return filter === "auth" ? !!requiresAuth : !requiresAuth;
}

export function pageMatchesFilters(page: PageNode, filters: NavMapFilterState): boolean {
  const searchOk = filters.searchText.trim() === "" || pageMatchesSearch(page, filters.searchText);
  const staleOk = !filters.staleOnly || isStale(page.lastVerifiedAt);
  return searchOk && authOk(page.requiresAuth, filters.authFilter) && staleOk;
}

export function edgeMatchesFilters(edge: ActionEdge, filters: NavMapFilterState): boolean {
  const searchOk = filters.searchText.trim() === "" || edgeMatchesSearch(edge, filters.searchText);
  const categoryOk = filters.activeCategories.size === 0 || filters.activeCategories.has(edge.intentCategory);
  const staleOk = !filters.staleOnly || isStale(edge.lastVerifiedAt);
  return searchOk && categoryOk && authOk(edge.requiresAuth, filters.authFilter) && staleOk;
}

/** Full-opacity ("lit") vs dimmed, for the already-laid-out rendered graph. Takes no
 *  NavigationMap — every PageNode/ActionEdge needed is already embedded in the rendered
 *  nodes'/edges' `data`, so this is a pure pass over what's on screen, safe to call on every
 *  keystroke. A `kind:"merged"` rendered edge matches if ANY of its member ActionEdges matches.
 *  A collapsed cluster node matches if ANY member page or member-touching edge matches. When
 *  every filter is inactive, every predicate is vacuously true, so both sets come back empty —
 *  "nothing dimmed" falls out for free, no special case needed. */
export function computeDimming(
  nodes: Node<NavMapNodeData>[],
  edges: Edge<NavMapEdgeData>[],
  filters: NavMapFilterState,
): { dimmedNodeIds: ReadonlySet<string>; dimmedEdgeIds: ReadonlySet<string> } {
  if (filters.highlightEdgeIds) {
    const highlightIds = filters.highlightEdgeIds;
    const litEdgeIds = new Set<string>();
    const litNodeIds = new Set<string>();
    for (const edge of edges) {
      const data = edge.data;
      const matches =
        data?.kind === "single"
          ? highlightIds.has(data.edge.id)
          : data?.kind === "merged"
            ? data.memberEdges.some((e) => highlightIds.has(e.id))
            : false;
      if (matches) {
        litEdgeIds.add(edge.id);
        litNodeIds.add(edge.source);
        litNodeIds.add(edge.target);
      }
    }
    const dimmedNodeIds = new Set(
      nodes.filter((n) => (n.type === "pageNode" || n.type === "pageCluster") && !litNodeIds.has(n.id)).map((n) => n.id),
    );
    const dimmedEdgeIds = new Set(edges.filter((e) => !litEdgeIds.has(e.id)).map((e) => e.id));
    return { dimmedNodeIds, dimmedEdgeIds };
  }

  const matchingEdgeIds = new Set<string>();
  const litNodeIds = new Set<string>();

  for (const edge of edges) {
    const data = edge.data;
    const matches =
      data?.kind === "single"
        ? edgeMatchesFilters(data.edge, filters)
        : data?.kind === "merged"
          ? data.memberEdges.some((e) => edgeMatchesFilters(e, filters))
          : false;
    if (matches) {
      matchingEdgeIds.add(edge.id);
      litNodeIds.add(edge.source);
      litNodeIds.add(edge.target);
    }
  }

  for (const node of nodes) {
    const matches =
      node.type === "pageNode"
        ? pageMatchesFilters((node.data as PageNodeData).page, filters)
        : node.type === "pageCluster"
          ? (node.data as PageClusterNodeData).memberPages.some((p) => pageMatchesFilters(p, filters))
          : false;
    if (matches) litNodeIds.add(node.id);
  }

  const dimmedNodeIds = new Set(
    nodes.filter((n) => (n.type === "pageNode" || n.type === "pageCluster") && !litNodeIds.has(n.id)).map((n) => n.id),
  );
  const dimmedEdgeIds = new Set(edges.filter((e) => !matchingEdgeIds.has(e.id)).map((e) => e.id));
  return { dimmedNodeIds, dimmedEdgeIds };
}
