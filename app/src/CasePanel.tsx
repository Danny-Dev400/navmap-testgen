import { useEffect, useMemo, useState } from "react";
import { HelpTip } from "./help";
import { Lightbox } from "./Lightbox";
import { actionIcon, checkIcon } from "./testCaseIcons";
import { CodeView } from "./CodeView";
import { timeAgo, type LatestEntry } from "./runsClient";
import { Badge, Button, Callout, DetailPanel, Field, Menu, Segmented, StatusIcon, type Tone } from "./ui/kit";
import { Icon } from "./ui/icons";
import {
  casesApi,
  caseUseCaseIndex,
  featuresApi,
  hasEditableValue,
  pageAfter,
  setDestructiveFlag,
  STATUS_LABEL,
  type ActionView,
  type CasesData,
  type CasesResponse,
  type CaseStep,
  type CaseView,
  type Dataset,
  type Given,
  STATE_KIND_LABEL,
} from "./casesClient";
import { suggestRows } from "../../src/navmap-test-data";
import { projectHref } from "./nav";
import { manualExportUrl } from "./ManualExportPanel";
import type { AssertionType } from "../../src/types";

interface Draft {
  title: string;
  requires: string[];
  given: Given[];
  steps: CaseStep[];
  dataset?: Dataset;
}

const toDraft = (c: CaseView): Draft => ({
  title: c.title,
  requires: [...c.requires],
  given: (c.given ?? []).map((g) => ({ ...g })),
  steps: c.steps.map((s) => ({ ...s })),
  ...(c.dataset ? { dataset: structuredClone(c.dataset) } : {}),
});

/** Keeps only real overrides, so a step that changes nothing stays `{ edgeId }` and follows the
 *  map's recorded values as they evolve. */
function cleanStep(s: CaseStep, a: ActionView | undefined): CaseStep {
  const out: CaseStep = { edgeId: s.edgeId };
  if (s.on) out.on = s.on;
  const item = s.item?.trim();
  if (item && a?.item && item !== a.item) out.item = item;
  if (s.input !== undefined && a?.inputValue !== undefined && s.input !== a.inputValue) out.input = s.input;
  const form = Object.fromEntries(
    Object.entries(s.form ?? {}).filter(([label, value]) => {
      const recorded = a?.formFields?.find((f) => f.label === label);
      return recorded && value !== recorded.value;
    }),
  );
  if (Object.keys(form).length > 0) out.form = form;
  if (s.assert && a && s.assert.length < a.postconditions.length) out.assert = a.postconditions.map((p) => p.description).filter((d) => s.assert!.includes(d));
  const expect = Object.fromEntries(
    Object.entries(s.expect ?? {}).filter(([d, value]) => {
      const post = a?.postconditions.find((p) => p.description === d);
      const checked = !s.assert || s.assert.includes(d);
      return post && hasEditableValue(post) && checked && String(value).trim() !== "" && String(value) !== String(post.checkValue ?? "");
    }),
  );
  if (Object.keys(expect).length > 0) out.expect = expect;
  // Value captures and element checks (usually written by the design agent) are kept as they are.
  if (s.capture?.length) out.capture = s.capture;
  if (s.verify?.length) out.verify = s.verify;
  return out;
}

/** "📌 Product price (Sauce Labs Backpack) → backpackPrice" / "🟰 Item total = a + b". */
export function describeCapture(c: NonNullable<CaseStep["capture"]>[number], data: CasesData): string {
  const el = data.elements[c.element];
  return `📌 save ${el?.label ?? c.element}${c.item ? ` (${c.item})` : ""} as ${c.as}`;
}

export function describeVerify(v: NonNullable<CaseStep["verify"]>[number], data: CasesData): string {
  const el = data.elements[v.element];
  const what = `${el?.label ?? v.element}${v.item ? ` (${v.item})` : ""}`;
  if (v.op === "visible") return `👁️ ${what} is visible`;
  if (v.op === "hidden") return `🚫 ${what} is hidden`;
  const rhs = v.equalsSumOf ? v.equalsSumOf.join(" + ") : v.equalsVar ?? JSON.stringify(v.value);
  return `${v.op === "equals" ? "🟰" : "🔤"} ${what} ${v.op === "equals" ? "=" : "contains"} ${rhs}`;
}

export interface CaseModalProps {
  projectId: string;
  data: CasesData;
  /** null = a new case being composed. */
  testCase: CaseView | null;
  startPageId?: string;
  /** A new case created from a use case ("＋ Case" there) is filed under it. */
  presetUseCaseId?: string;
  /** A new case created from a map action starts with it as its first step. */
  presetEdgeId?: string;
  lastResult: LatestEntry | undefined;
  busy: boolean;
  onMutate: (fn: () => Promise<CasesResponse>) => Promise<CasesResponse | null>;
  onCreated: (caseId: string) => void;
  onDeleted: () => void;
  /** Starts a run of just this case; resolves to an error message or null. */
  onRun: () => Promise<string | null>;
  onReload: () => void;
  onClose: () => void;
}

const STATUS_TONE: Record<CaseView["status"] | "needs_review", { tone: Tone; label: string }> = {
  draft: { tone: "accent", label: "Draft" },
  approved: { tone: "success", label: "Approved" },
  rejected: { tone: "neutral", label: "Rejected" },
  needs_review: { tone: "warning", label: "Needs review" },
};

/** A test case in the side panel: what it does (Steps), its generated test (Code), and what to do
 *  with it (run, approve, edit…). Editing happens in place, with Save/Cancel pinned at the bottom. */
