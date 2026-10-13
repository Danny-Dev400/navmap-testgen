import { useCallback, useEffect, useRef, useState } from "react";

interface LinkJob {
  state: "running" | "succeeded" | "failed" | "cancelled";
  stopReason?: "usage_limit";
  meta: { verify?: boolean };
  startedAt: string;
  finishedAt?: string;
  model?: string;
  costUsd?: number;
  summary?: string;
  log: string[];
}

/** Launches the linker agent (headless `claude -p` on the dev server) and streams its progress; the
 *  server regenerates code when it ends, whatever the outcome (a run can save links before
 *  stopping). Picks up a run already in progress after a page reload. */
export function LinkPreconditionsPanel({ projectId, fixmeCount, onFinished }: { projectId: string; fixmeCount: number | null; onFinished: () => void }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/links`;
  const [job, setJob] = useState<LinkJob | null>(null);
  const [verify, setVerify] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const poll = useCallback(async () => {
    const res = await fetch(`${base}/job`);
    const body = await res.json();
    setJob(body.job);
    return body.job as LinkJob | null;
  }, [base]);

  useEffect(() => {
    poll().catch(() => undefined);
  }, [poll]);

  const jobState = job?.state;
  useEffect(() => {
    if (jobState !== "running") {
      if (wasRunning.current && jobState) {
        wasRunning.current = false;
        onFinished();
      }
      return;
    }
    wasRunning.current = true;
    const timer = setInterval(() => poll().catch(() => undefined), 1500);
    return () => clearInterval(timer);
  }, [jobState, poll, onFinished]);

  const start = async () => {
    setError(null);
    const res = await fetch(`${base}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verify }) });
    const body = await res.json();
    if (!res.ok && res.status !== 409) return setError(body.error ?? `${res.status}`);
    setJob(body.job);
  };

  const cancel = async () => {
    const res = await fetch(`${base}/job/cancel`, { method: "POST" });
    const body = await res.json();
    if (body.job) setJob(body.job);
  };

  const running = job?.state === "running";

  return (
    <div className="links-panel">
      <div className="links-panel-header">
        <div>

          <div className="muted">
            {fixmeCount !== null ? `${fixmeCount} approved case${fixmeCount === 1 ? "" : "s"} still fixme. ` : ""}The state linker points each precondition to a state (“Cart
            has items”) with a reusable flow — reusing existing states first — and asks you in 🧩 States whatever it can't resolve from the map.
          </div>
        </div>
        {running ? (
          <button className="link-button users-danger" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <div className="links-panel-actions">
            <label className="users-check">
              <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
              Verify by running chained tests (real side effects on the site)
            </label>
            <button className="primary-button" onClick={start}>
              Link preconditions
            </button>
          </div>
        )}
      </div>
      {error && <div className="users-error">{error}</div>}
      {job && (
        <div className="links-log">
          <div className="muted">
            {running ? "Running…" : job.stopReason === "usage_limit" ? "Last run: stopped — plan usage limit nearly reached" : `Last run: ${job.state}`}
            {job.model ? ` · ${job.model}` : ""}
            {job.meta?.verify ? " · with verification" : ""}
            {job.costUsd !== undefined ? ` · $${job.costUsd.toFixed(2)}` : ""}
          </div>
          {!running && job.stopReason === "usage_limit" && job.summary && <div className="usage-limit-notice">{job.summary}</div>}
          <pre>{job.log.join("\n")}</pre>
        </div>
      )}
    </div>
  );
}

