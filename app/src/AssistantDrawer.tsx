import { useEffect, useRef, useState } from "react";
import { ExplorationPanel } from "./ExplorationPanel";
import { DesignPanel } from "./DesignPanel";
import { LinkPreconditionsPanel } from "./LinksPanel";
import { HelpTip } from "./help";
import { IconButton } from "./ui/kit";
import { Icon, type LucideIcon } from "./ui/icons";

const SECTION_ICON: Record<AssistantSection, LucideIcon> = {
  explore: Icon.explore,
  design: Icon.design,
  link: Icon.link,
  triage: Icon.triage,
  organize: Icon.organize,
};
import { navigate } from "./nav";
import { SECTION_LABEL, type AgentsStatus, type AssistantPrefill, type AssistantSection } from "./assistant";
import type { CasesData, PageView } from "./casesClient";
import { OrganizeSection } from "./OrganizeSection";

/** All the AI agents in one side drawer — explore the site, design cases, link preconditions,
 *  diagnose failures — instead of panels stacked inside the tabs. Each uses plan quota; none of
 *  them approves or applies anything. */
export function AssistantDrawer({
  projectId,
  section,
  prefill,
  status,
  onSection,
  onClose,
  onFinished,
}: {
  projectId: string;
  section: AssistantSection;
  prefill?: AssistantPrefill & { key: number };
  status: AgentsStatus | null;
  onSection: (s: AssistantSection) => void;
  onClose: () => void;
  /** An agent ended — the shell reloads the map / cases. */
  onFinished: () => void;
}) {
  const [pages, setPages] = useState<PageView[]>([]);
  const [useCases, setUseCases] = useState<{ id: string; label: string }[]>([]);
  const [requirements, setRequirements] = useState<{ id: string; label: string; uncovered: number }[]>([]);
  useEffect(() => {
    fetch(`/api/projects/${encodeURIComponent(projectId)}/cases`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: CasesData | null) => {
        setPages(b?.pages ?? []);
        setUseCases((b?.organization?.features ?? []).flatMap((f) => f.useCases.map((u) => ({ id: u.id, label: `${f.title} › ${u.title}` }))));
        setRequirements(b?.requirementList ?? []);
      })
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const running = status?.running ?? null;

  return (
    <aside className="assistant-drawer" aria-label="Assistant">
      <div className="assistant-head">
        <div className="assistant-title">
          <Icon.assistant size={20} aria-hidden className="assistant-title-icon" />
          <span>Assistant</span>
          <HelpTip topic="assistant" />
        </div>
        <IconButton icon={Icon.close} label="Close the assistant" onClick={onClose} />
      </div>
      <p className="assistant-intro">AI agents that work on your plan's quota. None of them approves or applies anything for you.</p>
      {running && (
        <div className="assistant-running">
          <span className="sidebar-live" aria-hidden /> {SECTION_LABEL[running]} is running
          {running !== section && (
            <button className="link-button" onClick={() => onSection(running)}>
              Show
            </button>
          )}
        </div>
      )}
      <nav className="assistant-nav" role="tablist">
        {(Object.keys(SECTION_LABEL) as AssistantSection[]).map((s) => {
          const C = SECTION_ICON[s];
          return (
            <button key={s} role="tab" aria-selected={s === section} className={s === section ? "active" : ""} onClick={() => onSection(s)}>
              <C size={16} aria-hidden />
              <span>{SECTION_LABEL[s]}</span>
              {running === s && <span className="sidebar-live" aria-label="running" />}
            </button>
          );
        })}
      </nav>
      <div className="assistant-body">
        {section === "explore" && <ExploreSection projectId={projectId} onFinished={onFinished} prefill={prefill} />}
        {section === "design" && (
          <DesignPanel
            projectId={projectId}
            pages={pages}
            useCases={useCases}
            requirements={requirements}
            embedded
            onFinished={onFinished}
            prefill={
              prefill && (prefill.pageId !== undefined || prefill.useCaseId !== undefined || prefill.requirementId !== undefined)
                ? { key: prefill.key, pageId: prefill.pageId, useCaseId: prefill.useCaseId, requirementId: prefill.requirementId, request: prefill.request ?? "" }
                : undefined
            }
          />
        )}
        {section === "organize" && <OrganizeSection projectId={projectId} onFinished={onFinished} />}
        {section === "link" && <LinkPreconditionsPanel projectId={projectId} fixmeCount={null} onFinished={onFinished} />}
        {section === "triage" && <TriageSection projectId={projectId} />}
      </div>
    </aside>
  );
}

interface UserOption {
  id: string;
  label: string;
  kind: "guest" | "auth";
  hasCredentials: boolean;
}

/** Grow the map with another explorer run, or refresh page snapshots for free. */
function ExploreSection({ projectId, onFinished, prefill }: { projectId: string; onFinished: () => void; prefill?: AssistantPrefill & { key: number } }) {
  const [showPanel, setShowPanel] = useState(false);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [focus, setFocus] = useState("");
  const [maxNewPages, setMaxNewPages] = useState(25);
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotResult, setSnapshotResult] = useState<string | null>(null);
  // "Explore to find it" from a question: the focus arrives prefilled.
  useEffect(() => {
    if (prefill?.request) setFocus(prefill.request.slice(0, 300));
  }, [prefill]);

  useEffect(() => {
    fetch(`/api/explorations/${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((b) => {
        if (b.job) setShowPanel(true);
      })
      .catch(() => undefined);
    fetch(`/api/projects/${encodeURIComponent(projectId)}/settings`)
      .then((r) => r.json())
      .then((b) => {
        const configured = b.settings?.agents?.explorer?.defaultMaxNewPages;
        if (typeof configured === "number") setMaxNewPages(configured);
      })
      .catch(() => undefined);
    fetch(`/api/projects/${encodeURIComponent(projectId)}/users`)
      .then((r) => r.json())
      .then((b) => {
        const usable: UserOption[] = (b.users ?? []).filter((u: UserOption) => u.kind === "guest" || u.hasCredentials);
        setUsers(usable);
        // Default to an authenticated user when there is one: most of an app usually sits behind login.
        setUserId((usable.find((u) => u.kind === "auth") ?? usable[0])?.id ?? "");
      })
      .catch(() => undefined);
  }, [projectId]);

  const start = async () => {
    setError(null);
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/explore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxNewPages, ...(focus.trim() ? { focus } : {}), ...(userId ? { userId } : {}) }),
    });
    const body = await res.json();
    if (!res.ok) return setError(body.details ?? body.error ?? `${res.status}`);
    setShowPanel(true);
  };

  const refreshSnapshots = async () => {
    setSnapshotBusy(true);
    setSnapshotResult(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/snapshots/refresh`, { method: "POST" });
      const body = await res.json();
      const summary = body.summary as { captured: number; total: number; results: { title: string; captured: boolean; reason?: string }[] } | null;
      if (!summary) return setSnapshotResult(body.error ?? "Snapshot refresh failed — see the dev server log.");
      const skipped = summary.results.filter((r) => !r.captured);
      setSnapshotResult(`Captured ${summary.captured} of ${summary.total} page snapshots.` + (skipped.length ? ` Skipped: ${skipped.map((r) => `${r.title} (${r.reason})`).join("; ")}` : ""));
    } catch (err) {
      setSnapshotResult(String(err));
    } finally {
      setSnapshotBusy(false);
    }
  };

  return (
    <div className="assistant-section">
      <p className="muted">
        Grow the map with another explorer run. A focus (e.g. "checkout flow") keeps it short and cheap on quota. <HelpTip topic="map" />
      </p>
      <div className="explore-more-form">
        <input className="users-input" placeholder="Focus (e.g. checkout flow, admin settings)" value={focus} onChange={(e) => setFocus(e.target.value)} />
        <label className="users-check">
          Max new pages
          <input className="users-input new-project-number" type="number" min={1} max={50} value={maxNewPages} onChange={(e) => setMaxNewPages(Number(e.target.value))} />
        </label>
        <label className="users-check">
          Explore as
          <select className="users-input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label} ({u.kind === "guest" ? "not logged in" : "logs in"})
              </option>
            ))}
          </select>
        </label>
        {error && <div className="users-error">{error}</div>}
        <button className="primary-button" onClick={start}>
          🔭 Start exploring
        </button>
      </div>
      <div className="assistant-snapshots">
        <button className="link-button" disabled={snapshotBusy} onClick={refreshSnapshots} title="Visits each page by its URL and saves what the page shows — no agent, no quota">
          📸 {snapshotBusy ? "Capturing page snapshots…" : "Refresh page snapshots (free, no agent)"}
        </button>{" "}
        <HelpTip topic="snapshots" />
        {snapshotResult && <div className="muted explore-snapshots-result">{snapshotResult}</div>}
      </div>
      {showPanel && (
        <ExplorationPanel
          projectId={projectId}
          onFinished={(job) => {
            if (job.state === "succeeded") onFinished();
          }}
        />
      )}
    </div>
  );
}

