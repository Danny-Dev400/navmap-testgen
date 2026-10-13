import { useCallback, useEffect, useRef, useState } from "react";
import { HelpTip } from "./help";
import { structuredPatch } from "diff";
import { startRun } from "./runsClient";

// Client mirror of app/plugins/triage.ts + src/navmap-triage.ts.
export interface TriageHint {
  category: "environment" | "session" | "locator-ambiguous" | "locator-missing" | "navigation" | "assertion" | "unknown";
  reason: string;
  rerunFirst: boolean;
}

export interface TriageRecord {
  id: string;
  runId: string;
  testIndex: number;
  caseId: string;
  title: string;
  classification: "app_bug" | "test_bug" | "environment";
  subtype?: string;
  explanation: string;
  evidence: string[];
  proposal?: { target: "map" | "case" } & Record<string, unknown>;
  status: "report" | "proposed" | "applied" | "rejected";
  before?: unknown;
  after?: unknown;
  verification?: { result: "passed" | "failed" | "skipped"; runId?: string; reason?: string; at: string };
}

interface Failure {
  testIndex: number;
  title: string;
  caseId: string | null;
  hint: TriageHint;
  record: TriageRecord | null;
}

interface TriageJob {
  state: "running" | "succeeded" | "failed" | "cancelled";
  stopReason?: "usage_limit";
  meta: { runId?: string; testIndexes?: number[]; liveView?: boolean; verifying?: boolean };
  costUsd?: number;
  summary?: string;
  log: string[];
}

const HINT_ICON: Record<TriageHint["category"], string> = {
  environment: "🌐",
  session: "🔑",
  "locator-ambiguous": "👯",
  "locator-missing": "🔍",
  navigation: "🧭",
  assertion: "🔤",
  unknown: "❔",
};

const CLASS_LABEL: Record<TriageRecord["classification"], string> = {
  app_bug: "🐞 App bug",
  test_bug: "🧪 Test bug",
  environment: "🌐 Environment",
};

/** Loads a run's failures (free hints + saved verdicts) and the project's triage job; polls while
 *  the agent works or fixes are being verified. */
export function useTriage(projectId: string, runId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const [failures, setFailures] = useState<Map<number, Failure>>(new Map());
  const [job, setJob] = useState<TriageJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`${base}/runs/${runId}/triage`);
    if (!res.ok) return;
    const body = await res.json();
    setFailures(new Map((body.failures as Failure[]).map((f) => [f.testIndex, f])));
    setJob(body.job);
  }, [base, runId]);
  useEffect(() => {
    void load();
  }, [load]);

  const busy = job?.state === "running" || !!job?.meta?.verifying;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [busy, load]);

  const start = async (testIndexes: number[], allowDestructive: boolean) => {
    setError(null);
    const res = await fetch(`${base}/runs/${runId}/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testIndexes, allowDestructive }),
    });
    const body = await res.json();
    if (!res.ok) return setError(body.error ?? `${res.status}`);
    setJob(body.job);
  };
  const decide = async (record: TriageRecord, action: "apply" | "reject" | "verify") => {
    setError(null);
    const res = await fetch(`${base}/triage/${record.id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json();
    if (!res.ok) setError(body.error ?? `${res.status}`);
    await load();
  };
  const cancel = async () => {
    await fetch(`${base}/triage/job/cancel`, { method: "POST" });
    await load();
  };
  return { failures, job, busy, error, start, decide, cancel, reload: load };
}

export type TriageState = ReturnType<typeof useTriage>;

/** Header controls: triage every failure at once, and the running job's log + live view. */
export function TriageHeader({ projectId, triage }: { projectId: string; triage: TriageState }) {
  const [allowDestructive, setAllowDestructive] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const untriaged = [...triage.failures.values()].filter((f) => !f.record);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [triage.job?.log.length]);
  if (triage.failures.size === 0) return null;
  const running = triage.job?.state === "running";

  return (
    <div className="triage-header">
      <div className="triage-header-row">
        {running ? (
          <>
            <strong>🩺 Triaging…</strong>
            <button className="link-button users-danger" onClick={triage.cancel}>
              Cancel
            </button>
          </>
        ) : triage.job?.meta?.verifying ? (
          <strong>🩺 Verifying proposed fixes (re-running the tests)…</strong>
        ) : (
          <>
            <button className="primary-button" disabled={triage.busy || untriaged.length === 0} onClick={() => triage.start(untriaged.map((f) => f.testIndex), allowDestructive)}>
              🩺 Triage {untriaged.length === triage.failures.size ? "all failures" : "the rest"} ({untriaged.length})
            </button>
            <label className="users-check">
              <input type="checkbox" checked={allowDestructive} onChange={(e) => setAllowDestructive(e.target.checked)} />
              also auto-verify 🧨 destructive cases (real side effects)
            </label>
          </>
        )}
        {triage.job?.costUsd !== undefined && <span className="muted">${triage.job.costUsd.toFixed(2)}</span>}
      </div>
      {triage.error && <div className="users-error">{triage.error}</div>}
      {running && triage.job?.meta?.liveView && (
        <img className="design-live" src={`/api/explorations/${encodeURIComponent(projectId)}/live.mjpeg`} alt="Live view of the triage agent's browser" />
      )}
      {triage.job && (running || triage.job.meta?.verifying) && <pre ref={logRef} className="triage-log">{triage.job.log.slice(-60).join("\n")}</pre>}
      {triage.job && !running && !triage.job.meta?.verifying && triage.job.stopReason === "usage_limit" && triage.job.summary && (
        <div className="usage-limit-notice">{triage.job.summary}</div>
      )}
    </div>
  );
}

