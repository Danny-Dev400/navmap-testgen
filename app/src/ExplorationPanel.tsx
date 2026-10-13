import { useCallback, useEffect, useRef, useState } from "react";

export interface ExploreJob {
  projectId: string;
  label: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  model?: string;
  costUsd?: number;
  summary?: string;
  log: string[];
  meta: { baseUrl?: string; focus?: string | null; maxNewPages?: number; authenticated?: boolean; liveView?: boolean };
  stopReason?: "usage_limit";
  usageResetsAt?: string;
}

function elapsed(job: ExploreJob, now: number): string {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const s = Math.max(0, Math.round((end - Date.parse(job.startedAt)) / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Live view of one exploration: the headless browser streamed as MJPEG beside the agent's log.
 *  Polls the job while it runs and calls onFinished once when it ends. */
export function ExplorationPanel({ projectId, onFinished }: { projectId: string; onFinished?: (job: ExploreJob) => void }) {
  const [job, setJob] = useState<ExploreJob | null>(null);
  const [now, setNow] = useState(Date.now());
  const wasRunning = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  const poll = useCallback(async () => {
    const res = await fetch(`/api/explorations/${encodeURIComponent(projectId)}`);
    const body = await res.json();
    setJob(body.job);
    setNow(Date.now());
  }, [projectId]);

  useEffect(() => {
    poll().catch(() => undefined);
  }, [poll]);

  const state = job?.state;
  useEffect(() => {
    if (state !== "running") {
      if (wasRunning.current && job) {
        wasRunning.current = false;
        onFinished?.(job);
      }
      return;
    }
    wasRunning.current = true;
    const timer = setInterval(() => poll().catch(() => undefined), 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, poll]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [job?.log.length]);

  if (!job) return null;
  const running = job.state === "running";

  return (
    <div className="explore-panel">
      <div className="explore-panel-status">
        <strong>{running ? "Exploring…" : job.stopReason === "usage_limit" ? "Stopped — plan usage limit" : `Exploration ${job.state}`}</strong>
        <span className="muted">
          {job.meta.baseUrl} · {elapsed(job, now)}
          {job.model ? ` · ${job.model}` : ""}
          {job.costUsd !== undefined ? ` · est. $${job.costUsd.toFixed(2)} of plan quota` : ""}
        </span>
        {running && (
          <button
            className="link-button users-danger"
            onClick={async () => {
              await fetch(`/api/explorations/${encodeURIComponent(projectId)}/cancel`, { method: "POST" });
              poll().catch(() => undefined);
            }}
          >
            Cancel
          </button>
        )}
      </div>
      <div className="explore-panel-body">
        <div className="explore-live">
          {/* Cache-busted per run so a new run doesn't reuse the previous stream's connection. */}
          <img src={`/api/explorations/${encodeURIComponent(projectId)}/live.mjpeg?run=${encodeURIComponent(job.startedAt)}`} alt="Live view of the browser the agent is driving" />
          {running && <span className="explore-live-badge">● LIVE</span>}
        </div>
        <pre ref={logRef} className="explore-log">
          {job.log.join("\n")}
        </pre>
      </div>
      {!running && job.summary && (
        <div className={`explore-summary${job.stopReason === "usage_limit" ? " usage-limit-notice" : ""}`}>{job.summary}</div>
      )}
    </div>
  );
}
