import { useCallback, useEffect, useRef, useState } from "react";
import { CRITERION_LABEL, matrixUrl, requirementsApi, type CriterionInput, type CriterionStatus, type ParsedRequirement, type RequirementView, type RequirementsData } from "./requirementsClient";
import { startRun, timeAgo } from "./runsClient";
import { manualExportUrl } from "./ManualExportPanel";
import { useAssistant } from "./assistant";
import { clearParams, navigate } from "./nav";
import { HelpTip } from "./help";
import { Badge, Button, Callout, cx, DetailPanel, EmptyState, Field, IconButton, Menu, PageHeader, Segmented, SplitView, StatusIcon, type Status } from "./ui/kit";
import { Icon } from "./ui/icons";

type Filter = "all" | "uncovered" | "failing" | "passing";
type Detail = { kind: "req"; id: string } | { kind: "add" } | { kind: "import" };

const GLYPH: Record<CriterionStatus, Status> = { passing: "passed", failing: "failed", not_run: "never", fixme: "fixme", draft: "draft", uncovered: "needs_review" };

function CriterionIcon({ status, size = 15 }: { status: CriterionStatus; size?: number }) {
  return <StatusIcon status={GLYPH[status]} size={size} title={CRITERION_LABEL[status]} />;
}

const reqLabel = (r: { key?: string; title: string }) => (r.key ? `${r.key} ${r.title}` : r.title);

/** Business requirements → acceptance criteria → the test cases that prove them, with where each
 *  stands (the traceability matrix). Requirements are pasted or imported; the analyst agent proposes
 *  criteria and links, the designer builds cases for what nothing covers. */
