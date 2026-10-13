import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import type { NavMapEdgeData, NavMapNodeData } from "./navmapGraph";

const elk = new ELK();

interface ElkPoint {
  x: number;
  y: number;
}
interface ElkLabelInput {
  text: string;
  width: number;
  height: number;
}
interface ElkEdgeInput {
  id: string;
  sources: string[];
  targets: string[];
  labels?: ElkLabelInput[];
}
interface ElkNodeInput {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNodeInput[];
  edges?: ElkEdgeInput[];
}
interface ElkGraphInput {
  id: string;
  layoutOptions: Record<string, string>;
  children: ElkNodeInput[];
  edges: ElkEdgeInput[];
}

interface ElkEdgeSection {
  startPoint: ElkPoint;
  endPoint: ElkPoint;
  bendPoints?: ElkPoint[];
}
interface ElkLabelResult extends ElkLabelInput {
  x: number;
  y: number;
}
interface ElkEdgeResult extends ElkEdgeInput {
  sections?: ElkEdgeSection[];
  labels?: ElkLabelResult[];
  container?: string;
}
interface ElkNodeResult {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children?: ElkNodeResult[];
  edges?: ElkEdgeResult[];
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 76; // must equal .map-node's CSS height
const CLUSTER_NODE_WIDTH = 220;
const CLUSTER_NODE_HEIGHT = 84; // must equal .map-cluster's CSS height
const GROUP_HEADER_HEIGHT = 36; // must equal .map-group-header's CSS height exactly
const GROUP_PADDING = { top: GROUP_HEADER_HEIGHT + 4, left: 14, bottom: 14, right: 14 };

const LABEL_CHAR_WIDTH = 6.5;
const LABEL_H_PADDING = 14;
const LABEL_HEIGHT = 20;

function estimateLabelSize(text: string | undefined): { width: number; height: number } {
  if (!text) return { width: 0, height: 0 };
  return { width: Math.ceil(text.length * LABEL_CHAR_WIDTH) + LABEL_H_PADDING, height: LABEL_HEIGHT };
}

const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.mergeEdges": "false",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "80",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.edgeNode": "30",
  "elk.spacing.edgeEdge": "20",
  "elk.spacing.edgeLabel": "8",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
  "elk.edgeLabels.inline": "false",
};