interface TriageJobView {
  state: string;
  meta: { runId?: string; testIndexes?: number[]; verifying?: boolean; liveView?: boolean };
  costUsd?: number;
  summary?: string;
  log: string[];
}

/** Diagnoses start from a failed test (Home inbox or the run detail); here you follow the agent. */
function TriageSection({ projectId }: { projectId: string }) {
  const [job, setJob] = useState<TriageJobView | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const poll = async () => {
      const body = await fetch(`/api/projects/${encodeURIComponent(projectId)}/triage/job`).then((r) => r.json()).catch(() => ({}));
      if (cancelled) return;
      setJob(body.job ?? null);
      if (body.job?.state === "running" || body.job?.meta?.verifying) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log.length]);

  if (!job) {
    return (
      <div className="assistant-section">
        <p className="muted">
          No diagnosis yet. Start one from a failed test — in the Home inbox (🩺 Diagnose) or in a run's detail. <HelpTip topic="triage" />
        </p>
      </div>
    );
  }
  const running = job.state === "running";
  return (
    <div className="assistant-section">
      <p>
        <strong>{running ? "Diagnosing…" : job.meta.verifying ? "Verifying proposed fixes (re-running the tests)…" : `Last diagnosis: ${job.state}`}</strong>
        {job.costUsd !== undefined ? <span className="muted"> · ${job.costUsd.toFixed(2)}</span> : null}
        {job.meta.runId && (
          <>
            {" "}
            ·{" "}
            <button className="link-button" onClick={() => navigate(projectId, "runs", { run: job.meta.runId })}>
              open the run
            </button>
          </>
        )}
      </p>
      {running && job.meta.liveView && <img className="design-live" src={`/api/explorations/${encodeURIComponent(projectId)}/live.mjpeg`} alt="Live view of the agent's browser" />}
      {!running && job.summary && <div className="explore-summary">{job.summary}</div>}
      <pre ref={logRef} className="triage-log">
        {job.log.slice(-80).join("\n")}
      </pre>
    </div>
  );
}
