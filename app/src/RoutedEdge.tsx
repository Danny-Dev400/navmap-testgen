import { createContext, useContext } from "react";
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { NavMapEdgeData } from "./navmapGraph";
import { INTENT_COLORS } from "./intentColors";
import { EdgeResultContext, RESULT_COLORS, worstResult } from "./resultColors";
import { Icon } from "./ui/icons";
import { cx } from "./ui/kit";

// Edge labels render in an HTML layer outside the edge's SVG, so React Flow's onEdgeClick
// never sees clicks on them. The canvas provides its edge-click handler through this context.
export const EdgeLabelClickContext = createContext<((edgeId: string) => void) | null>(null);

function pointsToPath(points: { x: number; y: number }[]): string {
  const [first, ...rest] = points;
  return `M ${first.x},${first.y} ` + rest.map((p) => `L ${p.x},${p.y}`).join(" ");
}

export function RoutedEdge({ id, sourceX, sourceY, targetX, targetY, label, data, selected }: EdgeProps & { data: NavMapEdgeData }) {
  const onLabelClick = useContext(EdgeLabelClickContext);
  const results = useContext(EdgeResultContext);
  const points = data?.points && data.points.length > 1 ? data.points : [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }];
  const path = pointsToPath(points);

  const fallbackMid = points[Math.floor(points.length / 2)];
  const labelPos = data?.labelPosition ?? fallbackMid;

  // "Color by last result" mode: green/red/amber/gray per the newest test run; a merged edge shows
  // its worst member.
  const color = results
    ? data?.kind === "single"
      ? RESULT_COLORS[results[data.edge.id] ?? "never"]
      : data?.kind === "merged"
        ? RESULT_COLORS[worstResult(data.memberEdges.map((e) => results[e.id] ?? "never"))]
        : undefined
    : data?.kind === "single"
      ? INTENT_COLORS[data.edge.intentCategory]
      : data?.kind === "merged"
        ? INTENT_COLORS[data.commonCategory ?? "other"]
        : undefined;

  const dimmed = !!data?.dimmed;
  const emphasized = !!data?.emphasized;
  const isComponent = data?.kind === "single" ? !!data.componentId : data?.kind === "merged" ? !!data.hasComponentMember : false;
  const isUiComponent =
    data?.kind === "single" ? !!data.uiComponentId : data?.kind === "merged" ? !!data.hasUiComponentMember : false;

  return (
    <>
      <BaseEdge
        path={path}
        interactionWidth={14}
        style={{
          stroke: color,
          strokeWidth: selected ? 3 : emphasized ? 2.25 : 1.5,
          strokeDasharray: data?.isBackward ? "6 4" : undefined,
          opacity: dimmed ? 0.15 : undefined,
          transition: "opacity 120ms, stroke-width 120ms",
        }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={cx("map-edge-label nodrag nopan", selected && "is-selected", emphasized && "is-related", dimmed && "is-dimmed")}
            role="button"
            tabIndex={0}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelPos.x}px, ${labelPos.y}px)`,
              pointerEvents: "all",
              borderLeftColor: color,
            }}
            onClick={(event) => {
              event.stopPropagation();
              onLabelClick?.(id);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onLabelClick?.(id);
              }
            }}
          >
            {isUiComponent && (
              <span className="map-edge-badge" title="Part of a shared UI component (navbar, footer…)">
                <Icon.uiComponent size={11} aria-hidden />
              </span>
            )}
            {isComponent && (
              <span className="map-edge-badge" title="Repeated action — the same element on several pages">
                <Icon.repeated size={11} aria-hidden />
              </span>
            )}
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
