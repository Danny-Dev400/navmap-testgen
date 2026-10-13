import type { NavigationMap } from "./navmap-types.js";
import type { TestCase } from "./navmap-cases.js";
import { chooseUserForPage, type ProjectUser } from "./navmap-users.js";
import { computeUiComponents, type UiComponent } from "./navmapUiComponents.js";
import { planCases, planEdges, remainingPreconditions, type PlannedState } from "./navmap-test-generator.js";
import { bindingKey, stateDependents, staleBindings, type Binding, type State, type StateGraph } from "./navmap-states.js";
import type { EdgeFlags } from "./navmap-edge-flags.js";
import type { Answer, Question } from "./navmap-questions.js";

/** What the 🧩 States tab, the Home inbox and the agents' context show about the state graph —
 *  each state's status (can it be set up, and where not), who needs it, and the open questions
 *  (derived from states nobody knows how to reach, plus what agents asked). Plain code, no AI. */

export type StateStatus = "ok" | "needs_answer" | "cant_run_here" | "not_automatable";

export interface StateView {
  id: string;
  title: string;
  description?: string;
  kind: State["kind"];
  flow: { edgeId: string; intent: string; pageTitle: string; item: string | null; input: string | null; on: string | null }[];
  perItem: boolean;
  userId: string | null;
  userLabel: string | null;
  requires: { id: string; title: string }[];
  notAutomatable: { reason: string } | null;
  note: string | null;
  origin: State["origin"];
  updatedAt: string;
  status: StateStatus;
  /** Pages that need it where its flow can't run (a shared control the map hasn't seen there). */
  cantRunOn: { pageId: string; pageTitle: string; reason: string }[];
  usedBy: {
    actions: { edgeId: string; intent: string; pageTitle: string; precondition: string; sameItem: boolean; canShareItem: boolean }[];
    /** Cases that need it, directly or through other states. */
    cases: { id: string; title: string; status: TestCase["status"]; runnable: boolean }[];
  };
  /** Non-rejected cases that need it and can't run. */
  blocking: number;
}

export interface QuestionView {
  /** Stable key: the stored question's id, or "state:<id>:<issue>" for a derived one. */
  key: string;
  source: "derived" | "agent";
  askedBy: Question["askedBy"] | "planner";
  questionId: string | null;
  stateId: string | null;
  issue: "no_flow" | "cant_run_here" | "free";
  title: string;
  detail: string;
  suggestions: { label: string; answer: Answer }[];
  blocking: number;
  createdAt: string | null;
}

export interface GraphView {
  derivedFromLinks: boolean;
  updatedAt: string | null;
  states: StateView[];
  /** Preconditions no state is bound to yet — the state linker's work. */
  unbound: { edgeId: string; intent: string; pageTitle: string; precondition: string }[];
  /** Bindings whose action or precondition text left the map. */
  stale: Binding[];
  questions: QuestionView[];
  answeredCount: number;
  users: { id: string; label: string; kind: ProjectUser["kind"] }[];
}

function componentMembership(map: NavigationMap): Map<string, UiComponent> {
  const out = new Map<string, UiComponent>();
  for (const component of computeUiComponents(map).values()) for (const el of component.elements) for (const e of el.memberEdges) out.set(e.id, component);
  return out;
}

