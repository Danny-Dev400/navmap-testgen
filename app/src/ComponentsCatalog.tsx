import { useEffect, useMemo } from "react";
import type { NavigationMap } from "../../src/navmap-types";
import type { ComponentAction } from "../../src/navmapComponents";
import type { UiComponent } from "../../src/navmapUiComponents";
import { INTENT_COLORS } from "./intentColors";
import { locatorText } from "./locatorText";

export interface ComponentsCatalogProps {
  components: Map<string, ComponentAction>;
  uiComponents: Map<string, UiComponent>;
  map: NavigationMap;
  onClose: () => void;
  onHighlight: (edgeIds: Set<string>, label: string) => void;
}

export function ComponentsCatalog({ components, uiComponents, map, onClose, onHighlight }: ComponentsCatalogProps) {
  useEffect(() => {
    // Capture phase + preventDefault: Escape closes only the catalog, not the side panel under it.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const sortedComponents = useMemo(() => [...components.values()].sort((a, b) => a.label.localeCompare(b.label)), [components]);
  const sortedUiComponents = useMemo(
    () => [...uiComponents.values()].sort((a, b) => a.regionName.localeCompare(b.regionName)),
    [uiComponents],
  );
  const pageTitle = (id: string) => map.pages[id]?.title ?? id;

  return (
    <div className="components-catalog-overlay" onClick={onClose}>
      <div className="components-catalog-panel" onClick={(e) => e.stopPropagation()}>
        <button className="side-panel-close" onClick={onClose} aria-label="Close">
          &times;
        </button>

        {sortedUiComponents.length > 0 && (
          <>
            <h2>🧱 UI components ({sortedUiComponents.length})</h2>
            <p className="muted">
              Structural regions (navbar, footer, modal, wizard…) tagged with the same <code>uiRegion</code>, reused from 2 or
              more pages.
            </p>
            <ul className="components-catalog-list">
              {sortedUiComponents.map((c) => {
                const allEdgeIds = new Set(c.elements.flatMap((el) => el.memberEdges.map((e) => e.id)));
                return (
                  <li key={c.id} className="components-catalog-row">
                    <div className="components-catalog-row-header">
                      <strong>{c.regionName}</strong>
                    </div>
                    <p className="muted">
                      On {c.pageIds.length} pages: {c.pageIds.map(pageTitle).join(", ")}
                    </p>
                    <ul className="components-catalog-sublist">
                      {c.elements.map((el) => (
                        <li key={el.id} className="components-catalog-subrow">
                          <div className="components-catalog-row-header">
                            <span className="components-catalog-category" style={{ background: INTENT_COLORS[el.intentCategory] }}>
                              {el.intentCategory.replace(/_/g, " ")}
                            </span>
                            <strong>{el.label}</strong>
                          </div>
                          <p className="muted">
                            <code>{locatorText(el.locator)}</code>
                          </p>
                          <button
                            className="link-button"
                            onClick={() => onHighlight(new Set(el.memberEdges.map((e) => e.id)), el.label)}
                          >
                            Highlight element
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button className="link-button" onClick={() => onHighlight(allEdgeIds, c.regionName)}>
                      Highlight whole component
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {sortedComponents.length > 0 && (
          <>
            <h2>🧩 Repeated actions ({sortedComponents.length})</h2>
            <p className="muted">UI elements detected as the same locator + semantic intent, reused from 2 or more pages.</p>
            <ul className="components-catalog-list">
              {sortedComponents.map((c) => (
                <li key={c.id} className="components-catalog-row">
                  <div className="components-catalog-row-header">
                    <span className="components-catalog-category" style={{ background: INTENT_COLORS[c.intentCategory] }}>
                      {c.intentCategory.replace(/_/g, " ")}
                    </span>
                    <strong>{c.label}</strong>
                  </div>
                  <p className="muted">
                    <code>{locatorText(c.locator)}</code>
                  </p>
                  <p className="muted">
                    On {c.pageIds.length} pages: {c.pageIds.map(pageTitle).join(", ")}
                  </p>
                  <p className="muted">&rarr; {c.targetPageIds.map(pageTitle).join(", ")}</p>
                  <button
                    className="link-button"
                    onClick={() => onHighlight(new Set(c.memberEdges.map((e) => e.id)), c.label)}
                  >
                    Highlight on canvas
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