export function RequirementsView({ projectId, initialReqId, initialFilter, refreshSignal }: { projectId: string; initialReqId?: string; initialFilter?: string; refreshSignal?: number }) {
  const [data, setData] = useState<RequirementsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>(["uncovered", "failing", "passing"].includes(initialFilter ?? "") ? (initialFilter as Filter) : "all");
  const [detail, setDetail] = useState<Detail | null>(initialReqId ? { kind: "req", id: initialReqId } : null);
  const [runStarted, setRunStarted] = useState(false);

  const load = useCallback(() => {
    requirementsApi
      .load(projectId)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => setLoadError(String(err)));
  }, [projectId]);
  useEffect(load, [load, refreshSignal]);
  useEffect(() => {
    if (initialReqId) setDetail({ kind: "req", id: initialReqId });
  }, [initialReqId]);

  // While the analyst runs, poll its job; reload when it ends (its proposal shows up).
  const running = data?.job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      const { job } = await requirementsApi.job(projectId).catch(() => ({ job: null }));
      if (!job || job.state !== "running") load();
      else setData((d) => (d ? { ...d, job } : d));
    }, 2000);
    return () => clearInterval(timer);
  }, [running, projectId, load]);

  const mutate = useCallback(async <T extends RequirementsData>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      setData(res);
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  if (loadError) return <p className="muted coverage-body">Could not load requirements: {loadError}</p>;
  if (!data) return <p className="muted coverage-body">Loading&hellip;</p>;

  const closeDetail = () => {
    setDetail(null);
    if (initialReqId) clearParams(projectId, "requirements");
  };
  const s = data.summary;
  const linkedApproved = [...new Set(data.requirements.flatMap((r) => r.criteria.flatMap((c) => c.cases.filter((tc) => tc.status === "approved").map((tc) => tc.id))))];
  const shown = data.requirements.filter((r) =>
    filter === "all" ? true : filter === "passing" ? r.status === "passing" : r.criteria.some((c) => c.status === filter),
  );
  const runCases = async (ids: string[]) => {
    setError(null);
    const err = await startRun(projectId, { scope: "cases", caseIds: ids });
    if (err) return setError(err);
    setRunStarted(true);
    setTimeout(() => setRunStarted(false), 4000);
  };

  // ---- side panel ----
  let panel: React.ReactNode = null;
  const selected = detail?.kind === "req" ? data.requirements.find((r) => r.id === detail.id) : undefined;
  if (selected) {
    panel = (
      <RequirementPanel
        key={selected.id}
        projectId={projectId}
        data={data}
        req={selected}
        busy={busy}
        mutate={mutate}
        onRun={runCases}
        onDeleted={closeDetail}
        onClose={closeDetail}
      />
    );
  } else if (detail?.kind === "add") {
    panel = (
      <AddRequirementPanel
        projectId={projectId}
        busy={busy}
        mutate={mutate}
        onCreated={(id) => setDetail({ kind: "req", id })}
        onClose={closeDetail}
      />
    );
  } else if (detail?.kind === "import") {
    panel = <ImportPanel projectId={projectId} busy={busy} mutate={mutate} onImported={() => setDetail(null)} onClose={closeDetail} />;
  }

  const list = (
    <div className="cases-list-pane">
      {error && <Callout tone="danger">{error}</Callout>}
      {data.requirements.length === 0 ? (
        <EmptyState
          icon={Icon.requirements}
          title="No requirements yet"
          actions={
            <>
              <Button variant="primary" icon={Icon.add} onClick={() => setDetail({ kind: "add" })}>
                Add a requirement
              </Button>
              <Button icon={Icon.importFile} onClick={() => setDetail({ kind: "import" })}>
                Import a file
              </Button>
            </>
          }
        >
          Paste a user story with its acceptance criteria — or import many from a Markdown or CSV file. Each criterion gets linked to the test cases that prove it, so you see what&apos;s covered and
          whether it passes.
        </EmptyState>
      ) : shown.length === 0 ? (
        <p className="muted">Nothing matches this filter.</p>
      ) : (
        <div className="req-list">
          {shown.map((r) => {
            const covered = r.criteria.filter((c) => c.status !== "uncovered").length;
            return (
              <section key={r.id} className={cx("req-card", detail?.kind === "req" && detail.id === r.id && "selected")}>
                <button type="button" className="req-card-head" onClick={() => setDetail({ kind: "req", id: r.id })}>
                  <CriterionIcon status={r.status} size={17} />
                  {r.key && <span className="req-key">{r.key}</span>}
                  <span className="req-title">{r.title}</span>
                  {r.analysis && (
                    <Badge tone="ai" icon={Icon.ai}>
                      Analysis to review
                    </Badge>
                  )}
                  {data.job?.state === "running" && data.job.meta.requirementId === r.id && (
                    <Badge tone="ai" icon={Icon.spinner}>
                      Analyzing…
                    </Badge>
                  )}
                  <span className="ui-flex-spacer" />
                  <span className="req-coverage" title={`${covered} of ${r.criteria.length} criteria have a test case`}>
                    <span className="req-coverage-bar">
                      <span style={{ width: r.criteria.length ? `${(covered / r.criteria.length) * 100}%` : "0%" }} />
                    </span>
                    {covered}/{r.criteria.length}
                  </span>
                  <Icon.chevronRight size={16} className="case-row-chevron" aria-hidden />
                </button>
                {r.criteria.length === 0 ? (
                  <p className="req-empty muted">No acceptance criteria yet — open it to add them, or let the analyst propose them.</p>
                ) : (
                  <ul className="req-criteria">
                    {r.criteria.map((c) => (
                      <li key={c.id} className={cx("req-criterion", (filter === "uncovered" || filter === "failing") && c.status !== filter && "dim")}>
                        <CriterionIcon status={c.status} />
                        <span className="req-criterion-text">{c.text}</span>
                        <span className="req-case-chips">
                          {c.cases.map((tc) => (
                            <button key={tc.id} type="button" className={cx("req-case-chip", `is-${tc.status}`)} title={`Open "${tc.title}"`} onClick={() => navigate(projectId, "cases", { case: tc.id })}>
                              {tc.title}
                            </button>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className="app-layout">
      <PageHeader
        title={
          <>
            Requirements <HelpTip topic="requirements" />
          </>
        }
        meta={
          data.requirements.length > 0 && (
            <>
              <span>
                <strong>{s.requirements}</strong> requirement{s.requirements === 1 ? "" : "s"}
              </span>
              <span>
                <strong>
                  {s.covered}/{s.criteria}
                </strong>{" "}
                criteria covered
              </span>
              {s.passing > 0 && <Badge tone="success">{s.passing} passing</Badge>}
              {s.failing > 0 && <Badge tone="danger">{s.failing} failing</Badge>}
            </>
          )
        }
        actions={
          <>
            <Button variant="primary" icon={Icon.add} onClick={() => setDetail({ kind: "add" })}>
              Add requirement
            </Button>
            <Menu
              items={[
                { label: "Import a file (Markdown / CSV)", icon: Icon.importFile, onSelect: () => setDetail({ kind: "import" }) },
                data.requirements.length > 0 && { label: "Export traceability matrix (Markdown)", icon: Icon.exportManual, onSelect: () => (window.location.href = matrixUrl(projectId, "markdown", true)) },
                data.requirements.length > 0 && { label: "Export traceability matrix (CSV)", icon: Icon.exportManual, onSelect: () => (window.location.href = matrixUrl(projectId, "csv", true)) },
                linkedApproved.length > 0 && { label: runStarted ? "Run started — see Runs" : `Run all linked cases (${linkedApproved.length})`, icon: Icon.run, onSelect: () => void runCases(linkedApproved) },
              ]}
            />
          </>
        }
      >
        {data.requirements.length > 0 && (
          <Segmented<Filter>
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { id: "all", label: "All" },
              { id: "uncovered", label: "Uncovered", count: s.criteria - s.covered },
              { id: "failing", label: "Failing", count: s.failing },
              { id: "passing", label: "Passing" },
            ]}
          />
        )}
      </PageHeader>
      <SplitView list={list} detail={panel} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function RequirementPanel({
  projectId,
  data,
  req,
  busy,
  mutate,
  onRun,
  onDeleted,
  onClose,
}: {
  projectId: string;
  data: RequirementsData;
  req: RequirementView;
  busy: boolean;
  mutate: <T extends RequirementsData>(fn: () => Promise<T>) => Promise<T | null>;
  onRun: (caseIds: string[]) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const assistant = useAssistant();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(req.title);
  const [key, setKey] = useState(req.key ?? "");
  const [text, setText] = useState(req.text);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newCriterion, setNewCriterion] = useState("");
  const [editingCriterion, setEditingCriterion] = useState<{ id: string; text: string } | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const job = data.job;
  const analyzingThis = job?.state === "running" && job.meta.requirementId === req.id;
  const lastRunHere = job && job.state !== "running" && job.meta.requirementId === req.id ? job : null;
  const uncovered = req.criteria.filter((c) => c.status === "uncovered").length;
  const approvedCases = [...new Set(req.criteria.flatMap((c) => c.cases.filter((tc) => tc.status === "approved").map((tc) => tc.id)))];
  const allCases = [...new Set(req.criteria.flatMap((c) => c.caseIds))];
  const toInput = (): CriterionInput[] => req.criteria.map((c) => ({ id: c.id, text: c.text, caseIds: c.caseIds }));
  const saveCriteria = (criteria: CriterionInput[]) => mutate(() => requirementsApi.update(projectId, req.id, { criteria, baseUpdatedAt: data.updatedAt }));

  const analyze = async () => {
    setJobError(null);
    try {
      await requirementsApi.analyze(projectId, req.id);
      await mutate(() => requirementsApi.load(projectId));
    } catch (err) {
      setJobError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <DetailPanel
      eyebrow={<>Requirement{req.key ? ` · ${req.key}` : ""}</>}
      title={req.title}
      badges={
        <>
          <span className="case-panel-result">
            <CriterionIcon status={req.status} />
            {CRITERION_LABEL[req.status]}
          </span>
          <Badge tone="neutral">
            {req.criteria.filter((c) => c.status !== "uncovered").length}/{req.criteria.length} criteria covered
          </Badge>
          {req.source === "imported" && <Badge tone="neutral">Imported</Badge>}
        </>
      }
      actions={
        <>
          <Button size="sm" variant="primary" icon={Icon.ai} disabled={busy || job?.state === "running"} onClick={() => void analyze()} title="Text only, no browser — splits the story into criteria and links your existing cases. Uses plan quota (Settings › Analyst).">
            Analyze with AI
          </Button>
          {uncovered > 0 && (
            <Button size="sm" icon={Icon.design} onClick={() => assistant.open("design", { requirementId: req.id })}>
              Design cases for {uncovered} uncovered
            </Button>
          )}
          {approvedCases.length > 0 && (
            <Button size="sm" icon={Icon.run} onClick={() => onRun(approvedCases)}>
              Run its cases
            </Button>
          )}
        </>
      }
      menu={
        <Menu
          items={[
            { label: "Edit title & story", icon: Icon.edit, onSelect: () => setEditing(true) },
            allCases.length > 0 && {
              label: "Export its cases as manual test cases",
              icon: Icon.exportManual,
              onSelect: () => (window.location.href = manualExportUrl(projectId, { format: "markdown", caseIds: allCases, download: true })),
            },
            { label: "Delete…", icon: Icon.delete, danger: true, onSelect: () => setConfirmDelete(true) },
          ]}
        />
      }
      onClose={onClose}
    >
      {confirmDelete && (
        <Callout
          tone="danger"
          title={`Delete "${req.title}"?`}
          actions={
            <>
              <Button size="sm" variant="danger" disabled={busy} onClick={async () => (await mutate(() => requirementsApi.remove(projectId, req.id))) && onDeleted()}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          }
        >
          Its criteria and links go; the test cases stay.
        </Callout>
      )}
      {jobError && <Callout tone="danger">{jobError}</Callout>}
      {analyzingThis && (
        <Callout
          tone="ai"
          icon={Icon.spinner}
          title="The analyst is reading the story and your cases…"
          actions={
            <Button size="sm" variant="ghost" onClick={() => void requirementsApi.cancelJob(projectId).then(() => mutate(() => requirementsApi.load(projectId)))}>
              Cancel
            </Button>
          }
        >
          Text only, no browser. Its proposal shows up here for you to accept or discard.
          {job?.log.length ? <pre className="req-job-log">{job.log.slice(-6).join("\n")}</pre> : null}
        </Callout>
      )}
      {lastRunHere && !req.analysis && lastRunHere.state !== "succeeded" && (
        <Callout tone="warning" title={`Last analysis: ${lastRunHere.stopReason === "usage_limit" ? "stopped — plan usage limit nearly reached" : lastRunHere.state}`}>
          {lastRunHere.summary ?? "It ended without a proposal."}
        </Callout>
      )}

      {req.analysis && <ProposalReview projectId={projectId} data={data} req={req} busy={busy} mutate={mutate} />}

      {editing ? (
        <div className="req-edit">
          <Field label="Key">
            <input className="users-input" value={key} maxLength={40} placeholder="e.g. SHOP-42 (optional)" onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field label="Title">
            <input className="users-input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Story">
            <textarea className="users-input req-textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="req-edit-actions">
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !title.trim()}
              onClick={async () => {
                if (await mutate(() => requirementsApi.update(projectId, req.id, { title: title.trim(), key: key.trim() || null, text, baseUpdatedAt: data.updatedAt }))) setEditing(false);
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="req-story">{req.text ? req.text : <span className="muted">No story text.</span>}</div>
      )}

      <div className="req-usecase">
        <span className="req-label">Use case</span>
        <select
          className="users-input"
          value={req.useCaseId ?? ""}
          disabled={busy}
          onChange={(e) => void mutate(() => requirementsApi.update(projectId, req.id, { useCaseId: e.target.value || null, baseUpdatedAt: data.updatedAt }))}
        >
          <option value="">— None —</option>
          {data.useCases.map((u) => (
            <option key={u.id} value={u.id}>
              {u.feature} › {u.title}
            </option>
          ))}
        </select>
      </div>

      <h3 className="map-detail-h">
        Acceptance criteria <span className="map-detail-count">{req.criteria.length}</span> <HelpTip topic="criterionStatus" />
      </h3>
      <ul className="req-panel-criteria">
        {req.criteria.map((c, i) => (
          <li key={c.id} className="req-panel-criterion">
            <div className="req-panel-criterion-head">
              <CriterionIcon status={c.status} />
              <span className="req-criterion-id">{c.id}</span>
              {editingCriterion?.id === c.id ? (
                <form
                  className="req-inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const t = editingCriterion.text.trim();
                    if (!t) return;
                    if (await saveCriteria(toInput().map((x, j) => (j === i ? { ...x, text: t } : x)))) setEditingCriterion(null);
                  }}
                >
                  <input className="users-input" autoFocus value={editingCriterion.text} maxLength={1000} onChange={(e) => setEditingCriterion({ id: c.id, text: e.target.value })} />
                  <IconButton icon={Icon.check} size="sm" label="Save" type="submit" />
                  <IconButton icon={Icon.close} size="sm" label="Cancel" onClick={() => setEditingCriterion(null)} />
                </form>
              ) : (
                <span className="req-criterion-text">{c.text}</span>
              )}
              <span className="ui-flex-spacer" />
              <Menu
                size="sm"
                label={`More for ${c.id}`}
                items={[
                  { label: "Edit text", icon: Icon.edit, onSelect: () => setEditingCriterion({ id: c.id, text: c.text }) },
                  { label: "Link a test case…", icon: Icon.link, onSelect: () => setLinking(c.id) },
                  { label: "Remove criterion", icon: Icon.delete, danger: true, onSelect: () => void saveCriteria(toInput().filter((_, j) => j !== i)) },
                ]}
              />
            </div>
            <div className="req-panel-cases">
              <span className="req-status-text">{CRITERION_LABEL[c.status]}</span>
              {c.cases.map((tc) => (
                <span key={tc.id} className={cx("req-case-chip", `is-${tc.status}`)}>
                  <button type="button" onClick={() => navigate(projectId, "cases", { case: tc.id })} title={`${tc.status}${tc.last ? ` · last ${tc.last.status} ${timeAgo(tc.last.at)}` : ""}`}>
                    {tc.title}
                  </button>
                  <button
                    type="button"
                    className="req-chip-x"
                    aria-label={`Unlink "${tc.title}"`}
                    title="Unlink"
                    onClick={() => void saveCriteria(toInput().map((x, j) => (j === i ? { ...x, caseIds: x.caseIds.filter((id) => id !== tc.id) } : x)))}
                  >
                    <Icon.close size={11} aria-hidden />
                  </button>
                </span>
              ))}
              {linking === c.id ? (
                <select
                  className="users-input req-link-select"
                  autoFocus
                  defaultValue=""
                  onBlur={() => setLinking(null)}
                  onChange={async (e) => {
                    const id = e.target.value;
                    if (!id) return;
                    setLinking(null);
                    await saveCriteria(toInput().map((x, j) => (j === i ? { ...x, caseIds: [...x.caseIds, id] } : x)));
                  }}
                >
                  <option value="">Pick the case that proves it…</option>
                  {data.cases
                    .filter((tc) => !c.caseIds.includes(tc.id))
                    .map((tc) => (
                      <option key={tc.id} value={tc.id}>
                        {tc.title}
                        {tc.status === "draft" ? " (draft)" : ""}
                      </option>
                    ))}
                </select>
              ) : (
                <button type="button" className="req-link-btn" onClick={() => setLinking(c.id)}>
                  <Icon.add size={12} aria-hidden /> Link a case
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <form
        className="req-inline-form req-add-criterion"
        onSubmit={async (e) => {
          e.preventDefault();
          const t = newCriterion.trim();
          if (!t) return;
          if (await saveCriteria([...toInput(), { text: t, caseIds: [] }])) setNewCriterion("");
        }}
      >
        <input className="users-input" placeholder="Add an acceptance criterion, e.g. “Removing an item updates the total”" value={newCriterion} maxLength={1000} onChange={(e) => setNewCriterion(e.target.value)} />
        <Button type="submit" size="sm" icon={Icon.add} disabled={busy || !newCriterion.trim()}>
          Add
        </Button>
      </form>
      <p className="map-detail-meta">
        {req.source === "imported" ? "Imported" : "Added"} {timeAgo(req.createdAt)} · {allCases.length ? `${allCases.length} linked case${allCases.length === 1 ? "" : "s"} · ` : ""}
        tests tagged <code>@req-{req.id}</code>
      </p>
    </DetailPanel>
  );
}

/** The analyst's proposal for this requirement: what changes per criterion, then Accept / Discard. */
function ProposalReview({
  projectId,
  data,
  req,
  busy,
  mutate,
}: {
  projectId: string;
  data: RequirementsData;
  req: RequirementView;
  busy: boolean;
  mutate: <T extends RequirementsData>(fn: () => Promise<T>) => Promise<T | null>;
}) {
  const a = req.analysis!;
  const caseTitle = (id: string) => data.cases.find((c) => c.id === id)?.title ?? id;
  const useCase = a.useCaseId && !req.useCaseId ? data.useCases.find((u) => u.id === a.useCaseId) : undefined;
  return (
    <Callout
      tone="ai"
      title={`The analyst's proposal · ${timeAgo(a.createdAt)}`}
      className="req-proposal"
      actions={
        <>
          <Button size="sm" variant="primary" icon={Icon.check} disabled={busy} onClick={() => void mutate(() => requirementsApi.accept(projectId, req.id))}>
            Accept
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(() => requirementsApi.discard(projectId, req.id))}>
            Discard
          </Button>
        </>
      }
    >
      {a.summary && <p className="req-proposal-summary">{a.summary}</p>}
      <ul className="req-proposal-list">
        {a.criteria.map((p, i) => {
          const current = p.id ? req.criteria.find((c) => c.id === p.id) : undefined;
          const added = current ? p.caseIds.filter((id) => !current.caseIds.includes(id)) : p.caseIds;
          const tag = !current ? "new" : current.text !== p.text ? "reworded" : added.length ? "links added" : "unchanged";
          return (
            <li key={i}>
              <span className={cx("req-proposal-tag", `is-${tag.replace(" ", "-")}`)}>{tag}</span> {p.text}
              {p.caseIds.length > 0 ? (
                <div className="req-proposal-cases">→ {p.caseIds.map(caseTitle).join(", ")}</div>
              ) : (
                <div className="req-proposal-cases is-uncovered">→ no case proves it yet</div>
              )}
              {p.why && <div className="req-proposal-why">{p.why}</div>}
            </li>
          );
        })}
      </ul>
      {useCase && (
        <p className="req-proposal-summary">
          Use case: {useCase.feature} › {useCase.title}
        </p>
      )}
    </Callout>
  );
}

function AddRequirementPanel({
  projectId,
  busy,
  mutate,
  onCreated,
  onClose,
}: {
  projectId: string;
  busy: boolean;
  mutate: <T extends RequirementsData>(fn: () => Promise<T>) => Promise<T | null>;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  return (
    <DetailPanel
      eyebrow="New requirement"
      title="Add a requirement"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            icon={Icon.check}
            disabled={busy || !text.trim()}
            onClick={async () => {
              const res = await mutate(() => requirementsApi.create(projectId, text, title.trim() || undefined));
              if (res?.createdIds[0]) onCreated(res.createdIds[0]);
            }}
          >
            Save
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <p className="export-lead">
        Paste a user story and its acceptance criteria, as you have them. Bullets or numbered lines after an “Acceptance criteria” line become criteria; Gherkin scenarios work too. Several requirements
        at once: give each a <code># heading</code>. No criteria? Save it and let the analyst propose them.
      </p>
      <Field label="Title" hint="Optional — taken from the first line otherwise">
        <input className="users-input" value={title} maxLength={200} placeholder="e.g. SHOP-12: Cart total adds up" onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <textarea
        className="users-input req-textarea"
        rows={14}
        autoFocus
        value={text}
        placeholder={"SHOP-12: Cart total adds up\nAs a shopper I want the totals to add up so that I trust the price.\n\nAcceptance criteria:\n- The item total equals the sum of the item prices\n- The cart badge shows how many items are in the cart"}
        onChange={(e) => setText(e.target.value)}
      />
    </DetailPanel>
  );
}

function ImportPanel({
  projectId,
  busy,
  mutate,
  onImported,
  onClose,
}: {
  projectId: string;
  busy: boolean;
  mutate: <T extends RequirementsData>(fn: () => Promise<T>) => Promise<T | null>;
  onImported: () => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string; format: "markdown" | "csv" } | null>(null);
  const [preview, setPreview] = useState<ParsedRequirement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    setError(null);
    setPreview(null);
    if (!f) return;
    if (f.size > 1_000_000) return setError("That file is over 1 MB — split it up.");
    const text = await f.text();
    const format = /\.csv$/i.test(f.name) ? "csv" : "markdown";
    setFile({ name: f.name, text, format });
    try {
      setPreview((await requirementsApi.preview(projectId, text, format)).preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <DetailPanel
      eyebrow="Import"
      title="Import requirements"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            icon={Icon.importFile}
            disabled={busy || !file || !preview?.length}
            onClick={async () => {
              if (file && (await mutate(() => requirementsApi.importFile(projectId, file.text, file.format)))) onImported();
            }}
          >
            Import {preview?.length ? `${preview.length} requirement${preview.length === 1 ? "" : "s"}` : ""}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <p className="export-lead">
        <strong>Markdown</strong> (.md): one requirement per <code>#</code> or <code>##</code> heading — <code>SHOP-12: Title</code> keeps the key; bullets or numbered lines after “Acceptance criteria”
        (or Gherkin scenarios) become criteria. <strong>CSV</strong> (.csv, e.g. exported from Jira or Excel): columns <code>key</code>, <code>title</code> (or summary), <code>story</code> (or
        description) and <code>criteria</code> (one per line). The file is parsed by this dashboard&apos;s local server — nothing leaves your machine.
      </p>
      <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.csv,text/markdown,text/csv,text/plain" onChange={(e) => void pick(e.target.files?.[0])} />
      {error && <Callout tone="danger">{error}</Callout>}
      {preview && (
        <>
          <h3 className="map-detail-h">
            Found in {file?.name} <span className="map-detail-count">{preview.length}</span>
          </h3>
          <ul className="req-preview">
            {preview.map((p, i) => (
              <li key={i}>
                <strong>{reqLabel(p)}</strong>
                <span className="muted">
                  {" "}
                  · {p.criteria.length} criteri{p.criteria.length === 1 ? "on" : "a"}
                </span>
                {p.criteria.slice(0, 3).map((c, j) => (
                  <div key={j} className="req-preview-criterion">
                    – {c.split("\n")[0]}
                  </div>
                ))}
                {p.criteria.length > 3 && <div className="req-preview-criterion muted">… {p.criteria.length - 3} more</div>}
              </li>
            ))}
          </ul>
        </>
      )}
    </DetailPanel>
  );
}
