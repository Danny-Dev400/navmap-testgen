import { useCallback, useEffect, useRef, useState } from "react";
import { HelpTip } from "./help";
import { navigate } from "./nav";

interface OrganizeJob {
  state: "running" | "succeeded" | "failed" | "cancelled";
  stopReason?: "usage_limit";
  meta: { request?: string | null; proposal?: boolean };
  model?: string;
  costUsd?: number;
  summary?: string;
  log: string[];
}

/** The organizer agent: proposes features → use cases and places every case. Text only (no
 *  browser); the result is a proposal the user reviews in the Test cases tab. */
export function OrganizeSection({ projectId, onFinished }: { projectId: string; onFinished: () => void }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/features`;
  const [job, setJob] = useState<OrganizeJob | null>(null);
  const [hasOrganization, setHasOrganization] = useState(false);
  const [proposalAt, setProposalAt] = useState<string | null>(null);
  const [request, setRequest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    const body = await fetch(base)
      .then((r) => r.json())
      .catch(() => ({}));
    setJob(body.job ?? null);
    setHasOrganization(!!body.organization);
    setProposalAt(body.proposal?.createdAt ?? null);
    return body.job as OrganizeJob | null;
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  const state = job?.state;
  useEffect(() => {
    if (state !== "running") {
      if (wasRunning.current && state) {
        wasRunning.current = false;
        onFinished();
        void load();
      }
      return;
    }
    wasRunning.current = true;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [state, load, onFinished]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log.length]);

  const start = async () => {
    setError(null);
    const res = await fetch(`${base}/organize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.trim() ? { request: request.trim() } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.error ?? `${res.status}`);
    setJob(body.job);
  };
  const cancel = async () => {
    await fetch(`${base}/job/cancel`, { method: "POST" });
    await load();
  };
  const running = job?.state === "running";

  return (
    <div className="assistant-section">
      <p className="muted">
        Organize test cases by what the app does: features → use cases, with every case placed under the goal it proves.{" "}
        {hasOrganization ? "Your current organization is kept — it only adds what's new (new cases, new actions)." : ""} Text only, no browser — cheap on quota.
        You review the proposal before anything changes. <HelpTip topic="organizer" />
      </p>
      {proposalAt && !running && (
        <div className="assistant-proposal">
          A proposal from {new Date(proposalAt).toLocaleString()} is waiting for you.{" "}
          <button className="primary-button" onClick={() => navigate(projectId, "cases", { proposal: "1" })}>
            Review it
          </button>
        </div>
      )}
      {!running && (
        <div className="design-form">
          <textarea
            className="users-input design-request"
            rows={3}
            maxLength={1000}
            placeholder={
              hasOrganization
                ? "Optional — e.g. “split Checkout into payment and shipping”. Leave empty to only place new cases and actions."
                : "Optional — e.g. “keep login and logout in one feature”. Leave empty to let the agent propose."
            }
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
          {error && <div className="users-error">{error}</div>}
          <button className="primary-button" onClick={start}>
            🗂 {hasOrganization ? "Update organization" : "Propose an organization"}
          </button>
        </div>
      )}
      {job && (
        <div className="links-log">
          <div className="muted">
            {running ? "Organizing…" : job.stopReason === "usage_limit" ? "Last run: stopped — plan usage limit nearly reached" : `Last run: ${job.state}`}
            {job.model ? ` · ${job.model}` : ""}
            {job.meta?.request ? ` · “${job.meta.request}”` : ""}
            {job.costUsd !== undefined ? ` · $${job.costUsd.toFixed(2)}` : ""}
            {running && (
              <>
                {" "}
                ·{" "}
                <button className="link-button users-danger" onClick={cancel}>
                  Cancel
                </button>
              </>
            )}
          </div>
          {!running && job.summary && <div className={`explore-summary${job.stopReason === "usage_limit" ? " usage-limit-notice" : ""}`}>{job.summary}</div>}
          <pre ref={logRef}>{job.log.join("\n")}</pre>
        </div>
      )}
    </div>
  );
}
