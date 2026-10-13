import path from "node:path";
import type { Plugin } from "vite";
import type { NavigationMap } from "../../src/navmap-types";
import { planCases } from "../../src/navmap-test-generator";
import { loadProjectUsers, storageStatePathFor } from "../../src/navmap-users";
import { loadStateGraph } from "../../src/navmap-states";
import { loadQuestions } from "../../src/navmap-questions";
import { criterionStatus, loadAnalyses, loadRequirements } from "../../src/navmap-requirements";
import { buildGraphView } from "../../src/navmap-states-view";
import { loadEdgeFlags } from "../../src/navmap-edge-flags";
import { loadCases, uncoveredEdgeIds } from "../../src/navmap-cases";
import { listPageSnapshots } from "../../src/navmap-snapshots";
import { computeJourneys, journeyCoverage } from "../../src/navmap-journeys";
import { listTriageRecords } from "../../src/navmap-triage";
import { hintFor } from "../../src/navmap-triage-rules";
import { diffOrganization, loadOrganization, loadProposal, organizationView, sanitizeOrganization } from "../../src/navmap-features";
import { loadMap, pathExists, PROJECT_ID_RE, sendJson } from "./apiHelpers";
import { getJob, publicJob, type AgentJobKind } from "./agentJobs";
import { caseIdOf, latestRunSummary, latestStatus, listSummaries, runningTestRun, type RunTest } from "./navmapRunsApi";

// /api/projects/<id>/overview — the project's Home: pipeline status, the next step, and the inbox
// of everything waiting for the user. /api/projects/<id>/agents — the light "is an agent running"
// poll for the shell. Read-only, plain code, no AI.
const OVERVIEW_RE = /^\/([a-z0-9-]{1,80})\/(overview|agents)\/?$/;

const AGENT_KINDS: AgentJobKind[] = ["explore", "design", "link", "triage", "organize"];

export type InboxAction =
  | { label: string; kind: "navigate"; tab: string; params?: Record<string, string> }
  | { label: string; kind: "assistant"; section: "explore" | "design" | "link" | "triage" | "organize"; prefill?: { pageId?: string; useCaseId?: string; requirementId?: string; request?: string } }
  | { label: string; kind: "rerun"; caseId: string }
  | { label: string; kind: "triage"; runId: string; testIndex: number };

export interface InboxItem {
  id: string;
  icon: string;
  title: string;
  detail?: string;
  actions: InboxAction[];
}

/** Groups "why is this fixme" into a few causes the user can act on. */
function blockerCause(text: string): { key: string; label: string; action?: InboxAction } {
  if (text.startsWith("Precondition not linked")) {
    return { key: "unlinked", label: "a precondition isn't linked to a state yet", action: { label: "⛓ Link preconditions", kind: "assistant", section: "link" } };
  }
  if (text.startsWith("No one knows how to reach")) {
    return { key: "unanswered", label: "they need a state nobody knows how to reach yet — answer it", action: { label: "Answer", kind: "navigate", tab: "states" } };
  }
  if (/belongs to the .*, which the map hasn't seen on/.test(text)) {
    return { key: "unseen-control", label: "a shared control hasn't been recorded on the page that needs it", action: { label: "Open States", kind: "navigate", tab: "states" } };
  }
  if (text.startsWith("Can't be automated")) return { key: "not-automatable", label: "you marked a state they need as not automatable" };
  if (text.startsWith("Can't be set up automatically") || text.startsWith("Link rejected")) {
    return { key: "unresolvable", label: "a precondition needs data or state no recorded action produces" };
  }
  if (/can't access|No configured user|no auth user/i.test(text)) {
    return { key: "access", label: "no configured user can reach the page", action: { label: "Users", kind: "navigate", tab: "users" } };
  }
  if (text.includes("expected value") && text.includes("isn't set yet")) return { key: "expected", label: "a data row's expected value hasn't been observed yet" };
  return { key: "other", label: "other reasons" };
}

function agentsStatus(projectId: string) {
  const agents = Object.fromEntries(AGENT_KINDS.map((k) => [k, publicJob(getJob(k, projectId))]));
  const running = AGENT_KINDS.find((k) => getJob(k, projectId)?.state === "running" || getJob(k, projectId)?.meta?.verifying) ?? null;
  return { agents, running, testRunRunning: runningTestRun(projectId) };
}

