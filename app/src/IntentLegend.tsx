import { useState } from "react";
import type { Edge } from "@xyflow/react";
import type { IntentCategory } from "../../src/navmap-types";
import { INTENT_COLORS } from "./intentColors";
import type { NavMapEdgeData } from "./navmapGraph";
import { RESULT_COLORS, RESULT_LABELS, type ResultKey } from "./resultColors";
import { Icon } from "./ui/icons";
import { cx } from "./ui/kit";

export type ColorBy = "intent" | "result" | "coverage";

export interface MapLegendProps {
  colorBy: ColorBy;
  edges: Edge<NavMapEdgeData>[];
  activeCategories: ReadonlySet<IntentCategory>;
  onToggleCategory: (category: IntentCategory) => void;
}

const STORAGE_KEY = "navmap.map.legend";

/** "search_filter" -> "Search filter" */
export const categoryLabel = (category: string) => {
  const words = category.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** What the colors and marks on the canvas mean. In intent mode each color also filters: click one
 *  or more to keep only those actions lit. Collapsible; open/closed is remembered per browser. */
export function MapLegend({ colorBy, edges, activeCategories, onToggleCategory }: MapLegendProps) {
  // Closed until opened once: open, it would cover the top-left of the map on first load.
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "open";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(STORAGE_KEY, o ? "closed" : "open");
      } catch {
        // storage blocked: only this session remembers
      }
      return !o;
    });
  };

  const categories = Array.from(
    new Set(
      edges
        .map((e) => (e.data?.kind === "single" ? e.data.edge.intentCategory : e.data?.kind === "merged" ? e.data.commonCategory : undefined))
        .filter((c): c is NonNullable<typeof c> => !!c),
    ),
  ).sort();
  const hasBackward = edges.some((e) => e.data?.isBackward);
  const hasComponent = edges.some((e) => (e.data?.kind === "single" ? !!e.data.componentId : e.data?.kind === "merged" ? !!e.data.hasComponentMember : false));
  const hasUiComponent = edges.some((e) =>
    e.data?.kind === "single" ? !!e.data.uiComponentId : e.data?.kind === "merged" ? !!e.data.hasUiComponentMember : false,
  );
  const filtering = colorBy === "intent" && activeCategories.size > 0;

  return (
    <div className={cx("map-legend", open && "is-open")}>
      <button type="button" className="map-legend-head" aria-expanded={open} onClick={toggle}>
        <span>Legend</span>
        {filtering && <span className="map-legend-filtering">filtered</span>}
        {open ? <Icon.chevronUp size={14} aria-hidden /> : <Icon.chevronDown size={14} aria-hidden />}
      </button>
      {open && (
        <div className="map-legend-body">
          {colorBy === "intent" &&
            categories.map((category) => {
              const off = activeCategories.size > 0 && !activeCategories.has(category);
              return (
                <button
                  key={category}
                  type="button"
                  className={cx("map-legend-row", "is-toggle", off && "is-off")}
                  aria-pressed={activeCategories.has(category)}
                  title={activeCategories.has(category) ? "Click to stop filtering by it" : "Click to show only these (click more to add)"}
                  onClick={() => onToggleCategory(category)}
                >
                  <span className="map-legend-swatch" style={{ background: INTENT_COLORS[category] }} />
                  {categoryLabel(category)}
                </button>
              );
            })}
          {colorBy === "result" &&
            (Object.keys(RESULT_COLORS) as ResultKey[])
              .filter((k) => k !== "skipped")
              .map((k) => (
                <div key={k} className="map-legend-row">
                  <span className="map-legend-swatch" style={{ background: RESULT_COLORS[k] }} />
                  {RESULT_LABELS[k]}
                </div>
              ))}
          {colorBy === "coverage" && (
            <>
              <div className="map-legend-row">
                <span className="map-legend-swatch" style={{ background: RESULT_COLORS.passed }} />
                Used by an approved case
              </div>
              <div className="map-legend-row">
                <span className="map-legend-swatch" style={{ background: RESULT_COLORS.never }} />
                No approved case uses it
              </div>
            </>
          )}
          {(hasBackward || hasUiComponent || hasComponent) && <div className="map-legend-sep" />}
          {hasBackward && (
            <div className="map-legend-row">
              <span className="map-legend-swatch is-dashed" />
              Goes back / returns
            </div>
          )}
          {hasUiComponent && (
            <div className="map-legend-row">
              <Icon.uiComponent size={12} aria-hidden className="map-legend-icon" />
              Part of a UI component
            </div>
          )}
          {hasComponent && (
            <div className="map-legend-row">
              <Icon.repeated size={12} aria-hidden className="map-legend-icon" />
              Repeated on several pages
            </div>
          )}
          <div className="map-legend-row">
            <Icon.entry size={12} aria-hidden className="map-legend-icon is-entry" />
            Entry page
          </div>
          {filtering && (
            <button type="button" className="map-legend-clear" onClick={() => [...activeCategories].forEach(onToggleCategory)}>
              Show all actions
            </button>
          )}
        </div>
      )}
    </div>
  );
}
