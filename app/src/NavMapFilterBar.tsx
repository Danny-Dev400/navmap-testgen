import { useEffect, useRef } from "react";
import type { AuthFilter } from "./navmapFilters";
import type { ColorBy } from "./IntentLegend";
import { Icon } from "./ui/icons";
import { cx, Segmented } from "./ui/kit";

export interface NavMapFilterBarProps {
  searchText: string;
  onSearchTextChange: (value: string) => void;
  /** Enter in the search box: jump to the first match. */
  onSearchSubmit: () => void;
  /** The map has both public and signed-in pages, so the auth filter means something. */
  showAuthFilter: boolean;
  authFilter: AuthFilter;
  onAuthFilterChange: (value: AuthFilter) => void;
  staleOnly: boolean;
  onStaleOnlyChange: (value: boolean) => void;
  colorBy: ColorBy;
  /** Only the modes with data (last result / coverage need the dashboard). */
  colorModes: ColorBy[];
  onColorByChange: (value: ColorBy) => void;
}

const COLOR_LABEL: Record<ColorBy, string> = { intent: "Intent", result: "Last result", coverage: "Coverage" };

/** Search, filters and coloring for the map. "/" focuses the search from anywhere on the page. */
export function NavMapFilterBar(props: NavMapFilterBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="map-search">
        <Icon.search size={15} aria-hidden className="map-search-icon" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search pages & actions"
          aria-label="Search pages and actions"
          value={props.searchText}
          onChange={(e) => props.onSearchTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onSearchSubmit();
            if (e.key === "Escape" && props.searchText) {
              e.preventDefault();
              props.onSearchTextChange("");
            }
          }}
        />
        {props.searchText ? (
          <button type="button" className="map-search-clear" aria-label="Clear search" title="Clear search" onClick={() => props.onSearchTextChange("")}>
            <Icon.close size={14} aria-hidden />
          </button>
        ) : (
          <kbd className="map-search-kbd" title="Press / to search">
            /
          </kbd>
        )}
      </div>
      {props.showAuthFilter && (
        <Segmented<AuthFilter>
          size="sm"
          value={props.authFilter}
          onChange={props.onAuthFilterChange}
          options={[
            { id: "all", label: "All pages" },
            { id: "public", label: "Public", icon: Icon.publicPage },
            { id: "auth", label: "Signed in", icon: Icon.lock },
          ]}
        />
      )}
      <button
        type="button"
        className={cx("map-chip", props.staleOnly && "is-on")}
        aria-pressed={props.staleOnly}
        title="Keep lit only the pages and actions not re-verified today"
        onClick={() => props.onStaleOnlyChange(!props.staleOnly)}
      >
        <Icon.clock size={14} aria-hidden />
        Not verified today
      </button>
      {props.colorModes.length > 1 && (
        <>
          <span className="ui-flex-spacer" />
          <span className="map-toolbar-label">Color by</span>
          <Segmented<ColorBy> size="sm" value={props.colorBy} onChange={props.onColorByChange} options={props.colorModes.map((id) => ({ id, label: COLOR_LABEL[id] }))} />
        </>
      )}
    </>
  );
}
