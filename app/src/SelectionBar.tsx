import { useState } from "react";
import { casesApi, featuresApi, suitesApi, type CasesData, type CasesResponse } from "./casesClient";
import type { RunRequest } from "./runsClient";
import { Button, IconButton, Menu } from "./ui/kit";
import { Icon } from "./ui/icons";
import { HelpTip } from "./help";

type Mode = null | "suite" | "move" | "delete";

/** What you can do with the cases checked in the list, pinned at the bottom of it: run them, export
 *  them, keep them as a suite, change their status, move them to a use case, delete them. */
export function SelectionBar({
  projectId,
  data,
  ids,
  hidden,
  busy,
  mutate,
  run,
  onExport,
  onClear,
}: {
  projectId: string;
  data: CasesData;
  /** The selected case ids. */
  ids: string[];
  /** How many of them the current filter hides. */
  hidden: number;
  busy: boolean;
  mutate: (fn: () => Promise<CasesResponse>) => Promise<CasesResponse | null>;
  run: (request: RunRequest) => Promise<string | null>;
  onExport: () => void;
  onClear: () => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [suiteName, setSuiteName] = useState("");
  const [moveTo, setMoveTo] = useState("");
  const [started, setStarted] = useState(false);

  const cases = ids.map((id) => data.cases.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c);
  const approved = cases.filter((c) => c.status === "approved");
  const destructive = approved.filter((c) => c.destructive).length;
  const notRunning = cases.length - approved.length;
  const n = cases.length;
  const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const done = (res: CasesResponse | null) => {
    if (res) setMode(null);
    return res;
  };

  const runSelected = async () => {
    const err = await run({ scope: "cases", caseIds: approved.map((c) => c.id) });
    if (!err) {
      setStarted(true);
      setTimeout(() => setStarted(false), 4000);
    }
  };
  const saveSuite = async () => {
    const name = suiteName.trim();
    if (!name) return;
    if (done(await mutate(() => suitesApi.create(projectId, name, ids)))) setSuiteName("");
  };
  const move = async () => done(await mutate(() => featuresApi.assign(projectId, ids, moveTo || null)));
  const remove = async () => {
    if (done(await mutate(() => casesApi.removeMany(projectId, ids)))) onClear();
  };

  return (
    <div className="selection-bar" role="region" aria-label="Selected test cases">
      {mode === null && (
        <>
          <div className="selection-bar-count">
            <strong>{n} selected</strong>
            {hidden > 0 && <span> · {hidden} hidden by the filter</span>}
            {destructive > 0 && (
              <span className="selection-bar-warn" title="Running the selection runs them too — you picked them">
                {" "}
                · <Icon.destructive size={13} aria-hidden /> {plural(destructive, "destructive case")}
              </span>
            )}
          </div>
          <HelpTip topic="selection" />
          <span className="ui-flex-spacer" />
          <Button
            variant="primary"
            size="sm"
            icon={started ? Icon.check : Icon.run}
            disabled={approved.length === 0}
            title={approved.length === 0 ? "Only approved cases have tests to run" : notRunning > 0 ? `${plural(notRunning, "case")} not approved won't run` : undefined}
            onClick={() => void runSelected()}
          >
            {started ? "Run started — see Runs" : approved.length === n ? "Run selected" : `Run the ${approved.length} approved`}
          </Button>
          <Button size="sm" icon={Icon.exportManual} onClick={onExport}>
            Export
          </Button>
          <Button size="sm" icon={Icon.add} onClick={() => setMode("suite")}>
            Save as suite
          </Button>
          <Menu
            size="sm"
            label="More for the selection"
            items={[
              ...data.suites.list.map((st) => ({
                label: `Add to suite “${st.name}”`,
                icon: Icon.add,
                disabled: busy || ids.every((id) => st.caseIds.includes(id)),
                onSelect: () => void mutate(() => suitesApi.update(projectId, st.id, { addCaseIds: ids })),
              })),
              { label: "Approve", icon: Icon.check, disabled: busy, onSelect: () => void mutate(() => casesApi.setStatus(projectId, ids, "approved")) },
              { label: "Back to draft", icon: Icon.undo, disabled: busy, onSelect: () => void mutate(() => casesApi.setStatus(projectId, ids, "draft")) },
              { label: "Reject", icon: Icon.ban, disabled: busy, onSelect: () => void mutate(() => casesApi.setStatus(projectId, ids, "rejected")) },
              data.organization.exists && { label: "Move to a use case…", icon: Icon.useCase, onSelect: () => setMode("move") },
              { label: "Delete…", icon: Icon.delete, danger: true, onSelect: () => setMode("delete") },
            ]}
          />
          <IconButton icon={Icon.close} size="sm" label="Clear the selection (Esc)" onClick={onClear} />
        </>
      )}

      {mode === "suite" && (
        <form
          className="selection-bar-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveSuite();
          }}
        >
          <span>Save {plural(n, "case")} as a suite:</span>
          <input
            className="users-input"
            autoFocus
            placeholder="Suite name, e.g. Smoke"
            value={suiteName}
            maxLength={80}
            onChange={(e) => setSuiteName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setMode(null))}
          />
          <Button type="submit" variant="primary" size="sm" disabled={busy || !suiteName.trim()}>
            Save suite
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
            Cancel
          </Button>
        </form>
      )}

      {mode === "move" && (
        <div className="selection-bar-form">
          <span>Move {plural(n, "case")} to:</span>
          <select className="users-input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} autoFocus>
            <option value="">— Unsorted —</option>
            {data.organization.features.map((f) => (
              <optgroup key={f.id} label={f.title}>
                {f.useCases.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void move()}>
            Move
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
            Cancel
          </Button>
        </div>
      )}

      {mode === "delete" && (
        <div className="selection-bar-form selection-bar-danger" role="alert">
          <Icon.warning size={16} aria-hidden />
          <span>
            Delete {plural(n, "case")}? This can&apos;t be undone — the actions of deleted baseline cases show as &ldquo;without a case&rdquo; again.
          </span>
          <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>
            Delete {n}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
