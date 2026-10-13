import type { Edge, Node } from "@xyflow/react";
import type { ActionEdge, IntentCategory, NavigationMap, PageNode } from "../../src/navmap-types";
import { buildPageIdToGroup, computeClusters, countCrossingEdges, groupNodeId } from "./navmapClusters";
import { buildEdgeIdToComponentId, type ComponentAction } from "../../src/navmapComponents";
import { buildEdgeIdToUiComponentId, type UiComponent } from "../../src/navmapUiComponents";

export interface PageNodeData extends Record<string, unknown> {
  page: PageNode;
  outgoingCount: number;
  isEntry: boolean;
  dimmed?: boolean;
}

export interface PageClusterNodeData extends Record<string, unknown> {
  groupName: string;
  memberPages: PageNode[];
  crossingEdgeCount: number;
  isEntry: boolean;
  dimmed?: boolean;
}

export interface ClusterGroupNodeData extends Record<string, unknown> {
  groupName: string;
  memberCount: number;
  onCollapse: () => void;
}

export type NavMapNodeData = PageNodeData | PageClusterNodeData | ClusterGroupNodeData;

interface Point {
  x: number;
  y: number;
}

export type NavMapEdgeData =
  | {
      kind: "single";
      edge: ActionEdge;
      componentId?: string;
      uiComponentId?: string;
      points?: Point[];
      labelPosition?: Point;
      isBackward?: boolean;
      dimmed?: boolean;
      /** Touches the selected page (drawn bolder). */
      emphasized?: boolean;
    }
  | {
      kind: "merged";
      memberEdges: ActionEdge[];
      commonCategory?: IntentCategory;
      hasComponentMember?: boolean;
      hasUiComponentMember?: boolean;
      points?: Point[];
      labelPosition?: Point;
      isBackward?: boolean;
      dimmed?: boolean;
      /** Touches the selected page (drawn bolder). */
      emphasized?: boolean;
    };

/** Resolves a raw page id to whatever node id actually renders it right now — itself if
 *  ungrouped or in an expanded group, or its collapsed cluster container id otherwise.
 *  Exported so entry-pin resolution and edge-endpoint resolution share one definition of
 *  "what currently represents this page" and can never drift apart. */
export function resolveRenderedNodeId(
  pageId: string,
  pageIdToGroup: ReadonlyMap<string, string>,
  expandedGroups: ReadonlySet<string>,
): string {
  const groupName = pageIdToGroup.get(pageId);
  if (!groupName || expandedGroups.has(groupName)) return pageId;
  return groupNodeId(groupName);
}

