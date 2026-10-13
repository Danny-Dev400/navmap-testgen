import { useMemo, useState, type ReactNode } from "react";
import { DetailPanel } from "./ui/kit";
import { HelpTip } from "./help";
import { actionIcon } from "./testCaseIcons";
import { caseUseCaseIndex, organizationDefs, type CasesData, type FeatureDef, type ProposalView } from "./casesClient";

/** The organization editors open in the side panel, next to the case list. */
function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <DetailPanel eyebrow="Organization" title={title} onClose={onClose}>
      {children}
    </DetailPanel>
  );
}

/** Create / edit / delete a feature. Saves the whole organization through `onSave`. */
export function FeatureEditor({
  data,
  featureId,
  busy,
  onSave,
  onClose,
}: {
  data: CasesData;
  /** null = new feature. */
  featureId: string | null;
  busy: boolean;
  onSave: (features: FeatureDef[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const defs = useMemo(() => organizationDefs(data.organization), [data.organization]);
  const existing = featureId ? defs.find((f) => f.id === featureId) : undefined;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const caseCount = existing?.useCases.reduce((n, u) => n + u.cases.length, 0) ?? 0;

  const save = async () => {
    const next = existing
      ? defs.map((f) => (f.id === featureId ? { ...f, title: title.trim(), description: description.trim() || undefined } : f))
      : [...defs, { title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}), useCases: [] }];
    if (await onSave(next)) onClose();
  };
  const remove = async () => {
    if (await onSave(defs.filter((f) => f.id !== featureId))) onClose();
  };

  return (
    <Modal title={existing ? "Edit feature" : "New feature"} onClose={onClose}>
      <label className="org-field">
        <span>Title</span>
        <input className="users-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Shopping cart" autoFocus maxLength={120} />
      </label>
      <label className="org-field">
        <span>Description (optional)</span>
        <input className="users-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this capability lets users do" maxLength={500} />
      </label>
      {existing && (
        <p className="muted">
          Tag in the generated code: <code>@feature-{existing.id}</code> (kept when you rename it) <HelpTip topic="featureTags" />
        </p>
      )}
      <div className="org-actions">
        <button className="primary-button" disabled={busy || !title.trim()} onClick={save}>
          {existing ? "Save" : "Create feature"}
        </button>
        <button className="link-button" onClick={onClose}>
          Cancel
        </button>
        {existing && !confirmDelete && (
          <button className="link-button users-danger org-delete" onClick={() => setConfirmDelete(true)}>
            Delete feature
          </button>
        )}
      </div>
      {confirmDelete && existing && (
        <div className="org-confirm">
          Delete "{existing.title}" and its {existing.useCases.length} use case{existing.useCases.length === 1 ? "" : "s"}?
          {caseCount > 0 && ` Its ${caseCount} case${caseCount === 1 ? "" : "s"} go to Unsorted — no case is deleted.`}
          <button className="link-button users-danger" disabled={busy} onClick={remove}>
            Yes, delete
          </button>
          <button className="link-button" onClick={() => setConfirmDelete(false)}>
            Keep it
          </button>
        </div>
      )}
    </Modal>
  );
}

/** Create / edit / move / delete a use case, including which map actions carry it. */
export function UseCaseEditor({
  data,
  featureId,
  useCaseId,
  busy,
  onSave,
  onClose,
}: {
  data: CasesData;
  featureId: string;
  /** null = new use case in featureId. */
  useCaseId: string | null;
  busy: boolean;
  onSave: (features: FeatureDef[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const defs = useMemo(() => organizationDefs(data.organization), [data.organization]);
  const existing = useCaseId ? defs.flatMap((f) => f.useCases).find((u) => u.id === useCaseId) : undefined;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [target, setTarget] = useState(featureId);
  const [actions, setActions] = useState<Set<string>>(new Set(existing?.actions ?? []));
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Which other use cases already list each action (an action can serve several).
  const usedBy = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const f of defs) for (const u of f.useCases) if (u.id !== useCaseId) for (const a of u.actions) out.set(a, [...(out.get(a) ?? []), u.title]);
    return out;
  }, [defs, useCaseId]);

  const save = async () => {
    const useCase = {
      ...(existing ?? { cases: [] }),
      title: title.trim(),
      description: description.trim() || undefined,
      actions: Object.keys(data.actions).filter((id) => actions.has(id)),
    };
    const without = defs.map((f) => ({ ...f, useCases: f.useCases.filter((u) => !existing || u.id !== useCaseId) }));
    const next = without.map((f) => {
      if (f.id !== target) return f;
      if (!existing) return { ...f, useCases: [...f.useCases, useCase] };
      // Keep its place when it stays in the same feature.
      const at = defs.find((x) => x.id === target)?.useCases.findIndex((u) => u.id === useCaseId) ?? -1;
      const list = [...f.useCases];
      list.splice(at < 0 ? list.length : at, 0, useCase);
      return { ...f, useCases: list };
    });
    if (await onSave(next)) onClose();
  };
  const remove = async () => {
    if (await onSave(defs.map((f) => ({ ...f, useCases: f.useCases.filter((u) => u.id !== useCaseId) })))) onClose();
  };

  const q = query.trim().toLowerCase();
  return (
    <Modal title={existing ? "Edit use case" : "New use case"} onClose={onClose} wide>
      <label className="org-field">
        <span>Title — a goal a user has</span>
        <input className="users-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Add a product to the cart" autoFocus maxLength={120} />
      </label>
      <label className="org-field">
        <span>Description (optional)</span>
        <input className="users-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line, in the user's words" maxLength={500} />
      </label>
      <label className="org-field">
        <span>Feature</span>
        <select className="users-input" value={target} onChange={(e) => setTarget(e.target.value)}>
          {defs.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title}
            </option>
          ))}
        </select>
      </label>
      <div className="org-field">
        <span>
          Map actions that carry it ({actions.size}) — they set its coverage and suggest where new cases belong
        </span>
        <input className="users-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter actions…" />
        <div className="org-action-list">
          {data.pages.map((p) => {
            const onPage = Object.values(data.actions).filter((a) => a.fromPageId === p.id && (!q || a.semanticIntent.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)));
            if (onPage.length === 0) return null;
            return (
              <div key={p.id} className="org-action-page">
                <div className="muted org-action-page-title">{p.title}</div>
                {onPage.map((a) => (
                  <label key={a.id} className="org-action">
                    <input
                      type="checkbox"
                      checked={actions.has(a.id)}
                      onChange={(e) =>
                        setActions((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(a.id);
                          else next.delete(a.id);
                          return next;
                        })
                      }
                    />
                    {actionIcon(a.action)} {a.semanticIntent}
                    {usedBy.get(a.id) && <span className="muted org-action-used"> · also in {usedBy.get(a.id)!.join(", ")}</span>}
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <div className="org-actions">
        <button className="primary-button" disabled={busy || !title.trim() || !target} onClick={save}>
          {existing ? "Save" : "Create use case"}
        </button>
        <button className="link-button" onClick={onClose}>
          Cancel
        </button>
        {existing && !confirmDelete && (
          <button className="link-button users-danger org-delete" onClick={() => setConfirmDelete(true)}>
            Delete use case
          </button>
        )}
      </div>
      {confirmDelete && existing && (
        <div className="org-confirm">
          Delete "{existing.title}"?{existing.cases.length > 0 && ` Its ${existing.cases.length} case${existing.cases.length === 1 ? "" : "s"} go to Unsorted — no case is deleted.`}
          <button className="link-button users-danger" disabled={busy} onClick={remove}>
            Yes, delete
          </button>
          <button className="link-button" onClick={() => setConfirmDelete(false)}>
            Keep it
          </button>
        </div>
      )}
    </Modal>
  );
}

const FEATURE_MARK = { new: "🆕 new", renamed: "✏️ renamed" } as const;
const USE_CASE_MARK = { new: "🆕 new", renamed: "✏️ renamed", moved: "➜ moved here" } as const;

/** The organizer's proposal as the tree it would become, with what changes marked — accept or discard. */
export function ProposalModal({
  data,
  proposal,
  busy,
  onAccept,
  onDiscard,
  onClose,
}: {
  data: CasesData;
  proposal: ProposalView;
  busy: boolean;
  onAccept: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const { diff } = proposal;
  const titles = useMemo(() => new Map(data.cases.map((c) => [c.id, c.title])), [data.cases]);
  const current = useMemo(() => caseUseCaseIndex(data.organization), [data.organization]);
  const placed = new Set(proposal.features.flatMap((f) => f.useCases.flatMap((u) => u.cases)));
  const leftOut = data.cases.filter((c) => c.status !== "rejected" && !placed.has(c.id));
  // A first organization is all new: marks only help when there is something to compare with.
  const marks = data.organization.exists;
  const removed = diff.removedFeatures.length + diff.removedUseCases.length + diff.unsortedCases.length;

  return (
    <Modal
      title={
        <>
          Proposed organization <HelpTip topic="organizer" />
        </>
      }
      onClose={onClose}
      wide
    >
      <p>
        <strong>{diff.summary}</strong>
        <span className="muted"> · proposed {new Date(proposal.createdAt).toLocaleString()}</span>
      </p>
      {proposal.request && <p className="muted">You asked: "{proposal.request}"</p>}
      {proposal.rationale && <p className="org-rationale">{proposal.rationale}</p>}
      {removed > 0 && (
        <div className="users-error">
          This proposal removes things you have now:{" "}
          {[
            ...diff.removedFeatures.map((f) => `feature "${f.title}"`),
            ...diff.removedUseCases.map((u) => `use case "${u.title}" (${u.featureTitle})`),
            ...(diff.unsortedCases.length ? [`${diff.unsortedCases.length} case assignment(s)`] : []),
          ].join(", ")}
          . Their cases would go to Unsorted — no case is deleted.
        </div>
      )}
      <div className="org-proposal-tree">
        {proposal.features.map((f) => (
          <div key={f.id} className="org-proposal-feature">
            <div className="org-proposal-feature-title">
              <strong>{f.title}</strong>
              {marks && diff.features[f.id] && <span className="org-mark">{FEATURE_MARK[diff.features[f.id]]}</span>}
              {f.description && <span className="muted"> — {f.description}</span>}
            </div>
            <ul>
              {f.useCases.map((u) => (
                <li key={u.id}>
                  <details>
                    <summary>
                      {u.title}
                      {marks && diff.useCases[u.id] && <span className="org-mark">{USE_CASE_MARK[diff.useCases[u.id]]}</span>}
                      <span className="muted">
                        {" "}
                        · {u.cases.length} case{u.cases.length === 1 ? "" : "s"} · {u.actions.length} action{u.actions.length === 1 ? "" : "s"}
                      </span>
                    </summary>
                    {u.description && <p className="muted">{u.description}</p>}
                    <ul className="org-proposal-cases">
                      {u.cases.map((c) => (
                        <li key={c}>
                          {titles.get(c) ?? c}
                          {diff.cases[c] === "moved" && <span className="org-mark">➜ moved from {current.get(c)?.useCaseTitle}</span>}
                        </li>
                      ))}
                    </ul>
                    <div className="muted org-proposal-actions">Actions: {u.actions.map((a) => data.actions[a]?.semanticIntent ?? a).join(" · ") || "none"}</div>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {leftOut.length > 0 && (
        <p className="muted">
          Left unsorted ({leftOut.length}): {leftOut.map((c) => c.title).join(", ")}
        </p>
      )}
      <div className="org-actions">
        <button className="primary-button" disabled={busy} onClick={onAccept}>
          Accept organization
        </button>
        <button className="link-button users-danger" disabled={busy} onClick={onDiscard}>
          Discard
        </button>
        <button className="link-button" onClick={onClose}>
          Decide later
        </button>
      </div>
      <p className="muted org-footnote">Accepting only organizes cases: no case changes, and the generated tests only gain their feature tag.</p>
    </Modal>
  );
}
