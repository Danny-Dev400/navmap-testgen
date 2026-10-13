import { useCallback, useEffect, useState } from "react";
import { PageHeader, StatusIcon } from "./ui/kit";
import { RunPanel } from "./RunPanel";
import { fetchRuns, formatDuration, openTrace, STATUS_ICON, timeAgo, type RunSummary, type RunTest } from "./runsClient";
import { TriageForTest, TriageHeader, useTriage } from "./TriagePanel";

/** Test-run history for a project (the last 20 dashboard runs), and one run's detail: per-test
 *  status, error, screenshots and video inline, and the trace opened in a local viewer window. */
export function RunsView({
  projectId,
  onBack,
  onOpenTestCase,
  initialRunId,
}: {
  projectId: string;
  onBack: () => void;
  onOpenTestCase: (caseId: string) => void;
  /** Deep link: ?run= opens that run. */
  initialRunId?: string;
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialRunId ?? null);
  useEffect(() => {
    if (initialRunId) setSelected(initialRunId);
  }, [initialRunId]);

  const load = useCallback(() => {
    fetchRuns(projectId)
      .then(({ runs }) => {
        setRuns(runs);
        setSelected((s) => s ?? runs[0]?.runId ?? null);
      })
      .catch(() => setRuns([]));
  }, [projectId]);

  useEffect(load, [load]);

  const run = runs?.find((r) => r.runId === selected);

  return (
    <div className="app-layout">
      <PageHeader title="Runs" meta={<span>The last 20 runs started from the dashboard</span>} />
      <div className="runs-body">
        <RunPanel projectId={projectId} refreshKey={0} onFinished={load} />
        {runs === null && <p className="muted">Loading&hellip;</p>}
        {runs?.length === 0 && <p className="muted">No runs yet — start one from Test cases (Run all, or a case's Run).</p>}
        {runs && runs.length > 0 && (
          <div className="runs-layout">
            <ul className="runs-list">
              {runs.map((r) => (
                <li key={r.runId}>
                  <button className={`runs-list-item${r.runId === selected ? " active" : ""}`} onClick={() => setSelected(r.runId)}>
                    <StatusIcon status={r.counts.failed > 0 ? "failed" : r.counts.flaky > 0 ? "flaky" : r.state !== "finished" ? "fixme" : r.counts.passed > 0 ? "passed" : "never"} size={17} />
                    <span className="runs-list-text">
                      <span className="runs-list-scope">{r.scope.label.replace(/^Test: /, "")}</span>
                      <span className="runs-list-when">
                        {timeAgo(r.finishedAt)} · <RunCounts summary={r} />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {run && <RunDetail projectId={projectId} run={run} onOpenTestCase={onOpenTestCase} />}
          </div>
        )}
      </div>
    </div>
  );
}

export function RunCounts({ summary }: { summary: RunSummary }) {
  const c = summary.counts;
  return (
    <span className="run-counts">
      <span className="run-status-passed">✓ {c.passed}</span>
      {c.failed > 0 && <span className="run-status-failed">✗ {c.failed}</span>}
      {c.flaky > 0 && <span className="run-status-flaky">≈ {c.flaky}</span>}
      {c.skipped + c.fixme > 0 && <span className="muted">⤼ {c.skipped + c.fixme}</span>}
      {summary.state !== "finished" && <span className="muted">({summary.state})</span>}
    </span>
  );
}

function RunDetail({ projectId, run, onOpenTestCase }: { projectId: string; run: RunSummary; onOpenTestCase: (caseId: string) => void }) {
  const [traceError, setTraceError] = useState<string | null>(null);
  const triage = useTriage(projectId, run.runId);
  // Failures first, then everything else in report order.
  const order: Record<RunTest["status"], number> = { failed: 0, flaky: 1, passed: 2, skipped: 3, fixme: 4 };
  const tests = run.tests.map((t, index) => ({ t, index })).sort((a, b) => order[a.t.status] - order[b.t.status]);
  const duration = Date.parse(run.finishedAt) - Date.parse(run.startedAt);

  return (
    <div className="run-detail">
      <div className="run-detail-header">
        <strong>{run.scope.label}</strong>
        <span className="muted">
          {new Date(run.finishedAt).toLocaleString()} &middot; {formatDuration(duration)}
          {run.scope.includeDestructive ? " · destructive included" : ""}
        </span>
        <RunCounts summary={run} />
      </div>
      {traceError && <div className="users-error">{traceError}</div>}
      <TriageHeader projectId={projectId} triage={triage} />
      <ul className="run-test-list">
        {tests.map(({ t, index }) => (
          <li key={index} className={`run-test run-test-${t.status}`}>
            <div className="run-test-row">
              <span className={`run-status-${t.status}`}>{STATUS_ICON[t.status]}</span>
              {t.caseId ? (
                <button className="link-button" onClick={() => onOpenTestCase(t.caseId!)}>
                  {t.title}
                </button>
              ) : (
                <span>{t.title}</span>
              )}
              <span className="muted">
                {t.browser} &middot; {formatDuration(t.durationMs)}
              </span>
              {t.artifacts.trace && (
                <button className="link-button" onClick={async () => setTraceError(await openTrace(projectId, run.runId, index))}>
                  Open trace
                </button>
              )}
            </div>
            {t.failedStep && <div className="run-failed-step">Failed in step <strong>{t.failedStep}</strong></div>}
            {t.error && <pre className="run-test-error">{t.error}</pre>}
            {(t.status === "failed" || t.status === "flaky") && <TriageForTest projectId={projectId} testIndex={index} triage={triage} />}
            {(t.artifacts.screenshots.length > 0 || t.artifacts.video) && (
              <div className="run-test-media">
                {t.artifacts.screenshots.map((s) => (
                  <a key={s} href={`/${s}`} target="_blank" rel="noreferrer">
                    <img src={`/${s}`} alt={`Screenshot of ${t.title}`} />
                  </a>
                ))}
                {t.artifacts.video && <video src={`/${t.artifacts.video}`} controls preload="metadata" />}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