export function buildNavMapGraph(
  map: NavigationMap,
  expandedGroups: ReadonlySet<string>,
  onCollapseGroup: (groupName: string) => void,
  components: Map<string, ComponentAction>,
  uiComponents: Map<string, UiComponent>,
): { nodes: Node<NavMapNodeData>[]; edges: Edge<NavMapEdgeData>[]; entryNodeId: string | null } {
  const outgoingCounts = new Map<string, number>();
  for (const edge of Object.values(map.edges)) {
    outgoingCounts.set(edge.fromPageId, (outgoingCounts.get(edge.fromPageId) ?? 0) + 1);
  }

  const clusters = computeClusters(map);
  const pageIdToGroup = buildPageIdToGroup(clusters);
  const edgeIdToComponentId = buildEdgeIdToComponentId(components);
  const edgeIdToUiComponentId = buildEdgeIdToUiComponentId(uiComponents);

  const nodes: Node<NavMapNodeData>[] = [];

  for (const page of Object.values(map.pages)) {
    if (pageIdToGroup.has(page.id)) continue; // handled in the cluster loop below
    nodes.push({
      id: page.id,
      type: "pageNode",
      position: { x: 0, y: 0 },
      data: { page, outgoingCount: outgoingCounts.get(page.id) ?? 0, isEntry: page.id === map.entryPageId },
    });
  }

  for (const cluster of clusters.values()) {
    const containerId = groupNodeId(cluster.groupName);
    const clusterIsEntry = !!map.entryPageId && cluster.memberIds.includes(map.entryPageId);
    if (expandedGroups.has(cluster.groupName)) {
      nodes.push({
        id: containerId,
        type: "group",
        position: { x: 0, y: 0 },
        data: {
          groupName: cluster.groupName,
          memberCount: cluster.memberIds.length,
          onCollapse: () => onCollapseGroup(cluster.groupName),
        },
      });
      for (const pageId of cluster.memberIds) {
        const page = map.pages[pageId];
        nodes.push({
          id: page.id,
          type: "pageNode",
          position: { x: 0, y: 0 },
          parentId: containerId,
          extent: "parent",
          data: { page, outgoingCount: outgoingCounts.get(page.id) ?? 0, isEntry: page.id === map.entryPageId },
        });
      }
    } else {
      nodes.push({
        id: containerId,
        type: "pageCluster",
        position: { x: 0, y: 0 },
        data: {
          groupName: cluster.groupName,
          memberPages: cluster.memberIds.map((id) => map.pages[id]),
          crossingEdgeCount: countCrossingEdges(map, cluster),
          isEntry: clusterIsEntry,
        },
      });
    }
  }

  // Same-page actions (fromPageId === toPageId) aren't drawn on the canvas — React Flow's
  // default bezier routing doesn't produce a clean loop for them, and they're already listed
  // under "Actions from this page" when a page node is clicked.
  const navigationEdges = Object.values(map.edges).filter((edge) => edge.fromPageId !== edge.toPageId);

  const resolveEndpoint = (pageId: string) => resolveRenderedNodeId(pageId, pageIdToGroup, expandedGroups);

  const singles: Edge<NavMapEdgeData>[] = [];
  const toMerge = new Map<string, { source: string; target: string; members: ActionEdge[] }>();

  for (const edge of navigationEdges) {
    const source = resolveEndpoint(edge.fromPageId);
    const target = resolveEndpoint(edge.toPageId);
    if (source === target) continue; // both endpoints collapsed into the same cluster — omit, same rule as self-loops

    const touched = source !== edge.fromPageId || target !== edge.toPageId;
    if (!touched) {
      singles.push({
        id: edge.id,
        source,
        target,
        label: edge.semanticIntent,
        type: "routed",
        data: {
          kind: "single",
          edge,
          componentId: edgeIdToComponentId.get(edge.id),
          uiComponentId: edgeIdToUiComponentId.get(edge.id),
        },
      });
      continue;
    }

    const key = `${source}->${target}`;
    const bucket = toMerge.get(key) ?? { source, target, members: [] };
    bucket.members.push(edge);
    toMerge.set(key, bucket);
  }

  const resolvedTouched: Edge<NavMapEdgeData>[] = [...toMerge.values()].map((bucket) => {
    if (bucket.members.length === 1) {
      const edge = bucket.members[0];
      return {
        id: edge.id,
        source: bucket.source,
        target: bucket.target,
        label: edge.semanticIntent,
        type: "routed",
        data: {
          kind: "single",
          edge,
          componentId: edgeIdToComponentId.get(edge.id),
          uiComponentId: edgeIdToUiComponentId.get(edge.id),
        },
      };
    }
    const categories = new Set(bucket.members.map((e) => e.intentCategory));
    const commonCategory = categories.size === 1 ? bucket.members[0].intentCategory : undefined;
    const hasComponentMember = bucket.members.some((e) => edgeIdToComponentId.has(e.id));
    const hasUiComponentMember = bucket.members.some((e) => edgeIdToUiComponentId.has(e.id));
    return {
      id: `merged:${bucket.source}->${bucket.target}`,
      source: bucket.source,
      target: bucket.target,
      label: `${bucket.members.length} actions`,
      type: "routed",
      data: { kind: "merged", memberEdges: bucket.members, commonCategory, hasComponentMember, hasUiComponentMember },
    };
  });

  const edges = [...singles, ...resolvedTouched];

  const entryNodeId = map.entryPageId && map.pages[map.entryPageId] ? resolveRenderedNodeId(map.entryPageId, pageIdToGroup, expandedGroups) : null;

  return { nodes, edges, entryNodeId };
}

/** Structural subgraph extraction for focus mode: focusNodeId + its direct neighbors + the
 *  connecting edges, run on buildNavMapGraph's output before layoutWithElk, so ELK only lays
 *  out the focused subgraph. Strips parentId/extent from any kept node (a lone surviving member
 *  of what used to be a cluster group is more confusing boxed than not — focus mode's entire
 *  purpose is decluttering). Falls back to the unfiltered graph if focusNodeId isn't currently
 *  rendered (e.g. a stale id after a concurrent expand/collapse) rather than an empty canvas. */
export function extractFocusSubgraph(
  nodes: Node<NavMapNodeData>[],
  edges: Edge<NavMapEdgeData>[],
  focusNodeId: string,
): { nodes: Node<NavMapNodeData>[]; edges: Edge<NavMapEdgeData>[] } {
  if (!nodes.some((n) => n.id === focusNodeId)) return { nodes, edges };

  const keptEdges = edges.filter((e) => e.source === focusNodeId || e.target === focusNodeId);
  const keptIds = new Set<string>([focusNodeId]);
  for (const e of keptEdges) {
    keptIds.add(e.source);
    keptIds.add(e.target);
  }
  const keptNodes = nodes.filter((n) => keptIds.has(n.id)).map((n) => ({ ...n, parentId: undefined, extent: undefined }));
  return { nodes: keptNodes, edges: keptEdges };
}