function buildElkInput(nodes: Node<NavMapNodeData>[], edges: Edge<NavMapEdgeData>[], pinnedNodeId: string | null): ElkGraphInput {
  const childrenByParent = new Map<string | undefined, Node<NavMapNodeData>[]>();
  for (const node of nodes) {
    const key = node.parentId;
    const arr = childrenByParent.get(key) ?? [];
    arr.push(node);
    childrenByParent.set(key, arr);
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // If the pinned node is nested inside an expanded cluster, its group container must ALSO be
  // pinned — pinning the child alone only wins the layout inside the group's own sub-layout,
  // not placement among top-level siblings (empirically confirmed against elkjs@0.12.0: a
  // group containing a pinned child did not reliably land first on its own).
  const pinnedIds = new Set<string>();
  if (pinnedNodeId) {
    const pinnedNode = nodeById.get(pinnedNodeId);
    if (pinnedNode) {
      pinnedIds.add(pinnedNodeId);
      if (pinnedNode.parentId) pinnedIds.add(pinnedNode.parentId);
    }
  }
  const edgesByContainer = new Map<string | undefined, ElkEdgeInput[]>();
  for (const e of edges) {
    const sourceParent = nodeById.get(e.source)?.parentId;
    const targetParent = nodeById.get(e.target)?.parentId;
    const container = sourceParent && sourceParent === targetParent ? sourceParent : undefined;
    const labelText = typeof e.label === "string" ? e.label : undefined;
    const elkEdge: ElkEdgeInput = {
      id: e.id,
      sources: [e.source],
      targets: [e.target],
      ...(labelText ? { labels: [{ text: labelText, ...estimateLabelSize(labelText) }] } : {}),
    };
    const arr = edgesByContainer.get(container) ?? [];
    arr.push(elkEdge);
    edgesByContainer.set(container, arr);
  }

  function buildNode(node: Node<NavMapNodeData>): ElkNodeInput {
    const layerConstraint: Record<string, string> = pinnedIds.has(node.id) ? { "elk.layered.layering.layerConstraint": "FIRST" } : {};
    if (node.type === "group") {
      const kids = childrenByParent.get(node.id) ?? [];
      return {
        id: node.id,
        layoutOptions: {
          "elk.padding": `[top=${GROUP_PADDING.top},left=${GROUP_PADDING.left},bottom=${GROUP_PADDING.bottom},right=${GROUP_PADDING.right}]`,
          ...layerConstraint,
        },
        children: kids.map(buildNode),
        edges: edgesByContainer.get(node.id) ?? [],
      };
    }
    const size = node.type === "pageCluster" ? { width: CLUSTER_NODE_WIDTH, height: CLUSTER_NODE_HEIGHT } : { width: NODE_WIDTH, height: NODE_HEIGHT };
    return { id: node.id, ...size, ...(Object.keys(layerConstraint).length ? { layoutOptions: layerConstraint } : {}) };
  }

  const topLevelNodes = childrenByParent.get(undefined) ?? [];
  const hasHierarchy = nodes.some((n) => n.parentId);

  return {
    id: "root",
    layoutOptions: { ...LAYOUT_OPTIONS, ...(hasHierarchy ? { "elk.hierarchyHandling": "INCLUDE_CHILDREN" } : {}) },
    children: topLevelNodes.map(buildNode),
    edges: edgesByContainer.get(undefined) ?? [],
  };
}

function collectNodes(node: ElkNodeResult, out: Map<string, ElkNodeResult>) {
  out.set(node.id, node);
  for (const child of node.children ?? []) collectNodes(child, out);
}

function collectEdges(node: ElkNodeResult, out: Map<string, ElkEdgeResult>) {
  for (const edge of node.edges ?? []) out.set(edge.id, edge);
  for (const child of node.children ?? []) collectEdges(child, out);
}

/** Every node's canvas-absolute top-left position, found by walking the parentId chain and
 *  summing offsets — ELK's own per-node x/y is parent-relative (matching React Flow's own
 *  parentId convention, so RF node.position uses those raw values unconverted), but edges
 *  declared inside a group and the isBackward direction check both need true absolute coordinates. */
function computeAbsolutePositions(root: ElkNodeResult): Map<string, ElkPoint> {
  const absolute = new Map<string, ElkPoint>();
  function walk(node: ElkNodeResult, parentAbsX: number, parentAbsY: number) {
    const absX = parentAbsX + node.x;
    const absY = parentAbsY + node.y;
    absolute.set(node.id, { x: absX, y: absY });
    for (const child of node.children ?? []) walk(child, absX, absY);
  }
  walk(root, 0, 0);
  return absolute;
}

export async function layoutWithElk(
  nodes: Node<NavMapNodeData>[],
  edges: Edge<NavMapEdgeData>[],
  pinnedNodeId: string | null = null,
): Promise<{ nodes: Node<NavMapNodeData>[]; edges: Edge<NavMapEdgeData>[] }> {
  const graph = buildElkInput(nodes, edges, pinnedNodeId);
  const result = (await elk.layout(graph as never)) as unknown as ElkNodeResult;

  const nodeResultById = new Map<string, ElkNodeResult>();
  collectNodes(result, nodeResultById);
  const edgeResultById = new Map<string, ElkEdgeResult>();
  collectEdges(result, edgeResultById);
  const absolutePositions = computeAbsolutePositions(result);

  const laidOutNodes = nodes.map((n) => {
    const resolved = nodeResultById.get(n.id);
    if (!resolved) return n;
    // ELK's resolved x/y is relative to the node's own parent (root-relative for top-level
    // nodes) — the same convention React Flow's parentId positioning expects, so no
    // conversion is applied here (only the absolute-coordinate helpers above do that).
    // Explicit width/height: the canvas is controlled (no onNodesChange), so React Flow never writes
    // measured sizes back — and the minimap draws only nodes whose size it knows.
    const updated: Node<NavMapNodeData> = { ...n, position: { x: resolved.x, y: resolved.y }, width: resolved.width, height: resolved.height };
    if (n.type === "group") {
      updated.style = { ...updated.style, width: resolved.width, height: resolved.height };
    }
    return updated;
  });

  const laidOutEdges = edges.map((e) => {
    const resolved = edgeResultById.get(e.id);
    const section = resolved?.sections?.[0];
    if (!section) return e;

    // An edge declared at root (resolved.container is "root" or absent) is already in
    // absolute/canvas coordinates, even when one endpoint is nested, thanks to
    // elk.hierarchyHandling — confirmed empirically against the installed elkjs version.
    // An edge declared inside a group is in that group's local frame and needs the
    // group's own resolved absolute position added to every point.
    const containerId = resolved?.container;
    const offset = containerId && containerId !== "root" ? absolutePositions.get(containerId) : undefined;
    const toAbs = (p: ElkPoint) => (offset ? { x: p.x + offset.x, y: p.y + offset.y } : { x: p.x, y: p.y });

    const points = [toAbs(section.startPoint), ...(section.bendPoints ?? []).map(toAbs), toAbs(section.endPoint)];
    const labelBox = resolved?.labels?.[0];
    const labelPosition = labelBox ? toAbs({ x: labelBox.x + labelBox.width / 2, y: labelBox.y + labelBox.height / 2 }) : undefined;

    const sourceAbs = absolutePositions.get(e.source);
    const targetAbs = absolutePositions.get(e.target);
    const isBackward = !!sourceAbs && !!targetAbs && targetAbs.x <= sourceAbs.x;

    return { ...e, data: { ...e.data!, points, labelPosition, isBackward } };
  });

  return { nodes: laidOutNodes, edges: laidOutEdges };
}
