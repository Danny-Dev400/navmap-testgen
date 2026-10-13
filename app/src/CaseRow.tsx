import type { ReactNode } from "react";
import type { LatestStatus } from "./runsClient";
import type { CaseView, CasesData } from "./casesClient";
import { Badge, StatusIcon, cx, type Status } from "./ui/kit";
import { Icon } from "./ui/icons";
import type { CaseSelection } from "./CaseSelection";

/** Where a case stands, as one glyph: its last result when it runs, otherwise why it doesn't. */
export function caseStatus(c: Pick<CaseView, "id" | "status" | "health" | "runnable">, latest: LatestStatus): Status {
  if (c.status === "rejected") return "rejected";
  if (c.health === "needs_review") return "needs_review";
  if (c.status === "draft") return "draft";
  if (!c.runnable) return "fixme";
  const r = latest.cases[c.id]?.status;
  return r === "passed" || r === "failed" || r === "flaky" ? r : r === "skipped" || r === "fixme" ? "skipped" : "never";
}

/** One case in a list (by feature or by page): status, title, a meta line, and a badge only when
 *  something is off (draft, needs review, can't run, rejected). */
export function CaseRow({
  c,
  data,
  latest,
  onOpen,
  extra,
  selected,
  selection,
}: {
  c: CaseView;
  data: CasesData;
  latest: LatestStatus;
  onOpen: () => void;
  extra?: ReactNode;
  /** Open in the side panel. */
  selected?: boolean;
  /** Checkbox selection (any mix of cases) — the row shows a checkbox on hover. */
  selection?: CaseSelection;
}) {
  const status = caseStatus(c, latest);
  const result = latest.cases[c.id];
  const stepCount = c.steps.length + c.requiredSteps;
  const note = c.health === "needs_review" ? c.reasons[0] : c.status === "approved" && !c.runnable ? c.blockers[0] : undefined;
  const meta = [
    stepCount > 1 ? `${stepCount} steps` : data.pages.find((p) => p.id === c.firstPageId)?.title,
    c.status === "approved" && c.runnable ? (result ? `${result.status} ${timeAgoShort(result.at)}` : "never run") : undefined,
  ].filter(Boolean);
  return (
    <li className={cx(!!extra && "case-row-with-extra", selection && "case-li-selectable", selection?.has(c.id) && "is-checked")} data-case-id={c.id}>
      {selection && (
        <input
          type="checkbox"
          className={cx("select-check case-check", selection.has(c.id) && "is-checked")}
          checked={selection.has(c.id)}
          onChange={() => undefined}
          onClick={(e) => {
            e.stopPropagation();
            selection.toggle(c.id, e.shiftKey);
          }}
          aria-label={`Select "${c.title}"`}
          title="Select (Shift-click selects a range)"
        />
      )}
      <button className={cx("coverage-case-row", `case-row-${c.status}`, selected && "selected")} onClick={onOpen} aria-current={selected ? "true" : undefined}>
        <StatusIcon status={status} size={17} />
        <span className="coverage-case-title">
          <span className="case-row-title">{c.title}</span>
          <span className="case-row-meta">
            {meta.join(" · ")}
            {c.givenChain.length > 0 && (
              <span className="case-row-meta-item" title={`Given: ${c.givenChain.map((g) => g.title).join(" → ")}`}>
                <Icon.states size={12} aria-hidden /> {c.givenChain.length}
              </span>
            )}
            {c.origin === "agent" && (
              <span className="case-row-meta-item case-row-ai" title="Designed by the agent">
                <Icon.ai size={12} aria-hidden /> agent
              </span>
            )}
            {c.destructive && (
              <span className="case-row-meta-item case-row-destructive" title="Destructive — excluded from default runs">
                <Icon.destructive size={12} aria-hidden /> destructive
              </span>
            )}
          </span>
          {note && <span className="case-row-note">{note}</span>}
        </span>
        {status === "draft" && <Badge tone="accent">Draft</Badge>}
        {status === "needs_review" && <Badge tone="warning">Needs review</Badge>}
        {status === "fixme" && <Badge tone="neutral">Can't run yet</Badge>}
        {status === "rejected" && <Badge tone="neutral">Rejected</Badge>}
        <Icon.chevronRight size={16} className="case-row-chevron" aria-hidden />
      </button>
      {extra}
    </li>
  );
}

function timeAgoShort(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
