import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ActionEdge, IntentCategory, NavigationMap } from "../../src/navmap-types";
import {
  buildNavMapGraph,
  extractFocusSubgraph,
  type NavMapEdgeData,
  type NavMapNodeData,
  type PageClusterNodeData,
  type PageNodeData,
} from "./navmapGraph";
import { buildPageIdToGroup, computeClusters, groupNodeId } from "./navmapClusters";
import { buildEdgeIdToComponentId, computeComponents } from "../../src/navmapComponents";
import { buildEdgeIdToUiComponentId, computeUiComponents } from "../../src/navmapUiComponents";
import { layoutWithElk } from "./elkLayout";
import { computeDimming, edgeMatchesSearch, pageMatchesSearch, type AuthFilter, type NavMapFilterState } from "./navmapFilters";
import { PageNode } from "./PageNode";
import { PageClusterNode } from "./PageClusterNode";
import { ClusterGroupNode } from "./ClusterGroupNode";
import { EdgeLabelClickContext, RoutedEdge } from "./RoutedEdge";
import { MapLegend, type ColorBy } from "./IntentLegend";
import { NavMapFilterBar } from "./NavMapFilterBar";
import { ComponentsCatalog } from "./ComponentsCatalog";
import { NavMapSidePanel, type ComponentOf, type MapProject, type NavMapSelection } from "./NavMapSidePanel";
import { EdgeResultContext, type ResultKey } from "./resultColors";
import { useAssistant } from "./assistant";
import { Button, PageHeader, Spinner } from "./ui/kit";
import { Icon } from "./ui/icons";

const nodeTypes = { pageNode: PageNode, pageCluster: PageClusterNode, group: ClusterGroupNode };
const edgeTypes = { routed: RoutedEdge };

type MapNode = Node<NavMapNodeData>;
type MapEdge = Edge<NavMapEdgeData>;

type LayoutState =
  | { status: "loading" }
  | { status: "error"; message: string }
  /** gen counts finished layouts, so a camera move can wait for the layout it depends on. */
  | { status: "ready"; nodes: MapNode[]; edges: MapEdge[]; gen: number };

/** A camera move to make once the canvas has laid out what it needs. */
type RevealTarget = { kind: "page"; id: string; force: boolean } | { kind: "edge"; id: string; force: boolean } | { kind: "fit"; nodeId?: string };
type Reveal = RevealTarget & { minGen: number };

function resolveEndpointLabel(id: string, nodes: MapNode[]): string {
  const node = nodes.find((n) => n.id === id);
  if (!node) return id;
  if (node.type === "pageNode") return (node.data as PageNodeData).page.title;
  if (node.type === "pageCluster") {
    const d = node.data as PageClusterNodeData;
    return `${d.groupName} (${d.memberPages.length} pages)`;
  }
  return id;
}

const edgeHasAction = (data: NavMapEdgeData | undefined, actionId: string) =>
  data?.kind === "single" ? data.edge.id === actionId : data?.kind === "merged" ? data.memberEdges.some((e) => e.id === actionId) : false;

