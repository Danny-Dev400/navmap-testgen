import { useCallback, useEffect, useState } from "react";
import type { ProjectSummary } from "../../src/navmap-types";
import { ExplorationPanel, type ExploreJob } from "./ExplorationPanel";
import { timeAgo } from "./runsClient";
import { Badge, Button, EmptyState, PageHeader } from "./ui/kit";
import { Icon } from "./ui/icons";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; projects: ProjectSummary[] };

export function Dashboard() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [jobs, setJobs] = useState<ExploreJob[]>([]);
  const [showForm, setShowForm] = useState(false);

  const loadProjects = useCallback(() => {
    fetch("/api/projects")
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<ProjectSummary[]>;
      })
      .then((projects) => setState({ status: "ready", projects }))
      .catch((err) => setState({ status: "error", message: String(err) }));
  }, []);

  const loadJobs = useCallback(() => {
    fetch("/api/explorations")
      .then((res) => res.json())
      .then((body) => setJobs(body.jobs ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadProjects();
    loadJobs();
  }, [loadProjects, loadJobs]);

  const projectIds = new Set(state.status === "ready" ? state.projects.map((p) => p.id) : []);
  // Explorations of sites that aren't projects yet (new ones), or that just ended without producing a map.
  const pending = jobs.filter((j) => !projectIds.has(j.projectId) || j.state === "running");

  return (
    <div className="dashboard-layout">
      <PageHeader
        title="Projects"
        meta={<span>One project per site — explored into a map, then tested.</span>}
        actions={
          <Button variant={showForm ? "secondary" : "primary"} icon={showForm ? Icon.close : Icon.add} onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Close" : "New project"}
          </Button>
        }
      />
      <div className="dashboard-body">

      {showForm && (
        <NewProjectForm
          onStarted={() => {
            setShowForm(false);
            loadJobs();
          }}
        />
      )}

      {pending.map((job) => (
        <section key={job.projectId} className="pending-project">
          <ExplorationPanel
            projectId={job.projectId}
            onFinished={() => {
              loadProjects();
              loadJobs();
            }}
          />
        </section>
      ))}

      {state.status === "loading" && (
        <div className="state-message">
          <p className="muted">Loading projects&hellip;</p>
        </div>
      )}

      {state.status === "error" && (
        <div className="state-message">
          <p className="muted">Could not load projects: {state.message}</p>
        </div>
      )}

      {state.status === "ready" && state.projects.length === 0 && pending.length === 0 && (
        <EmptyState icon={Icon.map} title="No projects yet" actions={<Button variant="primary" icon={Icon.add} onClick={() => setShowForm(true)}>New project</Button>}>
          An agent explores a site in a browser you can watch live and builds its navigation map — the starting point for its tests.
        </EmptyState>
      )}

      {state.status === "ready" && state.projects.length > 0 && (
        <div className="project-card-grid">
          {state.projects.map((project) => (
            <a key={project.id} className="project-card" href={`#/project/${encodeURIComponent(project.id)}`}>
              <div className="project-card-head">
                <span className="project-card-icon">
                  <Icon.map size={18} aria-hidden />
                </span>
                <div className="project-card-title">{project.targetHost.replace(/^www\./, "")}</div>
                <Icon.chevronRight size={16} className="project-card-chevron" aria-hidden />
              </div>
              <div className="project-card-meta">
                {project.pageCount} pages · {project.edgeCount} actions · updated {timeAgo(project.updatedAt)}
              </div>
              {project.health && <ProjectHealth health={project.health} />}
            </a>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

/** Card health line: runnable coverage, the newest dashboard test run, and cumulative agent quota. */
function ProjectHealth({ health }: { health: NonNullable<ProjectSummary["health"]> }) {
  const run = health.lastRun;
  const total = run ? run.passed + run.failed + run.flaky : 0;
  return (
    <div className="project-card-health">
      <Badge tone={health.total === 0 ? "neutral" : health.runnable === health.total ? "success" : "warning"} title="Approved test cases generated as runnable tests">
        {health.total === 0 ? "no approved cases" : `${health.runnable}/${health.total} runnable`}
      </Badge>
      {health.drafts > 0 && <Badge tone="accent">{health.drafts} draft{health.drafts === 1 ? "" : "s"}</Badge>}
      {run ? (
        <Badge tone={run.failed > 0 ? "danger" : "success"} title={`Last run finished ${new Date(run.finishedAt).toLocaleString()}`}>
          last run {run.passed}/{total}
          {run.failed > 0 ? ` · ${run.failed} failed` : ""} · {timeAgo(run.finishedAt)}
        </Badge>
      ) : (
        <Badge tone="neutral">never run</Badge>
      )}
      {health.quotaUsd > 0 && (
        <Badge tone="ai" title="Estimated agent cost so far — plan quota, not money, on a subscription">
          ~${health.quotaUsd.toFixed(2)} quota
        </Badge>
      )}
    </div>
  );
}

function NewProjectForm({ onStarted }: { onStarted: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [focus, setFocus] = useState("");
  const [maxNewPages, setMaxNewPages] = useState(25);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [error, setError] = useState<{ message: string; projectId?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="users-card users-add new-project-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const res = await fetch("/api/explorations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              baseUrl,
              maxNewPages,
              ...(focus.trim() ? { focus } : {}),
              ...(requiresLogin ? { auth: { username, password, ...(loginUrl ? { loginUrl } : {}) } } : {}),
            }),
          });
          const body = await res.json();
          if (!res.ok) return setError({ message: body.details ?? body.error ?? `${res.status}`, projectId: body.projectId });
          onStarted();
        } catch (err) {
          setError({ message: String(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      <strong>New project</strong>
      <p className="muted">
        A Claude agent explores the site in a headless browser you can watch live, and builds its navigation map. It runs on your Claude plan:
        a full run uses a lot of quota, so smaller runs with a focus are a good way to start.
      </p>
      <input className="users-input" type="url" placeholder="Base URL (e.g. https://www.saucedemo.com/)" value={baseUrl} required onChange={(e) => setBaseUrl(e.target.value)} />
      <input className="users-input" placeholder="Focus (optional, e.g. checkout flow)" value={focus} onChange={(e) => setFocus(e.target.value)} />
      <label className="users-check">
        Max new pages
        <input
          className="users-input new-project-number"
          type="number"
          min={1}
          max={50}
          value={maxNewPages}
          onChange={(e) => setMaxNewPages(Number(e.target.value))}
        />
      </label>
      <label className="users-check">
        <input type="checkbox" checked={requiresLogin} onChange={(e) => setRequiresLogin(e.target.checked)} />
        The site requires login
      </label>
      {requiresLogin && (
        <>
          <input className="users-input" placeholder="Username" value={username} required autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
          <input
            className="users-input"
            type="password"
            placeholder="Password"
            value={password}
            required
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <input className="users-input" type="url" placeholder="Login URL (optional)" value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} />
          <p className="muted">Saved to the project's gitignored credentials/ folder as its default user; the agent only gets a temporary copy.</p>
        </>
      )}
      {error && (
        <div className="users-error">
          {error.message}
          {error.projectId && (
            <>
              {" "}
              <a href={`#/project/${encodeURIComponent(error.projectId)}`}>Open project</a>
            </>
          )}
        </div>
      )}
      <button className="primary-button" type="submit" disabled={busy}>
        {busy ? "Starting…" : "Start exploring"}
      </button>
    </form>
  );
}
