import { useMemo, useState } from "react";
import { CaseRow } from "./CaseRow";
import { HelpTip } from "./help";
import { actionIcon } from "./testCaseIcons";
import { useAssistant } from "./assistant";
import type { LatestStatus, RunRequest } from "./runsClient";
import { casesApi, featuresApi, organizationDefs, type CasesData, type CasesResponse, type CaseView, type UseCaseView } from "./casesClient";
import { Badge, Button, IconButton, Menu, StatusIcon, cx, type Status } from "./ui/kit";
import { Icon } from "./ui/icons";
import { GroupCheck, type CaseSelection } from "./CaseSelection";

type UseCaseStatus = "ok" | "partial" | "failing" | "none";

const STATUS_GLYPH: Record<UseCaseStatus, Status> = { ok: "passed", partial: "flaky", failing: "failed", none: "never" };

/** ✓ approved cases ran green and together walk every action; ✗ one failed; ◐ approved but not
 *  run / not all green / some actions untouched / some can't run; ○ nothing approved yet. */
function useCaseStatus(u: UseCaseView, byId: Map<string, CaseView>, latest: LatestStatus): { status: UseCaseStatus; passed: number; failed: number } {
  const approved = u.cases.map((id) => byId.get(id)).filter((c): c is CaseView => !!c && c.status === "approved" && c.runnable);
  const results = approved.map((c) => latest.cases[c.id]?.status);
  const passed = results.filter((r) => r === "passed" || r === "flaky").length;
  const failed = results.filter((r) => r === "failed").length;
  if (u.approved === 0) return { status: "none", passed, failed };
  if (failed > 0) return { status: "failing", passed, failed };
  // Every approved case runnable (no fixme), all green, and together they walk every action.
  const allGreen = approved.length > 0 && approved.length === u.approved && passed === approved.length;
  return { status: allGreen && u.actionsExercised.length === u.actions.length ? "ok" : "partial", passed, failed };
}

function statusTitle(u: UseCaseView, s: UseCaseStatus): string {
  if (s === "none") return "No approved case yet";
  if (s === "failing") return "A case of this use case failed its last run";
  const missing = u.actions.length - u.actionsExercised.length;
  if (s === "ok") return "Approved cases ran green and walk every action of this use case";
  if (u.runnable < u.approved) return `${u.approved - u.runnable} approved case(s) can't run yet (fixme)`;
  return missing > 0 ? `${missing} of its ${u.actions.length} actions aren't walked by an approved case, or a case hasn't run green yet` : "Some approved cases haven't run green yet";
}