/** Per failed test: the free hint, Triage / Rerun buttons, and its verdict card. */
export function TriageForTest({ projectId, testIndex, triage }: { projectId: string; testIndex: number; triage: TriageState }) {
  const failure = triage.failures.get(testIndex);
  const [rerunMsg, setRerunMsg] = useState<string | null>(null);
  if (!failure) return null;
  const { hint, record } = failure;

  return (
    <div className="triage-test">
      <div className="triage-test-row">
        <span className={`triage-hint triage-hint-${hint.category}`} title="Free rule-based hint from the error text — no AI">
          {HINT_ICON[hint.category]} {hint.reason}
        </span>
        <HelpTip topic="hint" />
        {!record && (
          <button className="link-button" disabled={triage.busy} onClick={() => triage.start([testIndex], false)}>
            🩺 Triage
          </button>
        )}
        {hint.rerunFirst && failure.caseId && (
          <button
            className="link-button"
            onClick={async () => setRerunMsg((await startRun(projectId, { scope: "case", caseId: failure.caseId! })) ?? "Rerun started — see the Runs list.")}
          >
            ▶ Rerun (free)
          </button>
        )}
        {rerunMsg && <span className="muted">{rerunMsg}</span>}
      </div>
      {record && <VerdictCard record={record} triage={triage} />}
    </div>
  );
}

function VerdictCard({ record, triage }: { record: TriageRecord; triage: TriageState }) {
  const v = record.verification;
  return (
    <div className={`triage-verdict triage-${record.classification}`}>
      <div className="triage-verdict-head">
        <strong>{CLASS_LABEL[record.classification]}</strong>
        {record.subtype && <span className="muted">{record.subtype}</span>}
        <span className={`triage-status triage-status-${record.status}`}>{record.status}</span>
        <HelpTip topic="triage" />
      </div>
      <p>{record.explanation}</p>
      {record.evidence.length > 0 && (
        <ul className="triage-evidence">
          {record.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {record.proposal && (
        <>
          <p className="muted test-flow-section-label">Proposed fix — {record.proposal.target === "map" ? "the map (a recorded fact)" : "the test case"}</p>
          <JsonDiff before={record.before} after={record.after} />
          <div className="triage-verification">
            {!v ? (
              <span className="muted">Not verified yet</span>
            ) : v.result === "passed" ? (
              <span className="run-status-passed">✓ Passed with the fix (verification run, then reverted)</span>
            ) : v.result === "failed" ? (
              <span className="run-status-failed">✗ Still failing with the fix: {v.reason}</span>
            ) : (
              <span className="muted">Verification skipped: {v.reason}</span>
            )}
          </div>
          {record.status === "proposed" && (
            <div className="triage-actions">
              <button className="primary-button" disabled={triage.busy} onClick={() => triage.decide(record, "apply")}>
                Approve fix
              </button>
              <button className="link-button" disabled={triage.busy} onClick={() => triage.decide(record, "verify")}>
                Verify again
              </button>
              <button className="link-button users-danger" disabled={triage.busy} onClick={() => triage.decide(record, "reject")}>
                Reject
              </button>
            </div>
          )}
        </>
      )}
      {record.classification === "app_bug" && (
        <details>
          <summary className="link-button">Bug report text</summary>
          <pre className="run-test-error">{`${record.title}\n\n${record.explanation}\n\nEvidence:\n${record.evidence.map((e) => `- ${e}`).join("\n")}`}</pre>
        </details>
      )}
    </div>
  );
}

/** Before/after of the changed map fact or case, as unified-diff lines. */
function JsonDiff({ before, after }: { before: unknown; after: unknown }) {
  const patch = structuredPatch("before", "after", JSON.stringify(before, null, 2) ?? "", JSON.stringify(after, null, 2) ?? "", "", "", { context: 2 });
  return (
    <div className="diff-view triage-diff">
      {patch.hunks.map((h, i) => (
        <pre key={i} className="diff-hunk">
          {h.lines.map((l, j) => (
            <div key={j} className={l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : "diff-ctx"}>
              {l}
            </div>
          ))}
        </pre>
      ))}
    </div>
  );
}