export function NavMapApp({
  map,
  edgeStatus,
  edgeCoverage,
  project,
}: {
  map: NavigationMap;
  /** Last test result per edge id; when given, the canvas offers "color by last result". */
  edgeStatus?: Record<string, { status: ResultKey }>;
  /** Approved cases executing each edge; when given, the canvas offers "color by coverage". */
  edgeCoverage?: Record<string, number>;
  /** Inside a project (not a static report): the side panel links to test cases and the Assistant. */
  project?: MapProject;
}) {
  const assistant = useAssistant();
  const [colorBy, setColorBy] = useState<ColorBy>("intent");
  // Coverage reuses the result coloring: covered = green ("passed"), not covered = gray ("never").
  const edgeResults = useMemo(() => {
    if (colorBy === "result" && edgeStatus) return Object.fromEntries(Object.entries(edgeStatus).map(([id, v]) => [id, v.status]));
    if (colorBy === "coverage" && edgeCoverage) {
      return Object.fromEntries(Object.keys(map.edges).map((id): [string, ResultKey] => [id, edgeCoverage[id] ? "passed" : "never"]));
    }
    return null;
  }, [colorBy, edgeStatus, edgeCoverage, map.edges]);
  const lastResults = useMemo(() => (edgeStatus ? Object.fromEntries(Object.entries(edgeStatus).map(([id, v]) => [id, v.status])) : null), [edgeStatus]);
  const [selection, setSelection] = useState<NavMapSelection>(null);
  const [hasSelected, setHasSelected] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [layoutState, setLayoutState] = useState<LayoutState>({ status: "loading" });
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [activeCategories, setActiveCategories] = useState<Set<IntentCategory>>(new Set());
  const [searchText, setSearchText] = useState("");
  const [authFilter, setAuthFilter] = useState<AuthFilter>("all");
  const [staleOnly, setStaleOnly] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [highlight, setHighlight] = useState<{ edgeIds: Set<string>; label: string } | null>(null);

  // Components are a pure property of `map` alone — independent of expandedGroups/focusNodeId/
  // filters — so computed once and shared by both the canvas badges (via buildNavMapGraph) and
  // the catalog panel below, so the two can never disagree.
  const components = useMemo(() => computeComponents(map), [map]);
  const uiComponents = useMemo(() => computeUiComponents(map), [map]);
  const pageIdToGroup = useMemo(() => buildPageIdToGroup(computeClusters(map)), [map]);
  const componentOf = useMemo<ComponentOf>(() => {
    const ui = buildEdgeIdToUiComponentId(uiComponents);
    const repeated = buildEdgeIdToComponentId(components);
    return (edgeId) => {
      const u = uiComponents.get(ui.get(edgeId) ?? "");
      if (u) return { kind: "ui", label: u.regionName };
      const r = components.get(repeated.get(edgeId) ?? "");
      return r ? { kind: "repeated", label: r.label } : null;
    };
  }, [components, uiComponents]);

  // Layout-affecting state: map, expandedGroups, focusNodeId. Search/category/auth/stale are
  // NOT here — they only dim the already-laid-out graph (see below), so they don't trigger a new
  // (async) ELK layout pass on every keystroke. While a new layout computes, the old one stays on
  // screen (no flash, the camera keeps its place).
  const layoutGen = useRef(0);
  useEffect(() => {
    let cancelled = false;
    setLayoutState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    const onCollapseGroup = (groupName: string) => {
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        next.delete(groupName);
        return next;
      });
    };
    const built = buildNavMapGraph(map, expandedGroups, onCollapseGroup, components, uiComponents);
    const { nodes: rawNodes, edges: rawEdges } = focusNodeId ? extractFocusSubgraph(built.nodes, built.edges, focusNodeId) : built;
    layoutWithElk(rawNodes, rawEdges, built.entryNodeId)
      .then(({ nodes, edges }) => {
        if (!cancelled) setLayoutState({ status: "ready", nodes, edges, gen: ++layoutGen.current });
      })
      .catch((err) => {
        if (!cancelled) setLayoutState({ status: "error", message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [map, expandedGroups, focusNodeId, components, uiComponents]);

  // Search-only auto-expand: if a collapsed cluster contains a matching page/action, open it so
  // the match is actually visible. Category/auth/stale deliberately do NOT do this (would blow
  // every cluster open and defeat their decluttering purpose) — they stay pure dimming below.
  useEffect(() => {
    if (searchText.trim() === "") return;
    const clusters = computeClusters(map);
    const toExpand: string[] = [];
    for (const cluster of clusters.values()) {
      if (expandedGroups.has(cluster.groupName)) continue;
      const memberSet = new Set(cluster.memberIds);
      const pageMatch = cluster.memberIds.some((id) => pageMatchesSearch(map.pages[id], searchText));
      const edgeMatch = Object.values(map.edges).some(
        (e) => (memberSet.has(e.fromPageId) || memberSet.has(e.toPageId)) && edgeMatchesSearch(e, searchText),
      );
      if (pageMatch || edgeMatch) toExpand.push(cluster.groupName);
    }
    if (toExpand.length > 0) {
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        for (const g of toExpand) next.add(g);
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, map]);

  const filters: NavMapFilterState = {
    searchText,
    activeCategories,
    authFilter,
    staleOnly,
    highlightEdgeIds: highlight?.edgeIds ?? null,
  };
  const filtersActive = searchText.trim() !== "" || activeCategories.size > 0 || authFilter !== "all" || staleOnly || !!highlight;
  const { dimmedNodeIds, dimmedEdgeIds } = useMemo(
    () =>
      computeDimming(
        layoutState.status === "ready" ? layoutState.nodes : [],
        layoutState.status === "ready" ? layoutState.edges : [],
        filters,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutState, searchText, activeCategories, authFilter, staleOnly, highlight],
  );

  // With no filter on, the selection lights itself and what it connects to; the rest dims.
  const neighborhood = useMemo(() => {
    if (layoutState.status !== "ready" || !selection) return null;
    const nodes = new Set<string>();
    const edges = new Set<string>();
    if (selection.type === "page") {
      const id = selection.page.id;
      if (!layoutState.nodes.some((n) => n.id === id)) return null;
      nodes.add(id);
      for (const e of layoutState.edges) {
        if (e.source === id || e.target === id) {
          edges.add(e.id);
          nodes.add(e.source);
          nodes.add(e.target);
        }
      }
    } else {
      for (const e of layoutState.edges) {
        const hit = selection.type === "edge" ? edgeHasAction(e.data, selection.edge.id) : e.data?.kind === "merged" && e.data.memberEdges === selection.memberEdges;
        if (hit) {
          edges.add(e.id);
          nodes.add(e.source);
          nodes.add(e.target);
        }
      }
      if (edges.size === 0) return null;
    }
    return { nodes, edges };
  }, [layoutState, selection]);

  // ---- camera ----
  const rf = useRef<ReactFlowInstance<MapNode, MapEdge> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  /** How much of the canvas's right side the side panel covers (on narrow windows it overlays the
   *  canvas instead of sitting beside it). */
  const coveredRight = () => {
    const canvas = canvasRef.current?.getBoundingClientRect();
    const panel = detailRef.current?.getBoundingClientRect();
    return canvas && panel ? Math.max(0, canvas.right - panel.left) : 0;
  };
  const pendingReveal = useRef<Reveal | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  const requestReveal = (reveal: RevealTarget, afterRelayout = false) => {
    pendingReveal.current = { ...reveal, minGen: layoutGen.current + (afterRelayout ? 1 : 0) };
    setRevealTick((t) => t + 1);
  };
  useEffect(() => {
    const reveal = pendingReveal.current;
    if (!reveal || layoutState.status !== "ready" || layoutState.gen < reveal.minGen) return;
    const edges = layoutState.edges;
    // Wait a beat: the side panel may have just opened and narrowed the canvas.
    const timer = setTimeout(() => {
      const inst = rf.current;
      if (!inst || pendingReveal.current !== reveal) return;
      pendingReveal.current = null;
      const covered = coveredRight();
      if (reveal.kind === "fit") {
        void inst.fitView({
          nodes: reveal.nodeId ? [{ id: reveal.nodeId }] : undefined,
          padding: covered ? { x: "6%", y: "10%", right: `${covered + 40}px` } : 0.12,
          duration: 400,
          maxZoom: 1.1,
        });
        return;
      }
      let point: { x: number; y: number } | null = null;
      if (reveal.kind === "page") {
        const n = inst.getInternalNode(reveal.id);
        if (n) point = { x: n.internals.positionAbsolute.x + (n.measured.width ?? 220) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 76) / 2 };
      } else {
        const data = edges.find((x) => edgeHasAction(x.data, reveal.id))?.data;
        const pts = data?.points;
        point = data?.labelPosition ?? (pts && pts.length > 0 ? pts[Math.floor(pts.length / 2)] : null);
      }
      if (!point) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      const screen = inst.flowToScreenPosition(point);
      const onScreen = !!rect && screen.x > rect.left + 60 && screen.x < rect.right - covered - 60 && screen.y > rect.top + 40 && screen.y < rect.bottom - 40;
      if (!reveal.force && onScreen) return;
      const zoom = reveal.force ? Math.max(inst.getZoom(), 0.85) : inst.getZoom();
      // Center it in the part of the canvas the panel leaves visible.
      void inst.setCenter(point.x + covered / 2 / zoom, point.y, { zoom, duration: 400 });
    }, 90);
    return () => clearTimeout(timer);
  }, [revealTick, layoutState]);

  // ---- selecting ----
  const renderedIds = new Set(layoutState.status === "ready" ? layoutState.nodes.map((n) => n.id) : []);
  /** Opens the collapsed groups these pages are in, and leaves focus mode when it hides them.
   *  Returns whether the canvas will lay out again. */
  const makeVisible = (pageIds: string[]): boolean => {
    const toExpand = pageIds.map((id) => pageIdToGroup.get(id)).filter((g): g is string => !!g && !expandedGroups.has(g));
    const hidden = pageIds.some((id) => {
      const group = pageIdToGroup.get(id);
      return !renderedIds.has(id) && !(group && !expandedGroups.has(group) && renderedIds.has(groupNodeId(group)));
    });
    if (toExpand.length) setExpandedGroups((prev) => new Set([...prev, ...toExpand]));
    if (focusNodeId && hidden) setFocusNodeId(null);
    return toExpand.length > 0 || (!!focusNodeId && hidden);
  };
  const select = (next: NavMapSelection) => {
    setSelection(next);
    if (next) setHasSelected(true);
  };
  /** From the panel, the search or a link: go there. From a canvas click: only move if the opening
   *  panel covered it. */
  const selectPage = (pageId: string, force = true) => {
    const page = map.pages[pageId];
    if (!page) return;
    const relayout = makeVisible([pageId]);
    select({ type: "page", page });
    requestReveal({ kind: "page", id: pageId, force }, relayout);
  };
  const selectAction = (edge: ActionEdge, force = true) => {
    const relayout = makeVisible([edge.fromPageId, edge.toPageId]);
    select({ type: "edge", edge });
    requestReveal({ kind: "edge", id: edge.id, force }, relayout);
  };
  const selectRenderedEdge = (edge: MapEdge) => {
    const data = edge.data;
    const nodes = layoutState.status === "ready" ? layoutState.nodes : [];
    if (data?.kind === "merged") {
      select({ type: "mergedEdge", memberEdges: data.memberEdges, fromLabel: resolveEndpointLabel(edge.source, nodes), toLabel: resolveEndpointLabel(edge.target, nodes) });
      requestReveal({ kind: "edge", id: data.memberEdges[0].id, force: false });
    } else if (data?.kind === "single") {
      selectAction(data.edge, false);
    }
  };
  const focusOn = (pageId: string | null) => {
    setFocusNodeId(pageId);
    requestReveal({ kind: "fit" }, true);
  };
  const onSearchSubmit = () => {
    const q = searchText.trim();
    if (!q) return;
    const page = Object.values(map.pages).find((p) => pageMatchesSearch(p, q));
    if (page) return selectPage(page.id);
    const edge = Object.values(map.edges).find((e) => edgeMatchesSearch(e, q));
    if (edge) selectAction(edge);
  };

  // ---- rendering ----
  const isSelected = (data: NavMapEdgeData | undefined): boolean => {
    if (!data || !selection) return false;
    if (selection.type === "edge") return edgeHasAction(data, selection.edge.id);
    if (selection.type === "mergedEdge") return data.kind === "merged" && data.memberEdges === selection.memberEdges;
    return false;
  };
  const useNeighborhood = !filtersActive && !!neighborhood;
  const selectedPageId = selection?.type === "page" ? selection.page.id : null;
  const nodes: MapNode[] =
    layoutState.status === "ready"
      ? layoutState.nodes.map((n) => ({
          ...n,
          selected: n.id === selectedPageId,
          data: { ...n.data, dimmed: useNeighborhood ? !neighborhood!.nodes.has(n.id) : dimmedNodeIds.has(n.id) },
        }))
      : [];
  const edges: MapEdge[] =
    layoutState.status === "ready"
      ? layoutState.edges.map((edge) => ({
          ...edge,
          selected: isSelected(edge.data),
          data: {
            ...edge.data!,
            dimmed: useNeighborhood ? !neighborhood!.edges.has(edge.id) : dimmedEdgeIds.has(edge.id),
            emphasized: !!selectedPageId && (edge.source === selectedPageId || edge.target === selectedPageId),
          },
        }))
      : [];

  const onLabelClick = (edgeId: string) => {
    const edge = edges.find((e) => e.id === edgeId);
    if (edge) selectRenderedEdge(edge);
  };

  const minimapColor = (n: MapNode) => {
    if (n.type === "group") return "var(--map-minimap-group)";
    if (n.selected) return "var(--accent)";
    return n.data?.dimmed ? "var(--map-minimap-dim)" : "var(--map-minimap-node)";
  };

  const pages = Object.values(map.pages);
  const pageCount = pages.length;
  const actionCount = Object.keys(map.edges).length;
  const componentCount = components.size + uiComponents.size;
  const colorModes: ColorBy[] = ["intent", ...(edgeStatus ? (["result"] as const) : []), ...(edgeCoverage ? (["coverage"] as const) : [])];

  return (
    <div className="app-layout map-page">
      <PageHeader
        title="Navigation map"
        meta={
          <span>
            {map.targetHost} · {pageCount} page{pageCount === 1 ? "" : "s"} · {actionCount} action{actionCount === 1 ? "" : "s"} · merged from {map.totalRunsMerged} exploration
            {map.totalRunsMerged === 1 ? "" : "s"}
          </span>
        }
        actions={
          <>
            {componentCount > 0 && (
              <Button icon={Icon.components} onClick={() => setCatalogOpen(true)} title="Navbars, footers and other elements shared by several pages">
                Components <span className="map-btn-count">{componentCount}</span>
              </Button>
            )}
            {project && (
              <Button icon={Icon.explore} onClick={() => assistant.open("explore")}>
                Explore more
              </Button>
            )}
          </>
        }
      >
        <NavMapFilterBar
          searchText={searchText}
          onSearchTextChange={setSearchText}
          onSearchSubmit={onSearchSubmit}
          showAuthFilter={pages.some((p) => p.requiresAuth) && pages.some((p) => !p.requiresAuth)}
          authFilter={authFilter}
          onAuthFilterChange={setAuthFilter}
          staleOnly={staleOnly}
          onStaleOnlyChange={setStaleOnly}
          colorBy={colorBy}
          colorModes={colorModes}
          onColorByChange={setColorBy}
        />
      </PageHeader>
      <div className={selection ? "map-body has-detail" : "map-body"}>
        <div className="map-canvas" ref={canvasRef}>
          {layoutState.status === "ready" ? (
            <>
              <EdgeResultContext.Provider value={edgeResults}>
                <EdgeLabelClickContext.Provider value={onLabelClick}>
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    onInit={(inst) => {
                      rf.current = inst;
                    }}
                    onNodeClick={(_, node) => {
                      if (node.type === "pageCluster") {
                        const groupName = (node.data as PageClusterNodeData).groupName;
                        setExpandedGroups((prev) => new Set(prev).add(groupName));
                        setSelection(null);
                        requestReveal({ kind: "fit", nodeId: groupNodeId(groupName) }, true);
                        return;
                      }
                      if (node.type === "group") return;
                      selectPage(node.id, false);
                    }}
                    onEdgeClick={(_, edge) => selectRenderedEdge(edge)}
                    onPaneClick={() => setSelection(null)}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    // React Flow's default minZoom (0.5) can't fit a wide map, so the first view clipped it.
                    minZoom={0.1}
                    maxZoom={2}
                    fitView
                    fitViewOptions={{ padding: 0.08 }}
                  >
                    <Background gap={22} size={1.4} />
                    <Controls showInteractive={false} />
                    <MiniMap pannable zoomable nodeColor={minimapColor} nodeStrokeWidth={0} nodeBorderRadius={8} ariaLabel="Overview of the map" />
                  </ReactFlow>
                </EdgeLabelClickContext.Provider>
              </EdgeResultContext.Provider>
              <MapLegend
                colorBy={colorBy}
                edges={edges}
                activeCategories={activeCategories}
                onToggleCategory={(category) => {
                  setActiveCategories((prev) => {
                    const next = new Set(prev);
                    if (next.has(category)) next.delete(category);
                    else next.add(category);
                    return next;
                  });
                }}
              />
              {(focusNodeId || highlight) && (
                <div className="map-banners">
                  {focusNodeId && (
                    <div className="map-banner">
                      <Icon.focus size={14} aria-hidden />
                      <span>
                        Only <strong>{map.pages[focusNodeId]?.title ?? focusNodeId}</strong> and its neighbors
                      </span>
                      <button type="button" onClick={() => focusOn(null)}>
                        Show whole map
                      </button>
                    </div>
                  )}
                  {highlight && (
                    <div className="map-banner">
                      <Icon.components size={14} aria-hidden />
                      <span>
                        Highlighting <strong>{highlight.label}</strong>
                      </span>
                      <button type="button" onClick={() => setHighlight(null)}>
                        Clear
                      </button>
                    </div>
                  )}
                </div>
              )}
              {!selection && !hasSelected && <div className="map-hint">Click a page or an action to see its details · scroll to zoom, drag to move</div>}
            </>
          ) : layoutState.status === "loading" ? (
            <div className="map-canvas-message">
              <Spinner /> Laying out the map…
            </div>
          ) : (
            <div className="map-canvas-message">Could not lay out the map: {layoutState.message}</div>
          )}
        </div>
        {selection && (
          <div className="map-detail-wrap" ref={detailRef}>
            <NavMapSidePanel
              selection={selection}
              map={map}
              focusedPageId={focusNodeId}
              edgeResults={lastResults}
              componentOf={componentOf}
              project={project}
              onClose={() => setSelection(null)}
              onSelectEdge={(edge) => selectAction(edge)}
              onSelectPage={(pageId) => selectPage(pageId)}
              onFocusPage={focusOn}
            />
          </div>
        )}
      </div>
      {catalogOpen && (
        <ComponentsCatalog
          components={components}
          uiComponents={uiComponents}
          map={map}
          onClose={() => setCatalogOpen(false)}
          onHighlight={(edgeIds, label) => {
            setHighlight({ edgeIds, label });
            setCatalogOpen(false);
          }}
        />
      )}
    </div>
  );
}
