import { useCallback, useEffect, useRef, useState } from "react";
import type { PageView } from "./casesClient";

interface DesignJob {
  state: "running" | "succeeded" | "failed" | "cancelled";
  stopReason?: "usage_limit";
  meta: { pageId?: string | null; useCaseId?: string | null; request?: string | null; liveView?: boolean };
  startedAt: string;
  finishedAt?: string;
  model?: string;
  costUsd?: number;
  summary?: string;
  log: string[];
}

/** Launches the test-design agent (headless `claude -p` on the dev server) for the whole project or
 *  one page, with an optional request, and streams its log and live browser. Picks up a run already
 *  in progress after a reload; calls onFinished once when it ends (new drafts to show). */
export function DesignPanel({
  projectId,
  pages,
  useCases = [],
  requirements = [],
  onFinished,
  prefill,
  embedded,
}: {
  projectId: string;
  pages: PageView[];
  /** Use cases to scope the design to (drafts get filed under the chosen one). */
  useCases?: { id: string; label: string }[];
  /** Requirements to design for (their uncovered criteria; drafts get linked to them). */
  requirements?: { id: string; label: string; uncovered: number }[];
  onFinished: () => void;
  /** Opens the form with a scope and request already filled in (e.g. "design this journey"); `key` re-applies it. */
  prefill?: { key: number; pageId?: string; useCaseId?: string; requirementId?: string; request: string };
  /** Inside the Assistant: the form is always open (no Close toggle). */
  embedded?: boolean;
}) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/design`;
  const [open, setOpen] = useState(!!embedded);
  const [job, setJob] = useState<DesignJob | null>(null);
  // "" (whole project) | "page:<pageId>" | "uc:<useCaseId>" | "req:<requirementId>"
  const [scope, setScope] = useState("");
  const [request, setRequest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prefill) return;
    setScope(prefill.requirementId ? `req:${prefill.requirementId}` : prefill.useCaseId ? `uc:${prefill.useCaseId}` : prefill.pageId ? `page:${prefill.pageId}` : "");
    setRequest(prefill.request);
    setOpen(true);
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [prefill]);

  const poll = useCallback(async () => {
    const res = await fetch(`${base}/job`);
    const body = await res.json();
    setJob(body.job);
    return body.job as DesignJob | null;
  }, [base]);

  useEffect(() => {
    poll()
      .then((j) => {
        if (j) setOpen(true);
      })
      .catch(() => undefined);
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

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log.length]);

  const start = async () => {
    setError(null);
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(scope.startsWith("page:") ? { pageId: scope.slice(5) } : {}),
        ...(scope.startsWith("uc:") ? { useCaseId: scope.slice(3) } : {}),
        ...(scope.startsWith("req:") ? { requirementId: scope.slice(4) } : {}),
        ...(request.trim() ? { request: request.trim() } : {}),
      }),
    });
    const body = await res.json();
    if (!res.ok) return setError(body.error ?? `${res.status}`);
    setJob(body.job);
  };

  const cancel = async () => {
    const res = await fetch(`${base}/job/cancel`, { method: "POST" });
    const body = await res.json();
    if (body.job) setJob(body.job);
  };

  const running = job?.state === "running";

  return (
    <div className="links-panel design-panel" ref={panelRef}>
      <div className="links-panel-header">
        <div>
          {!embedded && <strong>Design cases</strong>}
          <div className="muted">
            An agent reads the map and page snapshots and proposes draft cases — journeys, negative cases, value checks. It opens the browser only to verify
            something. You review and approve; nothing is approved or run for you.
          </div>
        </div>
        {running ? (
          <button className="link-button users-danger" onClick={cancel}>
            Cancel
          </button>
        ) : embedded ? null : (
          <button className="link-button" onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : "Design cases…"}
          </button>
        )}
      </div>

      {open && !running && (
        <div className="design-form">
          <label className="users-check">
            Scope
            <select className="users-input" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Whole project</option>
              {requirements.length > 0 && (
                <optgroup label="Requirement (its uncovered criteria)">
                  {requirements.map((r) => (
                    <option key={r.id} value={`req:${r.id}`}>
                      {r.label} — {r.uncovered} uncovered
                    </option>
                  ))}
                </optgroup>
              )}
              {useCases.length > 0 && (
                <optgroup label="Use case">
                  {useCases.map((u) => (
                    <option key={u.id} value={`uc:${u.id}`}>
                      {u.label}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Page">
                {pages.map((p) => (
                  <option key={p.id} value={`page:${p.id}`}>
                    {p.title}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <textarea
            className="users-input design-request"
            rows={3}
            maxLength={1000}
            placeholder="Optional — what to test, e.g. “add 3 products and check that each price in checkout matches the catalog and Item total is their sum”. Leave empty to let the agent propose valuable cases."
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
          {error && <div className="users-error">{error}</div>}
          <button className="primary-button" onClick={start}>
            Design cases
          </button>
        </div>
      )}

      {job && (
        <div className="links-log">
          <div className="muted">
            {running ? "Designing…" : job.stopReason === "usage_limit" ? "Last run: stopped — plan usage limit nearly reached" : `Last run: ${job.state}`}
            {job.model ? ` · ${job.model}` : ""}
            {job.meta?.request ? ` · “${job.meta.request}”` : ""}
            {job.costUsd !== undefined ? ` · $${job.costUsd.toFixed(2)}` : ""}
          </div>
          {running && job.meta?.liveView && (
            <img className="design-live" src={`/api/explorations/${encodeURIComponent(projectId)}/live.mjpeg`} alt="Live view of the agent's browser" />
          )}
          {!running && job.summary && <div className={`explore-summary${job.stopReason === "usage_limit" ? " usage-limit-notice" : ""}`}>{job.summary}</div>}
          <pre ref={logRef}>{job.log.join("\n")}</pre>
        </div>
      )}
    </div>
  );
}