export function navmapOverviewApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  async function overview(map: NavigationMap) {
    const projectId = map.id;
    const [users, graph, flags, cases, snapshots, triage, latestRun, summaries, org, proposal, questions, requirementsFile, analyses] = await Promise.all([
      loadProjectUsers(repoRoot, map),
      loadStateGraph(repoRoot, projectId, map),
      loadEdgeFlags(repoRoot, projectId),
      loadCases(repoRoot, projectId),
      listPageSnapshots(repoRoot, projectId),
      listTriageRecords(repoRoot, projectId),
      latestRunSummary(repoRoot, projectId),
      listSummaries(repoRoot, projectId),
      loadOrganization(repoRoot, projectId),
      loadProposal(repoRoot, projectId),
      loadQuestions(repoRoot, projectId),
      loadRequirements(repoRoot, projectId),
      loadAnalyses(repoRoot, projectId),
    ]);
    const plans = planCases(map, users, graph, cases, flags);
    // States & questions for the human (derived: states nobody knows how to reach; stored: agents').
    const stateView = buildGraphView(map, users, graph, cases, questions, flags);
    const openQuestions = stateView.questions;
    const blockedByQuestions = openQuestions.reduce((n, q) => n + q.blocking, 0);
    const approved = cases.filter((c) => c.status === "approved");
    const drafts = cases.filter((c) => c.status === "draft");
    const needsReview = cases.filter((c) => c.status !== "rejected" && plans.get(c.id)!.health.health === "needs_review");
    const fixme = approved.filter((c) => !plans.get(c.id)!.runnable && plans.get(c.id)!.health.health === "ok");
    const coverage = journeyCoverage(map, computeJourneys(map), approved.map((c) => ({ caseId: c.id, plan: plans.get(c.id)! })));
    const uncovered = uncoveredEdgeIds(map, cases);
    const proposals = triage.filter((r) => r.status === "proposed");
    // Failures = tests whose LATEST result (newest run that ran them) is a failure — a later passing
    // run clears it. Keyed by case + data row.
    const latestByTest = new Map<string, { t: RunTest; i: number; runId: string }>();
    for (const sum of summaries) {
      sum.tests.forEach((t, i) => {
        const key = `${caseIdOf(t) ?? t.title}#${t.row ?? ""}`;
        if (!latestByTest.has(key)) latestByTest.set(key, { t, i, runId: sum.runId });
      });
    }
    const liveCaseIds = new Set(approved.map((c) => c.id));
    const failed = [...latestByTest.values()].filter(({ t }) => t.status === "failed" && (!caseIdOf(t) || liveCaseIds.has(caseIdOf(t)!)));
    const triaged = new Set(triage.map((r) => `${r.runId}#${r.testIndex}`));
    const untriaged = failed.filter(({ i, runId }) => !triaged.has(`${runId}#${i}`));

    // ---- Features → use cases: coverage from each case's latest result — the newest run that ran
    // it, worst of its data rows (the same rule as the Test cases tab).
    const latestCases = latestStatus(summaries, cases).cases;
    const caseResult = new Map(
      Object.entries(latestCases).map(([id, e]) => [id, e.status === "failed" ? "failed" : e.status === "passed" || e.status === "flaky" ? "passed" : "other"] as const),
    );
    const orgView = organizationView(org, map, cases, plans);
    const features = orgView.features.map((f) => {
      const useCases = f.useCases.map((u) => {
        const runnable = u.cases.filter((id) => liveCaseIds.has(id) && plans.get(id)?.runnable);
        const failedHere = runnable.filter((id) => caseResult.get(id) === "failed").length;
        const passedHere = runnable.filter((id) => caseResult.get(id) === "passed").length;
        const status =
          u.approved === 0
            ? "none"
            : failedHere > 0
              ? "failing"
              : runnable.length > 0 && runnable.length === u.approved && passedHere === runnable.length && u.actionsExercised.length === u.actions.length
                ? "ok"
                : "partial";
        return { id: u.id, title: u.title, description: u.description ?? null, status, passed: passedHere, failed: failedHere };
      });
      return {
        id: f.id,
        title: f.title,
        useCases,
        tested: useCases.filter((u) => u.status !== "none").length,
        passed: useCases.reduce((n, u) => n + u.passed, 0),
        failed: useCases.reduce((n, u) => n + u.failed, 0),
      };
    });
    const untestedUseCases = features.flatMap((f) => f.useCases.filter((u) => u.status === "none").map((u) => ({ ...u, featureTitle: f.title })));
    const unsortedLive = orgView.unsorted.filter((u) => cases.find((c) => c.id === u.caseId)?.status !== "rejected");
    const proposalSummary = proposal
      ? diffOrganization(org ? sanitizeOrganization(org, map, cases).org : null, sanitizeOrganization(proposal.organization, map, cases).org).summary
      : null;
    const designUseCase = (u: { id: string; title: string; description: string | null; featureTitle: string }): InboxAction => ({
      label: "✨ Ask the designer",
      kind: "assistant",
      section: "design",
      prefill: {
        useCaseId: u.id,
        request: `Design cases that prove the use case "${u.featureTitle} › ${u.title}"${u.description ? ` — ${u.description}` : ""}. Skip what its existing cases already cover.`,
      },
    });

    // Auth users whose approved, runnable cases need a session that isn't saved yet.
    const sessionUsers = new Map<string, string>();
    for (const c of approved) {
      const p = plans.get(c.id)!;
      if (p.authDependent && p.user) sessionUsers.set(p.user.id, p.user.label);
    }
    const missingSessions: { id: string; label: string }[] = [];
    for (const [id, label] of sessionUsers) if (!(await pathExists(path.join(repoRoot, storageStatePathFor(map, id))))) missingSessions.push({ id, label });

    const lastCaseChange = approved.reduce((m, c) => (c.updatedAt > m ? c.updatedAt : m), "");
    const staleRun = approved.length > 0 && (!latestRun || latestRun.finishedAt < lastCaseChange);
    const agentDrafts = drafts.filter((c) => c.origin === "agent").length;
    const pageTitle = (id: string) => map.pages[id]?.title ?? id;

    // ---- Inbox: what waits for a decision, each with its action(s).
    const inbox: InboxItem[] = [];
    if (drafts.length) {
      inbox.push({
        id: "drafts",
        icon: "📝",
        title: `${drafts.length} draft case${drafts.length === 1 ? "" : "s"} to review${agentDrafts ? ` (${agentDrafts} from the designer)` : ""}`,
        detail: "Drafts don't generate tests until you approve them.",
        actions: [{ label: "Review drafts", kind: "navigate", tab: "cases", params: { filter: "draft" } }],
      });
    }
    if (proposal) {
      inbox.push({
        id: "org-proposal",
        icon: "🗂",
        title: `Proposed organization to review: ${proposalSummary}`,
        detail: "The organizer grouped your cases into features → use cases. Nothing changes until you accept.",
        actions: [{ label: "Review", kind: "navigate", tab: "cases", params: { proposal: "1" } }],
      });
    }
    for (const c of needsReview) {
      inbox.push({
        id: `review-${c.id}`,
        icon: "⚠️",
        title: `Needs review: ${c.title}`,
        detail: plans.get(c.id)!.health.reasons[0],
        actions: [{ label: "Open case", kind: "navigate", tab: "cases", params: { case: c.id } }],
      });
    }
    for (const q of openQuestions.slice(0, 6)) {
      inbox.push({
        id: `question-${q.key}`,
        icon: "❓",
        title: q.title,
        detail: `${q.blocking ? `Blocks ${q.blocking} case${q.blocking === 1 ? "" : "s"}. ` : ""}${q.source === "agent" ? `Asked by the ${q.askedBy}. ` : ""}${q.detail.slice(0, 180)}`,
        actions: [{ label: "Answer", kind: "navigate", tab: "states", params: q.stateId ? { state: q.stateId } : {} }],
      });
    }
    if (openQuestions.length > 6) {
      inbox.push({ id: "questions-more", icon: "❓", title: `${openQuestions.length - 6} more questions for you`, actions: [{ label: "Open States", kind: "navigate", tab: "states" }] });
    }
    if (stateView.unbound.length) {
      inbox.push({
        id: "states-unbound",
        icon: "⛓",
        title: `${stateView.unbound.length} precondition${stateView.unbound.length === 1 ? " isn't" : "s aren't"} linked to a state`,
        detail: stateView.unbound.slice(0, 3).map((u) => `"${u.precondition}" (${u.intent})`).join(" · ") + (stateView.unbound.length > 3 ? " …" : ""),
        actions: [{ label: "⛓ Link them (agent)", kind: "assistant", section: "link" }, { label: "Open States", kind: "navigate", tab: "states" }],
      });
    }
    const byCause = new Map<string, { label: string; action?: InboxAction; caseIds: string[] }>();
    for (const c of fixme) {
      const cause = blockerCause(plans.get(c.id)!.blockers[0] ?? "");
      const group = byCause.get(cause.key) ?? { label: cause.label, action: cause.action, caseIds: [] };
      group.caseIds.push(c.id);
      byCause.set(cause.key, group);
    }
    for (const [key, g] of byCause) {
      inbox.push({
        id: `fixme-${key}`,
        icon: "⏸️",
        title: `${g.caseIds.length} approved case${g.caseIds.length === 1 ? "" : "s"} can't run yet: ${g.label}`,
        detail: g.caseIds.slice(0, 4).map((id) => cases.find((c) => c.id === id)?.title).join(" · ") + (g.caseIds.length > 4 ? " …" : ""),
        actions: [...(g.action ? [g.action] : []), { label: "Show them", kind: "navigate", tab: "cases", params: { filter: "fixme" } }],
      });
    }
    for (const { t, i, runId } of untriaged) {
      const hint = hintFor(t.error, map);
      const caseId = caseIdOf(t);
      inbox.push({
        id: `fail-${runId}-${i}`,
        icon: "❌",
        title: `Failed: ${t.title}`,
        detail: `${t.failedStep ? `In step "${t.failedStep}". ` : ""}${hint.reason}`,
        actions: [
          ...(hint.rerunFirst && caseId ? [{ label: "▶ Rerun (free)", kind: "rerun", caseId } as InboxAction] : []),
          { label: "🩺 Diagnose", kind: "triage", runId, testIndex: i },
          { label: "Open run", kind: "navigate", tab: "runs", params: { run: runId } },
        ],
      });
    }
    for (const r of proposals) {
      const v = r.verification;
      inbox.push({
        id: `fix-${r.id}`,
        icon: "🔧",
        title: `Fix proposed for "${r.title}"`,
        detail: `${r.explanation.slice(0, 160)}${!v ? " · not verified yet" : v.result === "passed" ? " · ✓ passed with the fix" : v.result === "failed" ? " · ✗ still failing with the fix" : ` · verification skipped (${v.reason})`}`,
        actions: [{ label: "Review fix", kind: "navigate", tab: "runs", params: { run: r.runId } }],
      });
    }
    for (const u of missingSessions) {
      inbox.push({
        id: `session-${u.id}`,
        icon: "🔑",
        title: `${u.label} has no saved session`,
        detail: "Their tests log in on first run; setting one up now avoids a slow first test.",
        actions: [{ label: "Users", kind: "navigate", tab: "users" }],
      });
    }
    // ---- Requirements: acceptance criteria from their linked cases (same rule as the Requirements tab).
    const caseById = new Map(cases.map((c) => [c.id, c]));
    const reqCriteria = requirementsFile.requirements.flatMap((r) =>
      r.criteria.map((c) => ({
        requirement: r,
        status: criterionStatus(c.caseIds, (id) => {
          const tc = caseById.get(id);
          return tc && { status: tc.status, runnable: !!plans.get(id)?.runnable, last: latestCases[id]?.status };
        }),
      })),
    );
    const failingCriteria = reqCriteria.filter((c) => c.status === "failing");
    const uncoveredCriteria = reqCriteria.filter((c) => c.status === "uncovered");
    const pendingAnalyses = analyses.filter((a) => requirementsFile.requirements.some((r) => r.id === a.requirementId));
    if (pendingAnalyses.length) {
      inbox.push({
        id: "req-analyses",
        icon: "📋",
        title: `Review the analysis of ${pendingAnalyses.length} requirement${pendingAnalyses.length === 1 ? "" : "s"}`,
        detail: "The analyst proposed acceptance criteria and links to your cases — accept or discard.",
        actions: [{ label: "Review", kind: "navigate", tab: "requirements", params: { req: pendingAnalyses[0].requirementId } }],
      });
    }
    if (failingCriteria.length) {
      inbox.push({
        id: "req-failing",
        icon: "❌",
        title: `${failingCriteria.length} acceptance criteri${failingCriteria.length === 1 ? "on is" : "a are"} failing`,
        detail: [...new Set(failingCriteria.map((c) => c.requirement.key ?? c.requirement.title))].slice(0, 4).join(" · "),
        actions: [{ label: "Open Requirements", kind: "navigate", tab: "requirements", params: { filter: "failing" } }],
      });
    }
    if (uncoveredCriteria.length) {
      const first = uncoveredCriteria[0].requirement;
      inbox.push({
        id: "req-uncovered",
        icon: "📋",
        title: `${uncoveredCriteria.length} acceptance criteri${uncoveredCriteria.length === 1 ? "on has" : "a have"} no test case`,
        detail: [...new Set(uncoveredCriteria.map((c) => c.requirement.key ?? c.requirement.title))].slice(0, 4).join(" · "),
        actions: [
          { label: "Open Requirements", kind: "navigate", tab: "requirements", params: { filter: "uncovered" } },
          { label: "✨ Design for the first", kind: "assistant", section: "design", prefill: { requirementId: first.id } },
        ],
      });
    }
    if (org && unsortedLive.length) {
      const withSuggestion = unsortedLive.filter((u) => u.suggestion).length;
      inbox.push({
        id: "org-unsorted",
        icon: "📦",
        title: `${unsortedLive.length} case${unsortedLive.length === 1 ? " isn't" : "s aren't"} in a use case yet`,
        detail: withSuggestion ? `${withSuggestion} with a suggestion — one click sorts them.` : "Pick a use case for each, or let the organizer place them.",
        actions: [
          { label: "Sort them", kind: "navigate", tab: "cases", params: { group: "feature" } },
          { label: "🗂 Organizer", kind: "assistant", section: "organize" },
        ],
      });
    }
    if (org && orgView.unorganizedActions.length) {
      inbox.push({
        id: "org-actions",
        icon: "🧩",
        title: `${orgView.unorganizedActions.length} map action${orgView.unorganizedActions.length === 1 ? " isn't" : "s aren't"} in any use case`,
        detail: orgView.unorganizedActions.slice(0, 4).map((id) => map.edges[id]?.semanticIntent).join(" · ") + (orgView.unorganizedActions.length > 4 ? " …" : ""),
        actions: [{ label: "🗂 Update organization", kind: "assistant", section: "organize" }],
      });
    }

    // ---- The one next step.
    const uncoveredJourneys = coverage.journeys.filter((j) => !j.covered);
    const next = ((): { title: string; why: string; action?: InboxAction } => {
      if (Object.keys(map.pages).length === 0) return { title: "Explore the site", why: "The map is empty.", action: { label: "Explore", kind: "assistant", section: "explore" } };
      if (cases.length === 0) {
        return { title: "Create your first test cases", why: `The map has ${Object.keys(map.edges).length} actions and no test cases yet.`, action: { label: "Go to Test cases", kind: "navigate", tab: "cases" } };
      }
      if (drafts.length) return { title: `Review ${drafts.length} draft${drafts.length === 1 ? "" : "s"}`, why: "Approved cases become tests; drafts wait for you.", action: { label: "Review drafts", kind: "navigate", tab: "cases", params: { filter: "draft" } } };
      if (proposal) return { title: "Review the proposed organization", why: proposalSummary ?? "", action: { label: "Review", kind: "navigate", tab: "cases", params: { proposal: "1" } } };
      if (needsReview.length) return { title: `Check ${needsReview.length} case${needsReview.length === 1 ? "" : "s"} the map changed under`, why: needsReview[0] ? plans.get(needsReview[0].id)!.health.reasons[0] : "", action: { label: "Open", kind: "navigate", tab: "cases", params: { filter: "needs_review" } } };
      if (blockedByQuestions > 0) {
        return {
          title: `Answer ${openQuestions.length} question${openQuestions.length === 1 ? "" : "s"}`,
          why: `They block ${blockedByQuestions} case${blockedByQuestions === 1 ? "" : "s"} — e.g. ${openQuestions[0].title}`,
          action: { label: "Answer", kind: "navigate", tab: "states", params: openQuestions[0].stateId ? { state: openQuestions[0].stateId } : {} },
        };
      }
      if (!approved.length) return { title: "Approve some cases", why: "Nothing is approved, so there are no tests to run.", action: { label: "Go to Test cases", kind: "navigate", tab: "cases" } };
      if (staleRun) return { title: "Run the suite", why: latestRun ? "Cases changed since the last run." : "No run yet.", action: { label: "Go to Test cases", kind: "navigate", tab: "cases" } };
      if (untriaged.length) {
        return {
          title: `Diagnose ${untriaged.length} failure${untriaged.length === 1 ? "" : "s"}`,
          why: "Some tests' latest result is a failure nobody has looked at.",
          action: { label: "Open run", kind: "navigate", tab: "runs", params: { run: untriaged[0].runId } },
        };
      }
      if (proposals.length) return { title: `Decide on ${proposals.length} proposed fix${proposals.length === 1 ? "" : "es"}`, why: "Verified fixes wait for your approval.", action: { label: "Review", kind: "navigate", tab: "runs", params: { run: proposals[0].runId } } };
      if (!org && cases.length >= 3) {
        return {
          title: "Organize cases by feature",
          why: `${cases.length} cases sit in one list by page — group them by what the app does (features → use cases) to see what each capability has tested.`,
          action: { label: "🗂 Propose an organization", kind: "assistant", section: "organize" },
        };
      }
      if (untestedUseCases.length) {
        const u = untestedUseCases[0];
        return {
          title: `${untestedUseCases.length} use case${untestedUseCases.length === 1 ? " has" : "s have"} no approved test`,
          why: `e.g. ${u.featureTitle} › ${u.title}`,
          action: designUseCase(u),
        };
      }
      if (uncoveredJourneys.length) {
        const j = uncoveredJourneys[0];
        return {
          title: `Cover ${uncoveredJourneys.length} journey${uncoveredJourneys.length === 1 ? "" : "s"} end to end`,
          why: `e.g. ${j.pages.map(pageTitle).join(" → ")}`,
          action: {
            label: "✨ Ask the designer",
            kind: "assistant",
            section: "design",
            prefill: { pageId: j.pages[0], request: `Design one end-to-end case for the journey ${j.pages.map(pageTitle).join(" → ")}, with meaningful checks on each page.` },
          },
        };
      }
      return { title: "All green ✓", why: "Every approved case passed in the last run and nothing waits for you." };
    })();

    return {
      map: {
        pages: Object.keys(map.pages).length,
        actions: Object.keys(map.edges).length,
        snapshots: Object.keys(snapshots).length,
        explorations: map.totalRunsMerged,
        updatedAt: map.updatedAt,
      },
      cases: {
        approved: approved.length,
        drafts: drafts.length,
        needsReview: needsReview.length,
        fixme: fixme.length,
        runnable: approved.length - fixme.length,
        actionsWithoutCase: uncovered.length,
      },
      states: { count: graph.states.length, questions: openQuestions.length, unbound: stateView.unbound.length },
      requirements: {
        count: requirementsFile.requirements.length,
        criteria: reqCriteria.length,
        uncovered: uncoveredCriteria.length,
        failing: failingCriteria.length,
        analyses: pendingAnalyses.length,
      },
      organization: org
        ? {
            features: features.length,
            useCases: features.reduce((n, f) => n + f.useCases.length, 0),
            tested: features.reduce((n, f) => n + f.tested, 0),
            unsorted: unsortedLive.length,
          }
        : null,
      features,
      runs: latestRun
        ? { runId: latestRun.runId, label: latestRun.scope.label, finishedAt: latestRun.finishedAt, counts: latestRun.counts, stale: staleRun }
        : null,
      diagnosis: { untriaged: untriaged.length, proposals: proposals.length },
      journeys: coverage.journeys.map((j) => ({ ...j, titles: j.pages.map(pageTitle) })),
      next,
      inbox,
      ...agentsStatus(projectId),
    };
  }

  return {
    name: "navmap-overview-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const m = OVERVIEW_RE.exec((req.url ?? "/").split("?")[0]);
        if (!m || req.method !== "GET") return next();
        const [, projectId, what] = m;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });
        try {
          if (what === "agents") return sendJson(res, 200, agentsStatus(projectId));
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });
          return sendJson(res, 200, await overview(map));
        } catch (err) {
          console.error(`[navmap-overview-api] ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Overview failed" });
        }
      });
    },
  };
}
