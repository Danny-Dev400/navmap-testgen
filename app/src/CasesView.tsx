import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CasePanel } from "./CasePanel";
import { CaseRow } from "./CaseRow";
import { FeatureTree } from "./FeatureTree";
import { FeatureEditor, ProposalModal, UseCaseEditor } from "./OrganizationEditor";
import { actionIcon } from "./testCaseIcons";
import { HelpTip } from "./help";
import { clearParams, navigate } from "./nav";
import { useAssistant } from "./assistant";
import { RegenerationDiffModal } from "./RegenerationDiffModal";
import { ManualExportPanel } from "./ManualExportPanel";
import { GroupCheck, useCaseSelection } from "./CaseSelection";
import { SelectionBar } from "./SelectionBar";
import { SuitesBar } from "./SuitesBar";
import { EMPTY_LATEST, fetchLatestStatus, startRun, type LatestStatus, type RunRequest } from "./runsClient";
import { casesApi, featuresApi, type CasesData, type CasesResponse, type CaseView, type FeatureDef, type RegenerationHeadline } from "./casesClient";
import { Badge, Button, Callout, cx, EmptyState, IconButton, Menu, PageHeader, Segmented, SplitView } from "./ui/kit";
import { Icon } from "./ui/icons";

type Filter = "active" | "approved" | "draft" | "needs_review" | "fixme" | "rejected" | "all";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "active", label: "Approved + drafts" },
  { id: "approved", label: "Approved" },
  { id: "draft", label: "Drafts" },
  { id: "needs_review", label: "Needs review" },
  { id: "fixme", label: "Can't run yet (fixme)" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

/** Filters that only show some cases — the feature tree then hides use cases with nothing matching. */
const NARROW_FILTERS = new Set<Filter>(["approved", "draft", "needs_review", "fixme", "rejected"]);

type GroupBy = "feature" | "page";

/** What the side panel shows — one thing at a time, next to the list. */
type Detail =
  | { kind: "case"; id: string }
  | { kind: "newCase"; startPageId?: string; useCaseId?: string; presetEdgeId?: string }
  | { kind: "feature"; id: string | null }
  | { kind: "useCase"; featureId: string; id: string | null }
  | { kind: "proposal" }
  | { kind: "diff" }
  | { kind: "export"; featureId?: string; suiteId?: string; caseIds?: string[] };

function matches(c: CaseView, filter: Filter): boolean {
  switch (filter) {
    case "active":
      return c.status !== "rejected";
    case "needs_review":
      return c.health === "needs_review" && c.status !== "rejected";
    case "fixme":
      return c.status === "approved" && !c.runnable;
    case "all":
      return true;
    default:
      return c.status === filter;
  }
}

/** The test-design layer: cases built from map actions, reviewed (draft → approved), and only
 *  approved ones become generated tests — regenerated automatically on every change. The list
 *  stays on the left; whatever you open (a case, an editor, the organizer's proposal) shows on the
 *  right. */
export function CasesView({
  projectId,
  initialCaseId,
  initialNewCasePage,
  initialNewCaseStep,
  initialFilter,
  initialGroup,
  openProposal,
  refreshSignal,
}: {
  projectId: string;
  onBack?: () => void;
  /** Opens this case once loaded (deep link: ?case=). */
  initialCaseId?: string;
  /** Opens a new case starting on this page (deep link: ?newCase=<pageId>, from the map)… */
  initialNewCasePage?: string;
  /** …with this action as its first step (&step=<edgeId>). */
  initialNewCaseStep?: string;
  /** Deep link: ?filter= (e.g. drafts from the inbox). */
  initialFilter?: string;
  /** Deep link: ?group=page|feature. Without it: by feature once the cases are organized. */
  initialGroup?: string;
  /** Deep link: ?proposal=1 opens the organizer's proposal for review. */
  openProposal?: boolean;
  /** Bumped by the shell when an agent finishes, so new drafts / fixes show up. */
  refreshSignal?: number;
}) {
  const [data, setData] = useState<CasesData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(FILTERS.some((f) => f.id === initialFilter) ? (initialFilter as Filter) : "active");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showUncovered, setShowUncovered] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Detail | null>(
    initialCaseId
      ? { kind: "case", id: initialCaseId }
      : initialNewCasePage
        ? { kind: "newCase", startPageId: initialNewCasePage, presetEdgeId: initialNewCaseStep }
        : openProposal
          ? { kind: "proposal" }
          : null,
  );
  const [expanded, setExpanded] = useState(false);
  const assistant = useAssistant();
  const [latest, setLatest] = useState<LatestStatus>(EMPTY_LATEST);
  const [includeDestructive, setIncludeDestructive] = useState(false);
  const [regeneration, setRegeneration] = useState<RegenerationHeadline | null>(null);

  const loadLatest = useCallback(() => {
    fetchLatestStatus(projectId).then(setLatest).catch(() => undefined);
  }, [projectId]);
  useEffect(loadLatest, [loadLatest]);

  const load = useCallback(() => {
    casesApi
      .load(projectId)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => setLoadError(String(err)));
  }, [projectId]);
  useEffect(load, [load, refreshSignal]);
  useEffect(() => {
    if (FILTERS.some((f) => f.id === initialFilter)) setFilter(initialFilter as Filter);
  }, [initialFilter]);
  useEffect(() => {
    if (initialCaseId) setDetail({ kind: "case", id: initialCaseId });
  }, [initialCaseId]);
  useEffect(() => {
    if (openProposal) setDetail({ kind: "proposal" });
  }, [openProposal]);
  useEffect(() => {
    if (initialNewCasePage) setDetail({ kind: "newCase", startPageId: initialNewCasePage, presetEdgeId: initialNewCaseStep });
  }, [initialNewCasePage, initialNewCaseStep]);

  /** Applies a mutation's response (fresh cases + what the automatic regeneration changed). */
  const apply = useCallback((res: CasesResponse) => {
    setData(res);
    if (res.regeneration && res.regeneration.filesChanged > 0) setRegeneration(res.regeneration);
  }, []);

  const mutate = useCallback(
    async (fn: () => Promise<CasesResponse>): Promise<CasesResponse | null> => {
      setBusy(true);
      setActionError(null);
      try {
        const res = await fn();
        apply(res);
        return res;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  const run = useCallback(
    async (request: RunRequest): Promise<string | null> => {
      setActionError(null);
      const err = await startRun(projectId, request);
      if (err) setActionError(err);
      return err;
    },
    [projectId],
  );

  const regenerateNow = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/coverage/generate`, { method: "POST" });
      const body = await res.json();
      if (body.regeneration?.filesChanged > 0) setRegeneration(body.regeneration);
      load();
    } finally {
      setBusy(false);
    }
  };

  const counts = useMemo(() => {
    const cs = data?.cases ?? [];
    return {
      approved: cs.filter((c) => c.status === "approved").length,
      drafts: cs.filter((c) => c.status === "draft").length,
      review: cs.filter((c) => c.health === "needs_review" && c.status !== "rejected").length,
      runnable: cs.filter((c) => c.status === "approved" && c.runnable).length,
    };
  }, [data]);

  // ---- checkbox selection (any mix of cases) ----
  const listRef = useRef<HTMLDivElement>(null);
  const knownIds = useMemo(() => (data?.cases ?? []).map((c) => c.id), [data]);
  const { selected: checkedIds, selection, clear: clearSelection, replace: replaceSelection } = useCaseSelection(listRef, knownIds);
  const hasDetail = detail !== null;
  useEffect(() => {
    // Escape clears the selection — unless a side panel is open (Escape closes that first).
    if (checkedIds.size === 0 || hasDetail) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape" && !e.defaultPrevented && !(t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"))) clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checkedIds.size, hasDetail, clearSelection]);

  if (loadError) return <p className="muted coverage-body">Could not load test cases: {loadError}</p>;
  if (!data) return <p className="muted coverage-body">Loading&hellip;</p>;

  const actionCount = Object.keys(data.actions).length;
  const org = data.organization;
  const groupBy: GroupBy = initialGroup === "page" || initialGroup === "feature" ? initialGroup : org.exists ? "feature" : "page";
  const setGroupBy = (g: GroupBy) => navigate(projectId, "cases", { group: g, ...(filter !== "active" ? { filter } : {}) });
  const saveFeatures = async (features: FeatureDef[]) => !!(await mutate(() => featuresApi.save(projectId, features, org.updatedAt)));
  const closeDetail = () => {
    setDetail(null);
    setExpanded(false);
    if (initialCaseId || openProposal || initialNewCasePage) clearParams(projectId, "cases");
  };
  const selectedCaseId = detail?.kind === "case" ? detail.id : null;
  const openCase = (id: string) => setDetail({ kind: "case", id });
  const selected = detail?.kind === "case" ? data.cases.find((c) => c.id === detail.id) : undefined;

  // ---- the side panel ----
  let panel: React.ReactNode = null;
  if ((detail?.kind === "case" && selected) || detail?.kind === "newCase") {
    const isNew = detail.kind === "newCase";
    panel = (
      <CasePanel
        key={isNew ? "new" : selected!.id}
        projectId={projectId}
        data={data}
        testCase={isNew ? null : selected!}
        startPageId={isNew ? detail.startPageId : undefined}
        presetUseCaseId={isNew ? detail.useCaseId : undefined}
        presetEdgeId={isNew ? detail.presetEdgeId : undefined}
        lastResult={selected ? latest.cases[selected.id] : undefined}
        busy={busy}
        onMutate={mutate}
        onCreated={(id) => {
          setDetail({ kind: "case", id });
          if (initialNewCasePage) clearParams(projectId, "cases");
        }}
        onDeleted={closeDetail}
        onRun={() => (selected ? run({ scope: "case", caseId: selected.id }) : Promise.resolve("Save the case first"))}
        onReload={load}
        onClose={closeDetail}
        expanded={expanded}
        onToggleExpand={() => setExpanded((e) => !e)}
      />
    );
  } else if (detail?.kind === "feature") {
    panel = <FeatureEditor key={detail.id ?? "new"} data={data} featureId={detail.id} busy={busy} onSave={saveFeatures} onClose={closeDetail} />;
  } else if (detail?.kind === "useCase") {
    panel = <UseCaseEditor key={detail.id ?? `new-${detail.featureId}`} data={data} featureId={detail.featureId} useCaseId={detail.id} busy={busy} onSave={saveFeatures} onClose={closeDetail} />;
  } else if (detail?.kind === "proposal" && data.proposal) {
    panel = (
      <ProposalModal
        data={data}
        proposal={data.proposal}
        busy={busy}
        onAccept={async () => {
          if (await mutate(() => featuresApi.acceptProposal(projectId))) {
            closeDetail();
            if (initialGroup === "page") setGroupBy("feature");
          }
        }}
        onDiscard={async () => {
          if (await mutate(() => featuresApi.discardProposal(projectId))) closeDetail();
        }}
        onClose={closeDetail}
      />
    );
  } else if (detail?.kind === "export") {
    panel = (
      <ManualExportPanel
        key={detail.caseIds ? `sel-${detail.caseIds.length}` : (detail.suiteId ?? detail.featureId ?? "project")}
        projectId={projectId}
        data={data}
        initialFeatureId={detail.featureId}
        initialSuiteId={detail.suiteId}
        caseIds={detail.caseIds}
        onClose={closeDetail}
      />
    );
  } else if (detail?.kind === "diff") {
    panel = <RegenerationDiffModal projectId={projectId} testTitle={(caseId) => data.cases.find((c) => c.id === caseId)?.title ?? caseId} onClose={closeDetail} />;
  }

  const meta = (
    <>
      <span>
        <strong>{counts.approved}</strong> approved
      </span>
      <span>
        <strong>{counts.runnable}</strong> runnable
      </span>
      {counts.drafts > 0 && <Badge tone="accent">{counts.drafts} draft{counts.drafts === 1 ? "" : "s"}</Badge>}
      {counts.review > 0 && <Badge tone="warning">{counts.review} need review</Badge>}
      {regeneration && (
        <button className="link-button" onClick={() => setDetail({ kind: "diff" })} title="Generated code updates on its own after every change">
          Code updated · {regeneration.testsChanged} test{regeneration.testsChanged === 1 ? "" : "s"} changed
        </button>
      )}
    </>
  );

  // ---- the list ----
  const list = (
    <div className={cx("cases-list-pane", selection.active && "selecting")} ref={listRef}>
      <SuitesBar
        projectId={projectId}
        suites={data.suites.list}
        selectedIds={[...checkedIds]}
        busy={busy}
        mutate={mutate}
        run={run}
        onSelect={replaceSelection}
        onExport={(suiteId) => setDetail({ kind: "export", suiteId })}
      />
      {data.cases.length === 0 && (
        <EmptyState
          icon={Icon.cases}
          title="No test cases yet"
          actions={
            <>
              <Button variant="primary" disabled={busy || actionCount === 0} onClick={() => mutate(() => casesApi.createBaseline(projectId, false))}>
                Create {actionCount} drafts
              </Button>
              <Button disabled={busy || actionCount === 0} onClick={() => mutate(() => casesApi.createBaseline(projectId, true))}>
                Create &amp; approve all
              </Button>
              <Button variant="ghost" icon={Icon.add} disabled={busy} onClick={() => setDetail({ kind: "newCase" })}>
                Build one by hand
              </Button>
            </>
          }
        >
          The map has {actionCount} action{actionCount === 1 ? "" : "s"}. Start with one basic case per action — as drafts to review, or approved right away — or ask the Assistant to
          design cases.
        </EmptyState>
      )}

      {actionError && <Callout tone="danger">{actionError}</Callout>}

      {data.proposal && detail?.kind !== "proposal" && (
        <Callout
          tone="ai"
          icon={Icon.organize}
          title="The organizer proposes a new organization"
          actions={
            <Button variant="primary" size="sm" onClick={() => setDetail({ kind: "proposal" })}>
              Review
            </Button>
          }
        >
          {data.proposal.diff.summary}
        </Callout>
      )}
      {!org.exists && !data.proposal && data.cases.length > 0 && (
        <Callout
          tone="info"
          icon={Icon.feature}
          title="Organize cases by what the app does"
          actions={
            <>
              <Button size="sm" variant="primary" icon={Icon.organize} onClick={() => assistant.open("organize")}>
                Propose an organization
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDetail({ kind: "feature", id: null })}>
                Create a feature
              </Button>
            </>
          }
        >
          Features → use cases → cases. <HelpTip topic="features" />
        </Callout>
      )}

      {groupBy === "feature" && org.exists && (
        <FeatureTree
          projectId={projectId}
          data={data}
          latest={latest}
          busy={busy}
          includeDestructive={includeDestructive}
          matches={(c) => matches(c, filter)}
          filterIsNarrow={NARROW_FILTERS.has(filter)}
          mutate={mutate}
          run={run}
          selectedCaseId={selectedCaseId}
          onOpenCase={openCase}
          onNewCase={(useCaseId, startPageId) => setDetail({ kind: "newCase", useCaseId, startPageId })}
          onEditFeature={(id) => setDetail({ kind: "feature", id })}
          onExportFeature={(featureId) => setDetail({ kind: "export", featureId })}
          selection={selection}
          onEditUseCase={(featureId, id) => setDetail({ kind: "useCase", featureId, id })}
        />
      )}

      {(groupBy === "page" || !org.exists) &&
        data.pages.map((page) => {
          const pageCases = data.cases.filter((c) => c.firstPageId === page.id && matches(c, filter));
          const uncovered = filter === "active" || filter === "all" ? data.uncovered.filter((id) => data.actions[id]?.fromPageId === page.id) : [];
          if (pageCases.length === 0 && uncovered.length === 0) return null;
          const drafts = pageCases.filter((c) => c.status === "draft");
          const hasApproved = data.cases.some((c) => c.firstPageId === page.id && c.status === "approved");
          const open = !collapsed.has(page.id);
          return (
            <section key={page.id} className="feature-block">
              <header className={cx("feature-head", "selectable-head", selection.active && "selecting")}>
                <GroupCheck ids={pageCases.map((c) => c.id)} selection={selection} label={`"${page.title}"`} />
                <button
                  className="feature-toggle"
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(page.id)) next.delete(page.id);
                      else next.add(page.id);
                      return next;
                    })
                  }
                >
                  {open ? <Icon.chevronDown size={16} aria-hidden /> : <Icon.chevronRight size={16} aria-hidden />}
                  <Icon.file size={16} className="feature-icon" aria-hidden />
                  <span className="feature-title">{page.title}</span>
                </button>
                <Badge tone="neutral">{pageCases.length}</Badge>
                <span className="ui-flex-spacer" />
                <span className="row-actions">
                  {drafts.length > 0 && (
                    <Button size="sm" variant="ghost" icon={Icon.check} disabled={busy} onClick={() => mutate(() => casesApi.setStatus(projectId, drafts.map((c) => c.id), "approved"))}>
                      Approve {drafts.length}
                    </Button>
                  )}
                  {hasApproved && <IconButton icon={Icon.run} size="sm" label="Run the approved cases of this page" onClick={() => run({ scope: "page", pageId: page.id, includeDestructive })} />}
                  <IconButton icon={Icon.add} size="sm" label="New case starting on this page" onClick={() => setDetail({ kind: "newCase", startPageId: page.id })} />
                </span>
              </header>
              {open && (
                <ul className="coverage-case-list">
                  {pageCases.map((c) => (
                    <CaseRow key={c.id} c={c} data={data} latest={latest} selected={c.id === selectedCaseId} selection={selection} onOpen={() => openCase(c.id)} />
                  ))}
                  {uncovered.length > 0 && (
                    <li className="cases-uncovered">
                      <div className="cases-uncovered-header">
                        <button
                          className="link-button muted"
                          onClick={() =>
                            setShowUncovered((prev) => {
                              const next = new Set(prev);
                              if (next.has(page.id)) next.delete(page.id);
                              else next.add(page.id);
                              return next;
                            })
                          }
                        >
                          {showUncovered.has(page.id) ? "▾" : "▸"} {uncovered.length} action{uncovered.length === 1 ? "" : "s"} without a case
                        </button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => mutate(() => casesApi.createBaseline(projectId, false, page.id))}>
                          Create drafts
                        </Button>
                      </div>
                      {showUncovered.has(page.id) && (
                        <ul>
                          {uncovered.map((id) => (
                            <li key={id} className="muted">
                              {actionIcon(data.actions[id].action)} {data.actions[id].semanticIntent}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )}
                </ul>
              )}
            </section>
          );
        })}

      {/* Cases whose first action vanished from the map still need a home. */}
      {(groupBy === "page" || !org.exists) &&
        (() => {
          const orphans = data.cases.filter((c) => (!c.firstPageId || !data.pages.some((p) => p.id === c.firstPageId)) && matches(c, filter));
          if (orphans.length === 0) return null;
          return (
            <section className="feature-block">
              <header className="feature-head">
                <span className="feature-toggle">
                  <Icon.warning size={16} className="feature-icon" aria-hidden />
                  <span className="feature-title">Actions no longer in the map</span>
                </span>
              </header>
              <ul className="coverage-case-list">
                {orphans.map((c) => (
                  <CaseRow key={c.id} c={c} data={data} latest={latest} selected={c.id === selectedCaseId} selection={selection} onOpen={() => openCase(c.id)} />
                ))}
              </ul>
            </section>
          );
        })()}

      {checkedIds.size > 0 && (
        <SelectionBar
          projectId={projectId}
          data={data}
          ids={[...checkedIds]}
          hidden={[...checkedIds].filter((id) => {
            const c = data.cases.find((x) => x.id === id);
            return c && !matches(c, filter);
          }).length}
          busy={busy}
          mutate={mutate}
          run={run}
          onExport={() => setDetail({ kind: "export", caseIds: [...checkedIds] })}
          onClear={clearSelection}
        />
      )}
    </div>
  );

  return (
    <div className="app-layout">
      <PageHeader
        title={
          <>
            Test cases <HelpTip topic="cases" />
          </>
        }
        meta={meta}
        actions={
          data.cases.length > 0 && (
            <>
              <Button variant="primary" icon={Icon.run} onClick={() => run({ scope: "project", includeDestructive })} disabled={counts.approved === 0}>
                Run all
              </Button>
              <Button icon={Icon.add} onClick={() => setDetail({ kind: "newCase" })}>
                New case
              </Button>
              <Menu
                items={[
                  {
                    label: includeDestructive ? "Exclude destructive cases from runs" : "Include destructive cases in runs",
                    icon: Icon.destructive,
                    onSelect: () => setIncludeDestructive((v) => !v),
                  },
                  { label: "Export manual test cases", icon: Icon.exportManual, onSelect: () => setDetail({ kind: "export" }), hint: "Markdown, or CSV for TestRail / Xray / Zephyr Scale" },
                  { label: "Organize with the Assistant", icon: Icon.organize, onSelect: () => assistant.open("organize") },
                  org.exists && { label: "Add a feature", icon: Icon.feature, onSelect: () => setDetail({ kind: "feature", id: null }) },
                  { label: "Last code changes", icon: Icon.code, onSelect: () => setDetail({ kind: "diff" }) },
                  { label: "Regenerate code now", icon: Icon.refresh, disabled: busy, onSelect: () => void regenerateNow(), hint: "Code regenerates on its own after every change — this forces it" },
                ]}
              />
            </>
          )
        }
      >
        {data.cases.length > 0 && (
          <>
            <Segmented
              size="sm"
              options={[
                { id: "feature", label: "By feature", icon: Icon.feature },
                { id: "page", label: "By page", icon: Icon.file },
              ]}
              value={groupBy}
              onChange={setGroupBy}
            />
            <select className="users-input cases-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter cases">
              {FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            {includeDestructive && (
              <Badge tone="danger" icon={Icon.destructive} title="Runs include destructive cases — change it in the ⋯ menu">
                Runs include destructive cases
              </Badge>
            )}
          </>
        )}
      </PageHeader>
      <SplitView list={list} detail={panel} wide={expanded} />
    </div>
  );
}