export function buildGraphView(map: NavigationMap, users: ProjectUser[], graph: StateGraph, cases: TestCase[], questions: Question[], flags?: EdgeFlags): GraphView {
  const pageTitle = (id: string) => map.pages[id]?.title ?? id;
  const casePlans = planCases(map, users, graph, cases, flags);
  const edgePlans = planEdges(map, users, graph);
  const components = componentMembership(map);
  const dependents = stateDependents(graph, map, cases);
  const byId = new Map(graph.states.map((s) => [s.id, s]));
  const casesById = new Map(cases.map((c) => [c.id, c]));

  // Where a planned flow step can't run: a shared control used on a page the map hasn't seen it on.
  const cantRun = new Map<string, Map<string, string>>(); // stateId -> pageId -> reason
  const inspect = (given: PlannedState[]) => {
    for (const g of given) {
      for (const step of g.steps) {
        const component = components.get(step.edge.id);
        if (step.location === step.edge.fromPageId || component?.pageIds.includes(step.location)) continue;
        const reason = component
          ? `"${step.edge.semanticIntent}" belongs to the ${component.regionName}, which the map hasn't seen on this page`
          : `"${step.edge.semanticIntent}" was only recorded on "${pageTitle(step.edge.fromPageId)}"`;
        const forState = cantRun.get(g.state.id) ?? new Map<string, string>();
        forState.set(step.location, reason);
        cantRun.set(g.state.id, forState);
      }
    }
  };
  for (const p of edgePlans.values()) inspect(p.given);
  for (const p of casePlans.values()) inspect(p.given);

  const states: StateView[] = graph.states.map((s) => {
    const deps = dependents.get(s.id)!;
    const caseList = [...deps.cases].map((id) => {
      const c = casesById.get(id)!;
      return { id, title: c.title, status: c.status, runnable: !!casePlans.get(id)?.runnable };
    });
    const pages = cantRun.get(s.id);
    const status: StateStatus = s.notAutomatable
      ? "not_automatable"
      : (s.kind === "transient" || s.kind === "persistent") && !s.flow?.length
        ? "needs_answer"
        : pages?.size
          ? "cant_run_here"
          : "ok";
    const targetScoped = !!s.flow?.some((st) => map.edges[st.edgeId]?.scope);
    return {
      id: s.id,
      title: s.title,
      ...(s.description ? { description: s.description } : {}),
      kind: s.kind,
      flow: (s.flow ?? []).map((st) => {
        const e = map.edges[st.edgeId];
        return { edgeId: st.edgeId, intent: e?.semanticIntent ?? `(missing action ${st.edgeId})`, pageTitle: pageTitle(st.on ?? e?.fromPageId ?? ""), item: st.item ?? e?.scope?.hasText ?? null, input: st.input ?? null, on: st.on ?? null };
      }),
      perItem: !!s.perItem,
      userId: s.userId ?? null,
      userLabel: s.userId ? (users.find((u) => u.id === s.userId)?.label ?? s.userId) : null,
      requires: (s.requires ?? []).map((id) => ({ id, title: byId.get(id)?.title ?? id })),
      notAutomatable: s.notAutomatable ?? null,
      note: s.note ?? null,
      origin: s.origin,
      updatedAt: s.updatedAt,
      status,
      cantRunOn: [...(pages ?? new Map()).entries()].map(([pageId, reason]) => ({ pageId, pageTitle: pageTitle(pageId), reason })),
      usedBy: {
        actions: graph.bindings
          .filter((b) => b.stateId === s.id && map.edges[b.edgeId]?.preconditions.includes(b.precondition))
          .map((b) => ({
            edgeId: b.edgeId,
            intent: map.edges[b.edgeId].semanticIntent,
            pageTitle: pageTitle(map.edges[b.edgeId].fromPageId),
            precondition: b.precondition,
            sameItem: !!b.sameItem,
            canShareItem: !!map.edges[b.edgeId].scope && targetScoped,
          })),
        cases: caseList,
      },
      blocking: caseList.filter((c) => !c.runnable).length,
    };
  });

  // Preconditions that matter (someone can run the action) and point to no state.
  const bound = new Set(graph.bindings.map((b) => bindingKey(b.edgeId, b.precondition)));
  const unbound: GraphView["unbound"] = [];
  for (const edge of Object.values(map.edges)) {
    if (edge.authFormLocators) continue;
    const page = map.pages[edge.fromPageId];
    const runner = page ? chooseUserForPage(page, users) : undefined;
    if (!runner) continue;
    for (const p of remainingPreconditions(edge, runner.kind === "auth")) {
      if (!bound.has(bindingKey(edge.id, p))) unbound.push({ edgeId: edge.id, intent: edge.semanticIntent, pageTitle: pageTitle(edge.fromPageId), precondition: p });
    }
  }

  // Questions: one per state that needs an answer (agent questions about it win — they carry
  // suggestions), plus the agents' free questions. A dismissed one isn't asked again.
  const closed = new Set(questions.filter((q) => q.status !== "open" && q.about.kind === "state").map((q) => `${(q.about as { stateId: string }).stateId}:${(q.about as { issue?: string }).issue ?? "no_flow"}`));
  const agentOpen = questions.filter((q) => q.status === "open");
  const views: QuestionView[] = [];
  for (const s of states) {
    if (s.status !== "needs_answer" && s.status !== "cant_run_here") continue;
    const issue = s.status === "needs_answer" ? "no_flow" : "cant_run_here";
    const fromAgent = agentOpen.find((q) => q.about.kind === "state" && q.about.stateId === s.id && (q.about.issue ?? "no_flow") === issue);
    if (!fromAgent && closed.has(`${s.id}:${issue}`)) continue;
    const who = [...s.usedBy.cases.map((c) => c.title), ...s.usedBy.actions.map((a) => a.intent)];
    const needed = who.length ? `Needed by ${[...new Set(who)].slice(0, 4).join(", ")}${who.length > 4 ? " …" : ""}.` : "";
    views.push({
      key: fromAgent?.id ?? `state:${s.id}:${issue}`,
      source: fromAgent ? "agent" : "derived",
      askedBy: fromAgent?.askedBy ?? "planner",
      questionId: fromAgent?.id ?? null,
      stateId: s.id,
      issue,
      title: fromAgent?.title ?? (issue === "no_flow" ? `How does a test reach "${s.title}"?` : `How is "${s.title}" set up on ${s.cantRunOn.map((p) => p.pageTitle).join(", ")}?`),
      detail:
        fromAgent?.detail ??
        [needed, issue === "no_flow" ? (s.note ?? "No recorded action is known to produce it.") : groupedReasons(s.cantRunOn)].filter(Boolean).join(" "),
      suggestions: fromAgent?.suggestions ?? [],
      blocking: s.blocking,
      createdAt: fromAgent?.createdAt ?? null,
    });
  }
  for (const q of agentOpen) {
    if (q.about.kind !== "free") continue;
    views.push({ key: q.id, source: "agent", askedBy: q.askedBy, questionId: q.id, stateId: null, issue: "free", title: q.title, detail: q.detail ?? "", suggestions: q.suggestions ?? [], blocking: 0, createdAt: q.createdAt });
  }
  views.sort((a, b) => b.blocking - a.blocking);

  return {
    derivedFromLinks: !!graph.derivedFromLinks,
    updatedAt: graph.updatedAt ?? null,
    states,
    unbound,
    stale: staleBindings(graph, map),
    questions: views,
    answeredCount: questions.filter((q) => q.status === "answered").length,
    users: users.map((u) => ({ id: u.id, label: u.label, kind: u.kind })),
  };
}

/** "X belongs to the navbar, which the map hasn't seen on: A, B, C." — one line per distinct reason. */
function groupedReasons(pages: StateView["cantRunOn"]): string {
  const byReason = new Map<string, string[]>();
  for (const p of pages) byReason.set(p.reason, [...(byReason.get(p.reason) ?? []), p.pageTitle]);
  return [...byReason].map(([reason, titles]) => `${reason.replace(/ on this page$/, "")}: ${titles.join(", ")}.`).join(" ");
}
