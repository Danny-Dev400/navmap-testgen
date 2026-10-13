import { useState } from "react";
import { suitesApi, type CasesResponse, type SuiteView } from "./casesClient";
import type { RunRequest } from "./runsClient";
import { HelpTip } from "./help";
import { Button, cx, IconButton, Menu } from "./ui/kit";
import { Icon } from "./ui/icons";

/** The project's suites, as chips above the list: click one to select its cases (to see or change
 *  them), ▶ to run it, ⋯ to update it with the current selection, rename, export or delete it. */
export function SuitesBar({
  projectId,
  suites,
  selectedIds,
  busy,
  mutate,
  run,
  onSelect,
  onExport,
}: {
  projectId: string;
  suites: SuiteView[];
  selectedIds: string[];
  busy: boolean;
  mutate: (fn: () => Promise<CasesResponse>) => Promise<CasesResponse | null>;
  run: (request: RunRequest) => Promise<string | null>;
  /** Replace the list's selection with the suite's cases. */
  onSelect: (caseIds: string[]) => void;
  onExport: (suiteId: string) => void;
}) {
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  if (suites.length === 0) return null;

  const isCurrent = (st: SuiteView) => selectedIds.length === st.caseIds.length && st.caseIds.every((id) => selectedIds.includes(id));

  return (
    <div className="suites-bar">
      <span className="suites-bar-label">
        Suites <HelpTip topic="suites" />
      </span>
      {suites.map((st) => {
        if (renaming?.id === st.id) {
          return (
            <form
              key={st.id}
              className="suite-chip editing"
              onSubmit={async (e) => {
                e.preventDefault();
                const name = renaming.name.trim();
                if (name && (await mutate(() => suitesApi.update(projectId, st.id, { name })))) setRenaming(null);
              }}
            >
              <input
                className="suite-chip-input"
                autoFocus
                value={renaming.name}
                maxLength={80}
                aria-label="Suite name"
                onChange={(e) => setRenaming({ id: st.id, name: e.target.value })}
                onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setRenaming(null))}
              />
              <IconButton icon={Icon.check} size="sm" label="Save name" type="submit" disabled={busy} />
              <IconButton icon={Icon.close} size="sm" label="Cancel" onClick={() => setRenaming(null)} />
            </form>
          );
        }
        if (deleting === st.id) {
          return (
            <span key={st.id} className="suite-chip deleting" role="alert">
              Delete “{st.name}”?
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  if (await mutate(() => suitesApi.remove(projectId, st.id))) setDeleting(null);
                }}
              >
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
            </span>
          );
        }
        return (
          <span key={st.id} className={cx("suite-chip", isCurrent(st) && "current")}>
            <button type="button" className="suite-chip-main" onClick={() => onSelect(st.caseIds)} title={`Select its ${st.caseIds.length} cases in the list${st.description ? ` — ${st.description}` : ""}`}>
              <Icon.cases size={13} aria-hidden />
              <span className="suite-chip-name">{st.name}</span>
              <span className="suite-chip-count">{st.caseIds.length}</span>
            </button>
            <IconButton
              icon={started === st.id ? Icon.check : Icon.run}
              size="sm"
              label={st.approved === 0 ? "No approved case to run yet" : `Run "${st.name}" (${st.approved} approved)`}
              disabled={st.approved === 0}
              onClick={async () => {
                if (!(await run({ scope: "suite", suiteId: st.id }))) {
                  setStarted(st.id);
                  setTimeout(() => setStarted(null), 4000);
                }
              }}
            />
            <Menu
              size="sm"
              label={`More for "${st.name}"`}
              items={[
                {
                  label: "Update with the current selection",
                  icon: Icon.refresh,
                  disabled: busy || selectedIds.length === 0 || isCurrent(st),
                  hint: selectedIds.length === 0 ? "Select cases in the list first" : `Its cases become the ${selectedIds.length} selected`,
                  onSelect: () => void mutate(() => suitesApi.update(projectId, st.id, { caseIds: selectedIds })),
                },
                { label: "Rename…", icon: Icon.edit, onSelect: () => setRenaming({ id: st.id, name: st.name }) },
                { label: "Export manual test cases", icon: Icon.exportManual, onSelect: () => onExport(st.id) },
                { label: "Delete…", icon: Icon.delete, danger: true, onSelect: () => setDeleting(st.id) },
              ]}
            />
          </span>
        );
      })}
    </div>
  );
}
