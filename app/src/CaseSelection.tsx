import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { cx } from "./ui/kit";

/** Picking test cases with checkboxes (any mix, across features and pages) to act on them together.
 *  Shift-click selects the range between the last clicked row and this one, in the order the rows
 *  are shown (read from the DOM: rows carry data-case-id). */
export interface CaseSelection {
  has: (id: string) => boolean;
  toggle: (id: string, shiftKey: boolean) => void;
  /** Select (or unselect) every id at once — a group's checkbox. */
  setMany: (ids: string[], on: boolean) => void;
  /** Something is selected: every checkbox shows, not only on hover. */
  active: boolean;
}

export function useCaseSelection(listRef: RefObject<HTMLElement | null>, knownIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);

  // Ids that disappear (deleted cases, another project) leave the selection.
  useEffect(() => {
    const known = new Set(knownIds);
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => known.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [knownIds]);

  const visibleOrder = useCallback(
    () => [...(listRef.current?.querySelectorAll<HTMLElement>("[data-case-id]") ?? [])].map((el) => el.dataset.caseId!),
    [listRef],
  );

  const toggle = useCallback(
    (id: string, shiftKey: boolean) => {
      // Read the anchor and the row order now: the state updater runs later, after anchor moves.
      const from = anchor.current;
      const order = shiftKey && from ? visibleOrder() : [];
      const a = order.indexOf(from ?? "");
      const b = order.indexOf(id);
      const range = a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [id];
      setSelected((prev) => {
        const next = new Set(prev);
        const on = !prev.has(id);
        for (const x of range) {
          if (on) next.add(x);
          else next.delete(x);
        }
        return next;
      });
      anchor.current = id;
    },
    [visibleOrder],
  );

  const setMany = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  const api = useMemo<CaseSelection>(() => ({ has: (id) => selected.has(id), toggle, setMany, active: selected.size > 0 }), [selected, toggle, setMany]);
  return { selected, selection: api, clear, replace: (ids: string[]) => setSelected(new Set(ids)) };
}

/** The checkbox of a group (feature, use case, page, Unsorted): all / some (indeterminate) / none of
 *  its shown cases. Hidden until the header is hovered, unless a selection is active. */
export function GroupCheck({ ids, selection, label }: { ids: string[]; selection: CaseSelection; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const count = ids.filter((id) => selection.has(id)).length;
  const all = ids.length > 0 && count === ids.length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && !all;
  }, [count, all]);
  if (ids.length === 0) return null;
  return (
    <input
      ref={ref}
      type="checkbox"
      className={cx("select-check group-check", count > 0 && "is-checked")}
      checked={all}
      onChange={() => selection.setMany(ids, !all)}
      onClick={(e) => e.stopPropagation()}
      aria-label={all ? `Unselect the cases of ${label}` : `Select the ${ids.length} cases of ${label}`}
      title={all ? "Unselect all" : `Select all ${ids.length}`}
    />
  );
}