/** Test cases grouped by what the app does: feature → use case → cases, with coverage per use case. */
export function FeatureTree({
  projectId,
  data,
  latest,
  busy,
  includeDestructive,
  matches,
  filterIsNarrow,
  mutate,
  run,
  selectedCaseId,
  onOpenCase,
  onNewCase,
  onEditFeature,
  onEditUseCase,
  onExportFeature,
  selection,
}: {
  projectId: string;
  data: CasesData;
  latest: LatestStatus;
  busy: boolean;
  includeDestructive: boolean;
  matches: (c: CaseView) => boolean;
  /** A status filter that hides use cases with nothing matching (e.g. Drafts). */
  filterIsNarrow: boolean;
  mutate: (fn: () => Promise<CasesResponse>) => Promise<CasesResponse | null>;
  run: (request: RunRequest) => Promise<string | null>;
  selectedCaseId?: string | null;
  onOpenCase: (id: string) => void;
  onNewCase: (useCaseId: string, startPageId?: string) => void;
  /** null = new feature. */
  onEditFeature: (featureId: string | null) => void;
  /** null = new use case in that feature. */
  onEditUseCase: (featureId: string, useCaseId: string | null) => void;
  /** Export this feature's approved cases as manual test cases. */
  onExportFeature: (featureId: string) => void;
  /** Checkbox selection: rows and group headers get checkboxes. */
  selection: CaseSelection;
}) {
  const assistant = useAssistant();
  const org = data.organization;
  const byId = useMemo(() => new Map(data.cases.map((c) => [c.id, c])), [data.cases]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showActions, setShowActions] = useState<Set<string>>(new Set());
  const toggle = (set: typeof setCollapsed, key: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const unsorted = org.unsorted.filter((u) => byId.has(u.caseId) && matches(byId.get(u.caseId)!));
  const suggested = org.unsorted.filter((u) => u.suggestion && byId.get(u.caseId)?.status !== "rejected");
  const sortAsSuggested = () => {
    const defs = organizationDefs(org);
    for (const u of suggested) defs.flatMap((f) => f.useCases).find((x) => x.id === u.suggestion!.useCaseId)?.cases.push(u.caseId);
    return mutate(() => featuresApi.save(projectId, defs, org.updatedAt));
  };

  const design = (featureTitle: string, u: UseCaseView) =>
    assistant.open("design", {
      useCaseId: u.id,
      request: `Design cases that prove the use case "${featureTitle} › ${u.title}"${u.description ? ` — ${u.description}` : ""}. Skip what its existing cases already cover.`,
    });

  return (
    <>
      {org.features.map((f) => {
        const fKey = `f:${f.id}`;
        const stats = f.useCases.map((u) => useCaseStatus(u, byId, latest));
        const tested = stats.filter((s) => s.status !== "none").length;
        const passed = stats.reduce((n, s) => n + s.passed, 0);
        const failed = stats.reduce((n, s) => n + s.failed, 0);
        const approvedInFeature = f.useCases.reduce((n, u) => n + u.approved, 0);
        const visibleUseCases = f.useCases.filter((u) => !filterIsNarrow || u.cases.some((id) => byId.has(id) && matches(byId.get(id)!)));
        if (filterIsNarrow && visibleUseCases.length === 0) return null;
        const open = !collapsed.has(fKey);
        const featureShown = visibleUseCases.flatMap((u) => u.cases.filter((id) => byId.has(id) && matches(byId.get(id)!)));
        return (
          <section key={f.id} className="feature-block">
            <header className={cx("feature-head", "selectable-head", selection.active && "selecting")}>
              <GroupCheck ids={featureShown} selection={selection} label={`"${f.title}"`} />
              <button className="feature-toggle" aria-expanded={open} onClick={() => toggle(setCollapsed, fKey)} title={f.description}>
                {open ? <Icon.chevronDown size={16} aria-hidden /> : <Icon.chevronRight size={16} aria-hidden />}
                <Icon.feature size={16} className="feature-icon" aria-hidden />
                <span className="feature-title">{f.title}</span>
              </button>
              <Badge tone={tested === f.useCases.length && f.useCases.length > 0 ? "success" : tested ? "warning" : "neutral"} title={`${tested} of ${f.useCases.length} use cases have an approved case`}>
                {tested}/{f.useCases.length} tested
              </Badge>
              {passed + failed > 0 && (
                <span className="feature-results">
                  <span className="feature-passed">
                    <Icon.passed size={13} aria-hidden /> {passed}
                  </span>
                  {failed > 0 && (
                    <span className="feature-failed">
                      <Icon.failed size={13} aria-hidden /> {failed}
                    </span>
                  )}
                </span>
              )}
              <span className="ui-flex-spacer" />
              <span className="row-actions">
                {approvedInFeature > 0 && <IconButton icon={Icon.run} label={`Run the approved cases of "${f.title}"`} size="sm" onClick={() => run({ scope: "feature", featureId: f.id, includeDestructive })} />}
                <Menu
                  size="sm"
                  label={`More for "${f.title}"`}
                  items={[
                    { label: "Add a use case", icon: Icon.add, onSelect: () => onEditUseCase(f.id, null) },
                    { label: "Edit feature", icon: Icon.edit, onSelect: () => onEditFeature(f.id) },
                    approvedInFeature > 0 && { label: "Export manual test cases", icon: Icon.exportManual, onSelect: () => onExportFeature(f.id) },
                  ]}
                />
              </span>
            </header>
            {open && (
              <div className="use-case-list">
                {f.useCases.length === 0 && <p className="muted use-case-empty">No use cases yet — add one from the ⋯ menu.</p>}
                {visibleUseCases.map((u) => {
                  const uKey = `u:${u.id}`;
                  const { status } = useCaseStatus(u, byId, latest);
                  const shown = u.cases.map((id) => byId.get(id)).filter((c): c is CaseView => !!c && matches(c));
                  const startPage = data.actions[u.actions[0]]?.fromPageId;
                  const uOpen = !collapsed.has(uKey);
                  return (
                    <div key={u.id} className={`use-case use-case-${status}`}>
                      <div className={cx("use-case-header", "selectable-head", selection.active && "selecting")}>
                        <GroupCheck ids={shown.map((c) => c.id)} selection={selection} label={`"${u.title}"`} />
                        <button className="use-case-toggle" aria-expanded={uOpen} onClick={() => toggle(setCollapsed, uKey)} title={u.description}>
                          <StatusIcon status={STATUS_GLYPH[status]} size={15} title={statusTitle(u, status)} />
                          <span className="use-case-title">{u.title}</span>
                        </button>
                        <span className="use-case-meta">
                          {u.cases.length} case{u.cases.length === 1 ? "" : "s"}
                          {u.drafts > 0 && ` · ${u.drafts} draft${u.drafts === 1 ? "" : "s"}`}
                          {u.actions.length > 0 && ` · ${u.actionsExercised.length}/${u.actions.length} actions walked`}
                        </span>
                        <span className="ui-flex-spacer" />
                        <span className="row-actions">
                          {u.approved > 0 && <IconButton icon={Icon.run} size="sm" label={`Run "${u.title}"`} onClick={() => run({ scope: "useCase", useCaseId: u.id, includeDestructive })} />}
                          <IconButton icon={Icon.add} size="sm" label="New case for this use case" onClick={() => onNewCase(u.id, startPage)} />
                          <IconButton icon={Icon.design} size="sm" label="Ask the designer agent for cases" onClick={() => design(f.title, u)} />
                          <Menu size="sm" label={`More for "${u.title}"`} items={[{ label: "Edit use case", icon: Icon.edit, onSelect: () => onEditUseCase(f.id, u.id) }]} />
                        </span>
                      </div>
                      {uOpen && (
                        <ul className="coverage-case-list use-case-cases">
                          {shown.map((c) => (
                            <CaseRow key={c.id} c={c} data={data} latest={latest} selected={c.id === selectedCaseId} selection={selection} onOpen={() => onOpenCase(c.id)} />
                          ))}
                          {u.cases.length === 0 && (
                            <li className="use-case-empty">
                              <span className="muted">No cases yet.</span>
                              <Button size="sm" variant="ghost" icon={Icon.design} onClick={() => design(f.title, u)}>
                                Ask the designer
                              </Button>
                              <Button size="sm" variant="ghost" icon={Icon.add} onClick={() => onNewCase(u.id, startPage)}>
                                Build one
                              </Button>
                            </li>
                          )}
                          {u.actionsWithoutCase.length > 0 && !filterIsNarrow && (
                            <li className="cases-uncovered">
                              <div className="cases-uncovered-header">
                                <button className="link-button muted" onClick={() => toggle(setShowActions, u.id)}>
                                  {showActions.has(u.id) ? "▾" : "▸"} {u.actionsWithoutCase.length} action{u.actionsWithoutCase.length === 1 ? "" : "s"} without a case
                                </button>
                                <Button size="sm" variant="ghost" disabled={busy} onClick={() => mutate(() => casesApi.createBaseline(projectId, false, undefined, u.id))}>
                                  Create drafts
                                </Button>
                              </div>
                              {showActions.has(u.id) && (
                                <ul>
                                  {u.actionsWithoutCase.map((id) => (
                                    <li key={id} className="muted">
                                      {actionIcon(data.actions[id]?.action ?? "")} {data.actions[id]?.semanticIntent ?? id}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      <div className="feature-add-row">
        <Button size="sm" variant="ghost" icon={Icon.add} onClick={() => onEditFeature(null)}>
          Add a feature
        </Button>
      </div>

      {unsorted.length > 0 && (
        <section className="feature-block unsorted-block">
          <header className={cx("feature-head", "selectable-head", selection.active && "selecting")}>
            <GroupCheck ids={unsorted.map((u) => u.caseId)} selection={selection} label="Unsorted" />
            <button className="feature-toggle" aria-expanded={!collapsed.has("unsorted")} onClick={() => toggle(setCollapsed, "unsorted")}>
              {collapsed.has("unsorted") ? <Icon.chevronRight size={16} aria-hidden /> : <Icon.chevronDown size={16} aria-hidden />}
              <Icon.inbox size={16} className="feature-icon" aria-hidden />
              <span className="feature-title">Unsorted</span>
            </button>
            <Badge tone="neutral">{unsorted.length}</Badge>
            <HelpTip topic="unsorted" />
            <span className="ui-flex-spacer" />
            {suggested.length > 0 && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={sortAsSuggested}>
                Sort {suggested.length} as suggested
              </Button>
            )}
          </header>
          {!collapsed.has("unsorted") && (
            <ul className="coverage-case-list use-case-cases">
              {unsorted.map(({ caseId, suggestion }) => (
                <CaseRow
                  key={caseId}
                  c={byId.get(caseId)!}
                  data={data}
                  latest={latest}
                  selected={caseId === selectedCaseId}
                  selection={selection}
                  onOpen={() => onOpenCase(caseId)}
                  extra={
                    suggestion ? (
                      <div className="case-suggestion">
                        <span className="muted">
                          Suggested: {suggestion.featureTitle} › {suggestion.useCaseTitle}
                        </span>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => mutate(() => featuresApi.assign(projectId, [caseId], suggestion.useCaseId))}>
                          Sort
                        </Button>
                      </div>
                    ) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {org.unorganizedActions.length > 0 && !filterIsNarrow && (
        <div className={cx("unorganized-actions")}>
          <button className="link-button muted" onClick={() => toggle(setShowActions, "__unorganized")}>
            {showActions.has("__unorganized") ? "▾" : "▸"} {org.unorganizedActions.length} map action{org.unorganizedActions.length === 1 ? "" : "s"} in no use case
          </button>
          <Button size="sm" variant="ghost" icon={Icon.organize} onClick={() => assistant.open("organize")}>
            Update organization
          </Button>
          {showActions.has("__unorganized") && (
            <ul>
              {org.unorganizedActions.map((id) => (
                <li key={id}>
                  {actionIcon(data.actions[id]?.action ?? "")} {data.actions[id]?.semanticIntent ?? id}{" "}
                  <span className="muted">({data.pages.find((p) => p.id === data.actions[id]?.fromPageId)?.title})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