export function CasePanel({
  projectId,
  data,
  testCase,
  startPageId,
  presetUseCaseId,
  presetEdgeId,
  lastResult,
  busy,
  onMutate,
  onCreated,
  onDeleted,
  onRun,
  onReload,
  onClose,
  expanded,
  onToggleExpand,
}: CaseModalProps & { expanded: boolean; onToggleExpand: () => void }) {
  const isNew = testCase === null;
  const [tab, setTab] = useState<"steps" | "code">("steps");
  const [editing, setEditing] = useState(isNew);
  const [draft, setDraft] = useState<Draft>(() =>
    testCase ? toDraft(testCase) : { title: "", requires: [], given: [], steps: presetEdgeId && data.actions[presetEdgeId] ? [{ edgeId: presetEdgeId }] : [] },
  );
  const [startPage, setStartPage] = useState(startPageId ?? data.pages[0]?.id ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const currentUseCase = testCase ? (caseUseCaseIndex(data.organization).get(testCase.id)?.useCaseId ?? "") : (presetUseCaseId ?? "");
  const [newUseCase, setNewUseCase] = useState(presetUseCaseId ?? "");

  const pageTitle = (id: string | undefined) => (id ? (data.pages.find((p) => p.id === id)?.title ?? id) : "?");
  const caseTitle = (id: string) => data.cases.find((c) => c.id === id)?.title ?? id;

  const save = async () => {
    const steps = draft.steps.map((s) => cleanStep(s, data.actions[s.edgeId]));
    const title = draft.title.trim();
    if (!title) return setMessage("Give the case a title.");
    if (steps.length === 0) return setMessage("Add at least one step.");
    const res = await onMutate(() =>
      isNew
        ? casesApi.create(projectId, {
            title,
            steps,
            requires: draft.requires,
            ...(draft.given.length ? { given: draft.given } : {}),
            ...(draft.dataset ? { dataset: draft.dataset } : {}),
            ...(newUseCase ? { useCaseId: newUseCase } : {}),
          })
        : casesApi.update(projectId, testCase.id, { title, steps, requires: draft.requires, given: draft.given.length ? draft.given : null, dataset: draft.dataset ?? null }),
    );
    if (!res) return;
    setMessage(null);
    setEditing(false);
    if (isNew && res.createdId) onCreated(res.createdId);
  };
  const cancelEdit = () => {
    if (isNew) return onClose();
    setDraft(toDraft(testCase));
    setEditing(false);
    setMessage(null);
  };

  const setStatus = (status: CaseView["status"]) => testCase && onMutate(() => casesApi.update(projectId, testCase.id, { status }));
  const copyAsManual = async () => {
    if (!testCase) return;
    try {
      const res = await fetch(manualExportUrl(projectId, { format: "markdown", caseId: testCase.id }));
      if (!res.ok) throw new Error(`${res.status}`);
      await navigator.clipboard.writeText(await res.text());
      setMessage("Copied as a manual test case (Markdown).");
    } catch (err) {
      setMessage(`Could not copy it: ${String(err)}`);
    }
  };
  const toggleDestructive = async (edgeId: string, value: boolean | null) => {
    await setDestructiveFlag(projectId, edgeId, value);
    onReload();
  };

  const statusKey = testCase ? (testCase.health === "needs_review" && testCase.status !== "rejected" ? "needs_review" : testCase.status) : "draft";
  const lastAction = testCase ? data.actions[testCase.steps[testCase.steps.length - 1]?.edgeId] : undefined;
  const result = lastResult?.status;

  const badges = testCase ? (
    <>
      <Badge tone={STATUS_TONE[statusKey].tone}>{STATUS_TONE[statusKey].label}</Badge>
      {testCase.status === "approved" && !testCase.runnable && <Badge tone="warning" icon={Icon.fixme}>Can't run yet</Badge>}
      {testCase.status === "approved" && testCase.runnable && (
        <span className="case-panel-result">
          <StatusIcon status={result === "passed" || result === "failed" || result === "flaky" ? result : result === "skipped" || result === "fixme" ? "skipped" : "never"} size={15} />
          {lastResult ? `${lastResult.status} · ${timeAgo(lastResult.at)}` : "never run"}
        </span>
      )}
      {testCase.destructive && <Badge tone="danger" icon={Icon.destructive}>Destructive</Badge>}
      {testCase.origin === "agent" && <Badge tone="ai" icon={Icon.ai}>Designed by the agent</Badge>}
    </>
  ) : undefined;

  const actions =
    testCase && !editing ? (
      <>
        {testCase.status === "approved" && testCase.runnable && (
          <Button
            variant="primary"
            icon={Icon.run}
            onClick={async () => {
              const err = await onRun();
              setMessage(err ?? "Started — the result shows here and under Runs when it ends.");
            }}
          >
            Run
          </Button>
        )}
        {testCase.status === "draft" && (
          <Button variant="primary" icon={Icon.check} disabled={busy} onClick={() => setStatus("approved")}>
            Approve
          </Button>
        )}
        {testCase.status === "rejected" && (
          <Button icon={Icon.undo} disabled={busy} onClick={() => setStatus("draft")}>
            Restore as draft
          </Button>
        )}
        <Button
          icon={Icon.edit}
          onClick={() => {
            setTab("steps");
            setEditing(true);
          }}
        >
          Edit
        </Button>
      </>
    ) : undefined;

  const menu =
    testCase && !editing ? (
      <Menu
        items={[
          testCase.status === "draft" && { label: "Reject", icon: Icon.ban, onSelect: () => setStatus("rejected") },
          testCase.status === "approved" && { label: "Back to draft", icon: Icon.undo, onSelect: () => setStatus("draft") },
          {
            label: "Copy as manual test case",
            icon: Icon.copy,
            hint: "Its steps as a person would follow them (Markdown) — to paste in a ticket or doc",
            onSelect: () => void copyAsManual(),
          },
          {
            label: "Delete…",
            icon: Icon.delete,
            danger: true,
            hint: testCase.origin === "baseline" ? "Its action shows as 'without a case' again — Reject keeps it dismissed instead" : undefined,
            onSelect: () => setConfirmDelete(true),
          },
        ]}
      />
    ) : undefined;

  return (
    <DetailPanel
      eyebrow={isNew ? "New test case" : editing ? "Editing test case" : "Test case"}
      title={isNew ? draft.title.trim() || "Untitled case" : editing ? draft.title.trim() || testCase.title : testCase.title}
      badges={badges}
      actions={actions}
      menu={menu}
      onClose={() => (lightboxSrc ? setLightboxSrc(null) : onClose())}
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      footer={
        editing ? (
          <>
            <Button variant="primary" icon={Icon.check} loading={busy} onClick={save}>
              {isNew ? "Create draft" : "Save"}
            </Button>
            <Button variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
            {message && <span className="case-panel-message">{message}</span>}
          </>
        ) : undefined
      }
    >
      {confirmDelete && testCase && (
        <Callout
          tone="danger"
          title="Delete this case for good?"
          actions={
            <>
              <Button
                variant="danger"
                size="sm"
                icon={Icon.delete}
                disabled={busy}
                onClick={async () => {
                  if (await onMutate(() => casesApi.remove(projectId, testCase.id))) onDeleted();
                }}
              >
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
            </>
          }
        >
          {testCase.origin === "baseline" ? "Its action will show as “without a case” again — Reject keeps it dismissed instead." : "This removes the case and its generated test."}
        </Callout>
      )}
      {!editing && message && <Callout tone="info">{message}</Callout>}

      {testCase && !editing && testCase.health === "needs_review" && (
        <Callout tone="warning" title={<>The map changed under this case <HelpTip topic="needsReview" /></>}>
          <ul>
            {testCase.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </Callout>
      )}
      {testCase && !editing && testCase.health === "ok" && !testCase.runnable && testCase.blockers.length > 0 && (
        <Callout tone="warning" title={<>{testCase.status === "approved" ? "Can't run yet (generated as fixme)" : "Would be generated as fixme"} <HelpTip topic="fixme" /></>}>
          <ul>
            {testCase.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </Callout>
      )}

      {editing && (
        <Field label="Title">
          <input
            className="users-input case-title-input"
            placeholder="What this case checks, e.g. “Buy a backpack and finish checkout”"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            autoFocus={isNew}
          />
        </Field>
      )}

      {data.organization.exists && (
        <div className="case-panel-details">
          <label className="case-panel-detail">
            <span>Use case</span>
            <select
              className="users-input"
              value={isNew ? newUseCase : currentUseCase}
              disabled={busy}
              onChange={(e) => {
                if (isNew) return setNewUseCase(e.target.value);
                void onMutate(() => featuresApi.assign(projectId, [testCase.id], e.target.value || null));
              }}
            >
              <option value="">— Unsorted —</option>
              {data.organization.features.map((feature) => (
                <optgroup key={feature.id} label={feature.title}>
                  {feature.useCases.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <HelpTip topic="features" />
        </div>
      )}

      {testCase && (data.requirementsByCase?.[testCase.id]?.length ?? 0) > 0 && (
        <div className="case-panel-proves">
          <Icon.requirements size={14} aria-hidden />
          <span className="case-panel-proves-label">Proves</span>
          <span className="case-panel-proves-list">
            {data.requirementsByCase[testCase.id].map((p) => (
              <a key={`${p.requirementId}-${p.criterionId}`} href={projectHref(projectId, "requirements", { req: p.requirementId })} title={p.criterion}>
                {p.key ?? p.title} › {p.criterion.split("\n")[0]}
              </a>
            ))}
          </span>
        </div>
      )}

      {!editing && testCase && (
        <div className="case-panel-tabs">
          <Segmented
            options={[
              { id: "steps", label: "Steps", icon: Icon.cases },
              { id: "code", label: "Code", icon: Icon.code },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
      )}

      {tab === "code" && testCase && !editing && <CodeView projectId={projectId} caseId={testCase.id} preview={testCase.status !== "approved"} />}

      {tab === "steps" && !editing && testCase && (
        <ReadSteps
          projectId={projectId}
          testCase={testCase}
          data={data}
          pageTitle={pageTitle}
          caseTitle={caseTitle}
          onToggleDestructive={toggleDestructive}
          onToggleShareItem={async (link, value) => {
            await fetch(`/api/projects/${encodeURIComponent(projectId)}/links/share-item`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ edgeId: link.edgeId, precondition: link.precondition, shareItem: value }),
            });
            onReload();
          }}
        />
      )}

      {editing && <StepsEditor data={data} selfId={testCase?.id} draft={draft} setDraft={setDraft} startPage={startPage} setStartPage={setStartPage} pageTitle={pageTitle} />}

      {!editing && tab === "steps" && lastAction?.screenshot && (
        <figure className="side-panel-figure">
          <img className="side-panel-screenshot" src={lastAction.screenshot} alt="Last step's screenshot" onClick={() => setLightboxSrc(lastAction.screenshot!)} />
        </figure>
      )}
      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </DetailPanel>
  );
}

function ReadSteps({
  projectId,
  testCase,
  data,
  pageTitle,
  caseTitle,
  onToggleDestructive,
  onToggleShareItem,
}: {
  projectId: string;
  testCase: CaseView;
  data: CasesData;
  pageTitle: (id: string | undefined) => string;
  caseTitle: (id: string) => string;
  onToggleDestructive: (edgeId: string, value: boolean | null) => void;
  onToggleShareItem: (link: { edgeId: string; precondition: string }, value: boolean) => void;
}) {
  const first = data.actions[testCase.steps[0]?.edgeId];
  return (
    <>
      <p className="muted">
        {testCase.runAs ? `Runs as ${testCase.runAs}` : "No configured user can run it"} ·{" "}
        {testCase.origin === "baseline" ? "basic case for one action" : testCase.origin === "agent" ? "✨ designed by the agent" : "manual case"}
      </p>
      {testCase.notes && (
        <p className="case-rationale">
          <strong>{testCase.origin === "agent" ? "Why: " : "Notes: "}</strong>
          {testCase.notes}
        </p>
      )}
      {testCase.requires.length > 0 && (
        <>
          <p className="muted test-flow-section-label">Before this case, runs</p>
          <ul>
            {testCase.requires.map((id) => (
              <li key={id}>{caseTitle(id)}</li>
            ))}
          </ul>
        </>
      )}
      {first && first.preconditions.length > 0 && testCase.requires.length === 0 && (
        <>
          <p className="muted">Preconditions of the first step:</p>
          <ul>
            {first.preconditions.map((p, i) => {
              const via = testCase.givenChain.find((g) => g.via.kind === "precondition" && g.via.precondition === p && g.via.edgeId === first.id);
              return (
                <li key={i}>
                  {p}
                  {via ? (
                    <span className="muted"> → state “{via.title}”</span>
                  ) : (
                    <span className="muted"> → {/log(ged)?[\s-]?in/i.test(p) ? "tests start logged in" : "not linked to a state"}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {testCase.givenChain.length > 0 && (
        <>
          <p className="muted test-flow-section-label">
            Given — states the test is put in first <HelpTip topic="given" />
          </p>
          <ol className="test-flow-steps test-flow-setup">
            {testCase.givenChain.map((g, i) => (
              <li key={i} className="test-flow-step">
                <span className="test-flow-step-icon">🧩</span>
                <div>
                  <strong>
                    <a href={projectHref(projectId, "states", { state: g.stateId })} className="link-button">
                      {g.title}
                    </a>
                  </strong>
                  {g.item ? <span className="muted"> · item: {g.item}</span> : null}{" "}
                  <span className="state-kind-chip">{STATE_KIND_LABEL[g.kind]}</span>
                  <div className="muted">
                    {g.via.kind === "precondition"
                      ? `for “${g.via.precondition}” (${g.via.action})`
                      : g.via.kind === "requires"
                        ? `needed first by “${g.via.from}”`
                        : "asked for by this case"}
                  </div>
                  {g.steps.length > 0 ? (
                    <div className="muted">flow: {g.steps.map((s) => `${s.semanticIntent}${s.item ? ` (${s.item})` : ""} on ${s.pageTitle}`).join(" → ")}</div>
                  ) : (
                    <div className="muted">{g.kind === "initial" ? "already true at the start — nothing to do" : g.kind === "account" ? "runs as that state's user" : ""}</div>
                  )}
                  {g.canShareItem && g.via.kind === "precondition" && (
                    <label className="users-check case-share-item">
                      <input type="checkbox" checked={g.via.sameItem} onChange={(e) => onToggleShareItem(g.via as { edgeId: string; precondition: string }, e.target.checked)} />
                      use the same item as the action it prepares (instead of the one recorded in the flow) <HelpTip topic="sharedItem" />
                    </label>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      {testCase.dataset && <DatasetTable dataset={testCase.dataset} steps={testCase.steps} />}

      <p className="muted test-flow-section-label">Steps</p>
      <ol className="test-flow-steps case-steps">
        {testCase.steps.map((step, i) => {
          const a = data.actions[step.edgeId];
          if (!a) {
            return (
              <li key={i} className="test-flow-step">
                <span className="test-flow-step-icon">⚠️</span>
                <div>
                  Action <code>{step.edgeId}</code> is no longer in the map.
                </div>
              </li>
            );
          }
          const checked = (d: string) => !step.assert || step.assert.includes(d);
          return (
            <li key={i} className="test-flow-step case-step">
              <span className="test-flow-step-icon">{actionIcon(a.action)}</span>
              <div className="case-step-body">
                <div>
                  <strong>
                    {testCase.steps.length > 1 ? `${i + 1}. ` : ""}
                    {a.semanticIntent}
                  </strong>{" "}
                  <span className="muted">
                    on {pageTitle(step.on ?? a.fromPageId)}
                    {step.on && step.on !== a.fromPageId ? " (shared component)" : ""}
                  </span>
                </div>
                <div className="muted">
                  {a.action} · {a.target}
                </div>
                {(step.item || a.item) && <div className="muted">item: {step.item ?? a.item}{step.item ? " (changed)" : ""}</div>}
                {a.inputValue !== undefined && <div className="muted">input: {step.input ?? a.inputValue}{step.input !== undefined ? " (changed)" : ""}</div>}
                {a.formFields && a.formFields.length > 0 && (
                  <div className="muted">
                    form: {a.formFields.map((f) => `${f.label} = ${step.form?.[f.label] ?? f.value}${step.form?.[f.label] !== undefined ? " (changed)" : ""}`).join(" · ")}
                  </div>
                )}
                <ul className="case-checks">
                  {a.postconditions.map((p, j) => {
                    const expected = step.expect?.[p.description];
                    return (
                      <li key={j} className={checked(p.description) ? "" : "case-check-off"}>
                        {checkIcon(p.checkKind, p.assertionType as AssertionType)} {p.description}{" "}
                        {checked(p.description) && hasEditableValue(p) && (expected !== undefined || p.checkValue !== undefined) && (
                          <strong>
                            expects “{String(expected ?? p.checkValue)}”{expected !== undefined ? " (changed)" : ""}{" "}
                          </strong>
                        )}
                        <code className="muted">{checked(p.description) ? (p.checkKind ? `check: ${p.checkKind}` : `${p.assertionType} (no structured check)`) : "not checked"}</code>
                      </li>
                    );
                  })}
                  {a.postconditions.length === 0 && <li className="muted">No outcome recorded — only arrival on the next page is checked.</li>}
                  {(step.capture ?? []).map((c, j) => (
                    <li key={`c${j}`} className="case-value-line">
                      {describeCapture(c, data)}
                    </li>
                  ))}
                  {(step.verify ?? []).map((v, j) => (
                    <li key={`v${j}`} className="case-value-line">
                      {describeVerify(v, data)}
                    </li>
                  ))}
                </ul>
                <label className={`users-check case-step-destructive${a.destructive ? " on" : ""}`}>
                  <input type="checkbox" checked={a.destructive} onChange={(e) => onToggleDestructive(a.id, e.target.checked)} />
                  🧨 destructive action
                  <span className="muted">
                    {" "}
                    {a.destructiveSource === "user" ? (
                      <>
                        · set by you ·{" "}
                        <button className="link-button" onClick={() => onToggleDestructive(a.id, null)}>
                          reset to the agent's call
                        </button>
                      </>
                    ) : a.destructiveSource === "agent" ? (
                      "· tagged by the exploring agent"
                    ) : (
                      ""
                    )}
                  </span>
                </label>
              </div>
            </li>
          );
        })}
      </ol>

    </>
  );
}

/** Composes a case from actions that already exist in the map — never new locators. Each step
 *  offers only the overrides its action supports; the next step is picked from the actions
 *  available where the previous one leaves the browser. */
function StepsEditor({
  data,
  selfId,
  draft,
  setDraft,
  startPage,
  setStartPage,
  pageTitle,
}: {
  data: CasesData;
  selfId: string | undefined;
  draft: Draft;
  setDraft: (d: Draft) => void;
  startPage: string;
  setStartPage: (p: string) => void;
  pageTitle: (id: string | undefined) => string;
}) {
  const setStep = (i: number, s: CaseStep) => setDraft({ ...draft, steps: draft.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, delta: number) => {
    const steps = [...draft.steps];
    const [s] = steps.splice(i, 1);
    steps.splice(i + delta, 0, s);
    setDraft({ ...draft, steps });
  };
  const last = draft.steps[draft.steps.length - 1];
  const currentPage = last ? pageAfter(last, data.actions[last.edgeId]) : startPage;

  const here = useMemo(() => (currentPage ? (data.available[currentPage] ?? []) : []), [currentPage, data.available]);
  const elsewhere = useMemo(
    () =>
      data.pages
        .filter((p) => p.id !== currentPage)
        .map((p) => ({ page: p, edges: Object.values(data.actions).filter((a) => a.fromPageId === p.id) }))
        .filter((g) => g.edges.length > 0),
    [data, currentPage],
  );

  const requirable = data.cases.filter((c) => c.id !== selfId && c.status !== "rejected" && !draft.requires.includes(c.id));

  const statesById = new Map(data.states.map((s) => [s.id, s]));
  const givable = data.states.filter((s) => !draft.given.some((g) => g.state === s.id));

  return (
    <div className="case-editor">
      <p className="muted test-flow-section-label">
        Start from a state <span className="editor-optional">optional</span> <HelpTip topic="given" />
      </p>
      <p className="muted case-editor-hint">Its reusable flow runs before the steps. The first step's own preconditions are added automatically.</p>
      {draft.given.map((g, i) => {
        const st = statesById.get(g.state);
        return (
          <div key={g.state} className="case-require-row">
            <Icon.states size={14} aria-hidden /> {st?.title ?? g.state}
            {st?.perItem && (
              <input
                className="users-input case-given-item"
                placeholder="item (default: the recorded one)"
                value={g.item ?? ""}
                onChange={(e) => setDraft({ ...draft, given: draft.given.map((x, j) => (j === i ? { state: x.state, ...(e.target.value ? { item: e.target.value } : {}) } : x)) })}
              />
            )}
            <button className="link-button" onClick={() => setDraft({ ...draft, given: draft.given.filter((_, j) => j !== i) })} aria-label="Remove">
              ✕
            </button>
          </div>
        );
      })}
      {givable.length > 0 && (
        <select className="users-input" value="" onChange={(e) => e.target.value && setDraft({ ...draft, given: [...draft.given, { state: e.target.value }] })} aria-label="Add a state">
          <option value="">＋ Pick a state to start from…</option>
          {givable.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title} ({STATE_KIND_LABEL[s.kind]})
            </option>
          ))}
        </select>
      )}

      <p className="muted test-flow-section-label">
        Run another case first <span className="editor-optional">optional</span> <HelpTip topic="requires" />
      </p>
      <p className="muted case-editor-hint">Rarely needed now that states exist — tests already start logged in when a page requires it.</p>
      {draft.requires.map((id) => (
        <div key={id} className="case-require-row">
          {data.cases.find((c) => c.id === id)?.title ?? id}
          <button className="link-button" onClick={() => setDraft({ ...draft, requires: draft.requires.filter((r) => r !== id) })} aria-label="Remove">
            ✕
          </button>
        </div>
      ))}
      {requirable.length > 0 && (
        <select
          className="users-input"
          value=""
          onChange={(e) => e.target.value && setDraft({ ...draft, requires: [...draft.requires, e.target.value] })}
          aria-label="Add a required case"
        >
          <option value="">＋ Pick a case to run before this one…</option>
          {requirable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      )}

      <p className="muted test-flow-section-label">Steps</p>
      <p className="muted case-editor-hint">Each step is picked from what can be done where the previous one leaves you — with its data and what to verify after it.</p>
      {draft.steps.length === 0 && (
        <label className="users-check">
          Start on
          <select className="users-input" value={startPage} onChange={(e) => setStartPage(e.target.value)}>
            {data.pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <ol className="case-editor-steps">
        {draft.steps.map((step, i) => (
          <StepCard
            key={i}
            index={i}
            count={draft.steps.length}
            repeated={draft.steps.slice(0, i).some((s) => s.edgeId === step.edgeId)}
            data={data}
            step={step}
            action={data.actions[step.edgeId]}
            pageTitle={pageTitle}
            onChange={(s) => setStep(i, s)}
            onRemove={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}
            onMove={(d) => move(i, d)}
          />
        ))}
      </ol>
      {!(last && data.actions[last.edgeId]?.external?.opensNewTab) ? (
        <select
          className="users-input case-add-step"
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            const [edgeId, on] = e.target.value.split("|");
            setDraft({ ...draft, steps: [...draft.steps, { edgeId, ...(on ? { on } : {}) }] });
          }}
          aria-label="Add a step"
        >
          <option value="">＋ Add a step{currentPage ? ` — you're on ${pageTitle(currentPage)}` : ""}…</option>
          {here.length > 0 && (
            <optgroup label={`On ${pageTitle(currentPage)}`}>
              {here.map((h) => (
                <option key={`${h.edgeId}|${h.on ?? ""}`} value={`${h.edgeId}|${h.on ?? ""}`}>
                  {data.actions[h.edgeId]?.semanticIntent}
                  {h.on ? " (shared)" : ""}
                </option>
              ))}
            </optgroup>
          )}
          {elsewhere.map((g) => (
            <optgroup key={g.page.id} label={`${g.page.title} — goes there first`}>
              {g.edges.map((a) => (
                <option key={a.id} value={`${a.id}|`}>
                  {a.semanticIntent}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      ) : (
        <p className="muted">The last step opens a new tab, so it has to stay last.</p>
      )}
      <p className="muted case-editor-hint">Missing an action? Explore that part of the site from the Assistant — it shows up here once mapped.</p>
      <DatasetEditor data={data} draft={draft} setDraft={setDraft} />
    </div>
  );
}

function StepCard({
  index,
  count,
  repeated,
  data,
  step,
  action: a,
  pageTitle,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  count: number;
  /** The same action already appears earlier in the case. */
  repeated: boolean;
  data: CasesData;
  step: CaseStep;
  action: ActionView | undefined;
  pageTitle: (id: string | undefined) => string;
  onChange: (s: CaseStep) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const controls = (
    <span className="case-step-controls">
      <button className="link-button" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">
        ↑
      </button>
      <button className="link-button" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down">
        ↓
      </button>
      <button className="link-button users-danger" onClick={onRemove} aria-label="Remove step">
        ✕
      </button>
    </span>
  );
  if (!a) {
    return (
      <li className="case-step-card">
        <div className="case-step-card-header">
          <span>⚠️ Action {step.edgeId} is no longer in the map</span>
          {controls}
        </div>
      </li>
    );
  }
  const checked = (d: string) => !step.assert || step.assert.includes(d);
  const toggleCheck = (d: string, on: boolean) => {
    const current = step.assert ?? a.postconditions.map((p) => p.description);
    onChange({ ...step, assert: on ? [...new Set([...current, d])] : current.filter((x) => x !== d) });
  };
  return (
    <li className="case-step-card">
      <div className="case-step-card-header">
        <span>
          {actionIcon(a.action)} <strong>{index + 1}. {a.semanticIntent}</strong>{" "}
          <span className="muted">
            on {pageTitle(step.on ?? a.fromPageId)}
            {a.toPageId !== a.fromPageId && !a.external ? ` → ${pageTitle(a.toPageId)}` : ""}
          </span>
        </span>
        {controls}
      </div>
      {a.item && (
        <label className="users-check" title="This action exists once per list item — write the item's visible name">
          Which item
          <input className="users-input" placeholder={`${a.item} (as recorded)`} value={step.item ?? ""} onChange={(e) => onChange({ ...step, item: e.target.value || undefined })} />
        </label>
      )}
      {a.inputValue !== undefined && (
        <label className="users-check">
          Input
          <input className="users-input" value={step.input ?? a.inputValue} onChange={(e) => onChange({ ...step, input: e.target.value })} />
        </label>
      )}
      {a.formFields?.map((f) => (
        <label key={f.label} className="users-check">
          {f.label}
          <input
            className="users-input"
            value={step.form?.[f.label] ?? f.value}
            onChange={(e) => onChange({ ...step, form: { ...(step.form ?? {}), [f.label]: e.target.value } })}
          />
        </label>
      ))}
      {a.postconditions.length > 0 && (
        <div className="case-step-checks">
          <span className="muted">Verify right after this step: <HelpTip topic="expected" /></span>
          {a.postconditions.map((p) => {
            const on = checked(p.description);
            const editable = on && hasEditableValue(p);
            const override = step.expect?.[p.description];
            return (
              <div key={p.description} className="case-step-check">
                <label className="users-check">
                  <input type="checkbox" checked={on} onChange={(e) => toggleCheck(p.description, e.target.checked)} />
                  {checkIcon(p.checkKind, p.assertionType as AssertionType)} {p.description}
                </label>
                {editable && (
                  <label className="users-check case-expected">
                    expected {p.checkKind === "count" ? "count" : "text"}
                    <input
                      className="users-input"
                      inputMode={p.checkKind === "count" ? "numeric" : undefined}
                      value={String(override ?? p.checkValue ?? "")}
                      onChange={(e) => onChange({ ...step, expect: { ...(step.expect ?? {}), [p.description]: e.target.value } })}
                    />
                  </label>
                )}
                {editable && repeated && override === undefined && p.checkValue !== undefined && (
                  <div className="case-warning">
                    ⚠ This expects “{String(p.checkValue)}”, the value seen while exploring. This action already ran earlier in the case, so the value has
                    probably changed — set what you expect now, or uncheck it.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {((step.capture?.length ?? 0) > 0 || (step.verify?.length ?? 0) > 0) && (
        <div className="case-step-checks">
          <span className="muted">Values captured and checked after this step: <HelpTip topic="values" /></span>
          {(step.capture ?? []).map((c, j) => (
            <div key={`c${j}`} className="case-value-line">
              {describeCapture(c, data)}{" "}
              <button
                className="link-button users-danger"
                aria-label="Remove capture"
                onClick={() => onChange({ ...step, capture: step.capture!.filter((_, k) => k !== j) })}
              >
                ✕
              </button>
            </div>
          ))}
          {(step.verify ?? []).map((v, j) => (
            <div key={`v${j}`} className="case-value-line">
              {describeVerify(v, data)}{" "}
              <button
                className="link-button users-danger"
                aria-label="Remove check"
                onClick={() => onChange({ ...step, verify: step.verify!.filter((_, k) => k !== j) })}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

const PLACEHOLDER_RE = /\{\{([a-zA-Z][a-zA-Z0-9_]{0,30})\}\}/g;

/** Columns used as expected outcomes ("{{x}}" in expect / verify values) — they must be observed,
 *  so an empty one leaves that row's test as fixme. */
function expectedColumns(steps: CaseStep[]): Set<string> {
  const out = new Set<string>();
  const grab = (t: unknown) => {
    if (typeof t === "string") for (const m of t.matchAll(PLACEHOLDER_RE)) out.add(m[1]);
  };
  for (const s of steps) {
    for (const v of Object.values(s.expect ?? {})) grab(v);
    for (const v of s.verify ?? []) grab(v.value);
  }
  return out;
}

/** Read view of a case's data table: one generated test per row. */
function DatasetTable({ dataset, steps }: { dataset: Dataset; steps: CaseStep[] }) {
  const expected = expectedColumns(steps);
  return (
    <>
      <p className="muted test-flow-section-label">Data table — one test per row <HelpTip topic="dataTable" /></p>
      <div className="dataset-scroll">
        <table className="dataset-table">
          <thead>
            <tr>
              <th>Row</th>
              {dataset.columns.map((c) => (
                <th key={c}>
                  {`{{${c}}}`}
                  {expected.has(c) ? " (expected)" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dataset.rows.map((r, i) => (
              <tr key={i}>
                <td>{r.name}</td>
                {dataset.columns.map((c) => {
                  const v = r.values[c] ?? "";
                  const missing = expected.has(c) && !v.trim();
                  return (
                    <td key={c} className={missing ? "dataset-missing" : undefined} title={missing ? "Not observed yet — this row stays fixme" : undefined}>
                      {missing ? "⚠ not set" : v === "" ? <span className="muted">(empty)</span> : v.length > 40 ? `${v.slice(0, 40)}… (${v.length} chars)` : v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Edits the data table: rows × columns; steps use "{{column}}" in their values. "Suggest rows"
 *  fills inputs for a form step from rules (empty, too long, wrong format…) — never the expected
 *  outcome, which stays empty until someone observes it on the page. */
function DatasetEditor({ data, draft, setDraft }: { data: CasesData; draft: Draft; setDraft: (d: Draft) => void }) {
  const ds = draft.dataset;
  const formSteps = draft.steps.map((s, i) => ({ i, a: data.actions[s.edgeId] })).filter((x) => x.a?.formFields?.length);
  const set = (next: Dataset | undefined) => setDraft({ ...draft, dataset: next });
  const expected = expectedColumns(draft.steps);

  const suggest = (index: number) => {
    const a = data.actions[draft.steps[index].edgeId];
    if (!a?.formFields?.length) return;
    const suggested = suggestRows(a.formFields);
    const step = { ...draft.steps[index] };
    step.form = Object.fromEntries(a.formFields.map((f) => [f.label, `{{${suggested.fieldColumns[f.label]}}}`]));
    // The step's text/count checks expect a per-row outcome: a column nobody has filled in yet.
    const editable = a.postconditions.filter((p) => hasEditableValue(p) && (!step.assert || step.assert.includes(p.description)));
    // Reuse a placeholder the check already has (e.g. {{error}}); otherwise add an "expected" column.
    const extraCols: string[] = [];
    for (const p of editable) {
      const current = String(step.expect?.[p.description] ?? "");
      const reused = /^\{\{([a-zA-Z][a-zA-Z0-9_]{0,30})\}\}$/.exec(current)?.[1];
      const col = reused ?? "expected";
      step.expect = { ...(step.expect ?? {}), [p.description]: `{{${col}}}` };
      if (!extraCols.includes(col)) extraCols.push(col);
    }
    const columns = [...new Set([...(ds?.columns ?? []), ...suggested.columns, ...extraCols])];
    const blank = Object.fromEntries(columns.map((c) => [c, ""]));
    const rows = [...(ds?.rows ?? []).map((r) => ({ ...r, values: { ...blank, ...r.values } })), ...suggested.rows.map((r) => ({ ...r, values: { ...blank, ...r.values } }))];
    setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === index ? step : s)), dataset: { columns, rows: rows.slice(0, 40) } });
  };

  return (
    <div className="case-dataset">
      <p className="muted test-flow-section-label">
        Data table <span className="editor-optional">optional</span> <HelpTip topic="dataTable" />
      </p>
      <p className="muted case-editor-hint">
        Runs the case once per row — write <code>{"{{column}}"}</code> in a step value.
      </p>
      {formSteps.length > 0 && (
        <select className="users-input" value="" onChange={(e) => e.target.value !== "" && suggest(Number(e.target.value))} aria-label="Suggest rows from a form step">
          <option value="">✨ Suggest rows from a form step (rule-based inputs, no AI)…</option>
          {formSteps.map(({ i, a }) => (
            <option key={i} value={i}>
              Step {i + 1}: {a!.semanticIntent}
            </option>
          ))}
        </select>
      )}
      {!ds ? (
        <button className="link-button" onClick={() => set({ columns: ["value"], rows: [{ name: "row 1", values: { value: "" } }] })}>
          ＋ Add a data table
        </button>
      ) : (
        <>
          {expected.size > 0 && (
            <p className="case-warning">
              Expected-value columns ({[...expected].map((c) => `{{${c}}}`).join(", ")}) must come from what the page really shows. Rows left empty stay fixme.
            </p>
          )}
          <div className="dataset-scroll">
            <table className="dataset-table">
              <thead>
                <tr>
                  <th>Row name</th>
                  {ds.columns.map((c, ci) => (
                    <th key={ci}>
                      <input
                        className="users-input dataset-col"
                        value={c}
                        onChange={(e) => {
                          const name = e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 30);
                          set({
                            columns: ds.columns.map((x, k) => (k === ci ? name : x)),
                            rows: ds.rows.map((r) => {
                              const { [c]: old, ...rest } = r.values;
                              return { ...r, values: { ...rest, [name]: old ?? "" } };
                            }),
                          });
                        }}
                      />
                      <button
                        className="link-button users-danger"
                        aria-label="Remove column"
                        onClick={() => set({ columns: ds.columns.filter((_, k) => k !== ci), rows: ds.rows.map((r) => ({ ...r, values: Object.fromEntries(Object.entries(r.values).filter(([k]) => k !== c)) })) })}
                      >
                        ✕
                      </button>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {ds.rows.map((r, ri) => (
                  <tr key={ri}>
                    <td>
                      <input className="users-input" value={r.name} onChange={(e) => set({ ...ds, rows: ds.rows.map((x, k) => (k === ri ? { ...x, name: e.target.value } : x)) })} />
                    </td>
                    {ds.columns.map((c) => (
                      <td key={c} className={expected.has(c) && !(r.values[c] ?? "").trim() ? "dataset-missing" : undefined}>
                        <input
                          className="users-input"
                          value={r.values[c] ?? ""}
                          placeholder={expected.has(c) ? "observed value" : ""}
                          onChange={(e) => set({ ...ds, rows: ds.rows.map((x, k) => (k === ri ? { ...x, values: { ...x.values, [c]: e.target.value } } : x)) })}
                        />
                      </td>
                    ))}
                    <td>
                      <button className="link-button users-danger" aria-label="Remove row" onClick={() => set(ds.rows.length > 1 ? { ...ds, rows: ds.rows.filter((_, k) => k !== ri) } : undefined)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dataset-actions">
            <button
              className="link-button"
              onClick={() => set({ ...ds, rows: [...ds.rows, { name: `row ${ds.rows.length + 1}`, values: Object.fromEntries(ds.columns.map((c) => [c, ""])) }] })}
            >
              ＋ Row
            </button>
            <button
              className="link-button"
              onClick={() => {
                const name = `col${ds.columns.length + 1}`;
                set({ columns: [...ds.columns, name], rows: ds.rows.map((r) => ({ ...r, values: { ...r.values, [name]: "" } })) });
              }}
            >
              ＋ Column
            </button>
            <button className="link-button users-danger" onClick={() => set(undefined)}>
              Remove the table
            </button>
          </div>
        </>
      )}
    </div>
  );
}
