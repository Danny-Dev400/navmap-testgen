import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NavigationMap } from "../../src/navmap-types";
import { NavMapApp } from "./NavMapApp";
import type { MapCase, MapProject } from "./NavMapSidePanel";
import type { CaseView } from "./casesClient";
import { CasesView } from "./CasesView";
import { UsersView } from "./UsersView";
import { SettingsView } from "./SettingsView";
import { RunsView } from "./RunsView";
import { HomeView } from "./HomeView";
import { StatesView } from "./StatesView";
import { RequirementsView } from "./RequirementsView";
import { AssistantDrawer } from "./AssistantDrawer";
import { AssistantContext, SECTION_LABEL, type AgentsStatus, type AssistantApi, type AssistantPrefill, type AssistantSection } from "./assistant";
import { navigate, type Tab } from "./nav";
import { Sidebar, type SidebarCounts } from "./Sidebar";
import { EMPTY_LATEST, fetchLatestStatus, type LatestStatus } from "./runsClient";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; map: NavigationMap };

export function ProjectView({ projectId, tab, params, onBack }: { projectId: string; tab: Tab; params: Record<string, string>; onBack: () => void }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Bumped when an agent finishes: the map refetches in place (no loading flash), Home and Cases reload.
  const [reloadKey, setReloadKey] = useState(0);
  // Last result per case and per edge, for the map's "color by last result" mode — refreshed on every tab switch.
  const [latestStatus, setLatestStatus] = useState<LatestStatus>(EMPTY_LATEST);
  useEffect(() => {
    fetchLatestStatus(projectId).then(setLatestStatus).catch(() => undefined);
  }, [projectId, tab, reloadKey]);
  // What waits for the user, as counts in the sidebar (drafts + needs review, open questions).
  const [counts, setCounts] = useState<SidebarCounts | null>(null);
  useEffect(() => {
    fetch(`/api/projects/${encodeURIComponent(projectId)}/overview`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (o) =>
          o &&
          setCounts({
            cases: (o.cases?.drafts ?? 0) + (o.cases?.needsReview ?? 0),
            states: o.states?.questions ?? 0,
            requirements: (o.requirements?.failing ?? 0) + (o.requirements?.uncovered ?? 0) + (o.requirements?.analyses ?? 0),
          }),
      )
      .catch(() => undefined);
  }, [projectId, tab, reloadKey]);
  // Approved cases per edge, for the map's "color by case coverage" mode, and the cases themselves so
  // the map's side panel can link to them.
  const [edgeCoverage, setEdgeCoverage] = useState<Record<string, number> | undefined>(undefined);
  const [mapCases, setMapCases] = useState<MapCase[]>([]);
  useEffect(() => {
    fetch(`/api/projects/${encodeURIComponent(projectId)}/cases`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { edgeCoverage?: Record<string, number>; cases?: CaseView[] } | null) => {
        setEdgeCoverage(b?.edgeCoverage);
        setMapCases(
          (b?.cases ?? []).map((c) => ({
            id: c.id,
            title: c.title,
            status: c.status,
            health: c.health,
            runnable: c.runnable,
            firstPageId: c.firstPageId,
            edgeIds: c.steps.map((s) => s.edgeId),
          })),
        );
      })
      .catch(() => undefined);
  }, [projectId, tab, reloadKey]);
  const mapProject = useMemo<MapProject>(() => ({ id: projectId, cases: mapCases, latestCases: latestStatus.cases }), [projectId, mapCases, latestStatus]);

  // ---- Assistant (all agents in one drawer) and the light "is an agent running" poll.
  const [assistant, setAssistant] = useState<{ section: AssistantSection; prefill?: AssistantPrefill & { key: number } } | null>(null);
  const [agents, setAgents] = useState<AgentsStatus | null>(null);
  const wasRunning = useRef<AssistantSection | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const status = (await fetch(`/api/projects/${encodeURIComponent(projectId)}/agents`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)) as AgentsStatus | null;
      if (cancelled) return;
      setAgents(status);
      const running = status?.running ?? null;
      if (wasRunning.current && !running) setReloadKey((k) => k + 1); // an agent just finished
      wasRunning.current = running;
      timer = setTimeout(poll, running || status?.testRunRunning ? 3000 : 8000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);
  const assistantApi = useMemo<AssistantApi>(
    () => ({ open: (section, prefill) => setAssistant({ section, prefill: prefill ? { ...prefill, key: Date.now() } : undefined }) }),
    [],
  );
  const onAgentFinished = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (reloadKey === 0) setState({ status: "loading" });
    fetch(`/api/projects/${encodeURIComponent(projectId)}`)
      .then(async (res) => {
        if (res.status === 404) {
          if (!cancelled) setState({ status: "not-found" });
          return;
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const map = (await res.json()) as NavigationMap;
        if (!cancelled) setState({ status: "ready", map });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: "error", message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  if (state.status === "loading") {
    return (
      <div className="state-message">
        <p className="muted">Loading project&hellip;</p>
      </div>
    );
  }

  if (state.status === "not-found") {
    return (
      <div className="state-message">
        <p className="muted">Project "{projectId}" was not found.</p>
        <button className="back-button" onClick={onBack}>
          &larr; All projects
        </button>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="state-message">
        <p className="muted">Could not load project: {state.message}</p>
        <button className="back-button" onClick={onBack}>
          &larr; All projects
        </button>
      </div>
    );
  }

  const running = agents?.running ?? null;
  return (
    <AssistantContext.Provider value={assistantApi}>
      <div className="project-shell">
        <Sidebar
          projectId={projectId}
          host={state.map.targetHost}
          tab={tab}
          counts={counts}
          testRunRunning={!!agents?.testRunRunning}
          assistantOpen={!!assistant}
          agentRunning={running ? SECTION_LABEL[running] : null}
          onAssistant={() => (assistant ? setAssistant(null) : setAssistant({ section: running ?? "design" }))}
          onBack={onBack}
        />
        <div className="project-shell-content">
          {tab === "home" && <HomeView projectId={projectId} host={state.map.targetHost} onBack={onBack} refreshSignal={reloadKey} />}
          {tab === "map" && (
            <div className="project-tab-fill">
              <NavMapApp key={state.map.updatedAt} map={state.map} edgeStatus={latestStatus.edges} edgeCoverage={edgeCoverage} project={mapProject} />
            </div>
          )}
          {tab === "cases" && (
            <CasesView
              projectId={projectId}
              onBack={onBack}
              initialCaseId={params.case}
              initialNewCasePage={params.newCase}
              initialNewCaseStep={params.step}
              initialFilter={params.filter}
              initialGroup={params.group}
              openProposal={params.proposal === "1"}
              refreshSignal={reloadKey}
            />
          )}
          {tab === "runs" && (
            <RunsView projectId={projectId} onBack={onBack} initialRunId={params.run} onOpenTestCase={(caseId) => navigate(projectId, "cases", { case: caseId })} />
          )}
          {tab === "requirements" && <RequirementsView projectId={projectId} initialReqId={params.req} initialFilter={params.filter} refreshSignal={reloadKey} />}
          {tab === "states" && <StatesView projectId={projectId} onBack={onBack} initialStateId={params.state} refreshSignal={reloadKey} />}
          {tab === "users" && <UsersView projectId={projectId} map={state.map} />}
          {tab === "settings" && <SettingsView projectId={projectId} onBack={onBack} />}
        </div>
        {assistant && (
          <AssistantDrawer
            projectId={projectId}
            section={assistant.section}
            prefill={assistant.prefill}
            status={agents}
            onSection={(section) => setAssistant({ section })}
            onClose={() => setAssistant(null)}
            onFinished={onAgentFinished}
          />
        )}
      </div>
    </AssistantContext.Provider>
  );
}
