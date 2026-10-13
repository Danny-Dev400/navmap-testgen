import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { NavigationMap } from "./navmap-types.js";
import { ActionStepSchema, STATE_ID_RE, type TestCase } from "./navmap-cases.js";
import type { Answer } from "./navmap-questions.js";
import { loadLinks, type PreconditionLink } from "./navmap-links.js";
import type { ProjectUser } from "./navmap-users.js";
import { abs, projectPaths } from "./project-paths.js";

/** Named states the app can be put in before a test ("Cart has items", "Side menu open") and the
 *  reusable flows that produce them. Map actions' free-text preconditions point to a state through
 *  a binding, cases ask for states with `given`, and the planner solves the chain over this graph —
 *  so a state is described and set up once, and every action or case that needs it reuses it. A
 *  state nobody knows how to reach becomes a question for the human, never a guess. */

export const StateKindSchema = z.enum([
  /** UI state on the page (menu open, banner shown): produced on the page that needs it, no navigation in between. */
  "transient",
  /** Survives navigation (cart contents, a submitted form): produced anywhere, then the test goes on. */
  "persistent",
  /** Already true in a fresh session — needs no setup. */
  "initial",
  /** Needs a specific user (e.g. a locked account): the test runs as that user. */
  "account",
]);
export type StateKind = z.infer<typeof StateKindSchema>;

export const StateSchema = z.object({
  id: z.string().regex(STATE_ID_RE),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).optional(),
  kind: StateKindSchema,
  /** The reusable flow: map actions, in order (same step model as cases, no checks). */
  flow: z.array(ActionStepSchema).max(20).optional(),
  /** The flow acts on a list item the consumer can choose ("Cart has {item}"). */
  perItem: z.boolean().optional(),
  /** account states: the user the test runs as. */
  userId: z.string().optional(),
  /** States the flow needs first, beyond what its first action's own preconditions say. */
  requires: z.array(z.string().regex(STATE_ID_RE)).max(10).optional(),
  /** The human answered "this can't be automated": tests needing it stay fixme with this reason. */
  notAutomatable: z.object({ reason: z.string().trim().min(1).max(500) }).optional(),
  /** Context for whoever answers (e.g. why the old linker couldn't resolve it). */
  note: z.string().max(1000).optional(),
  origin: z.enum(["migrated", "agent", "manual", "answer"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type State = z.infer<typeof StateSchema>;

/** A map action's precondition (verbatim) → the state that satisfies it. */
export const BindingSchema = z.object({
  edgeId: z.string().min(1),
  precondition: z.string().min(1),
  stateId: z.string().regex(STATE_ID_RE),
  /** The state's flow acts on the same list item as the consumer action (add X → remove X). */
  sameItem: z.boolean().optional(),
});
export type Binding = z.infer<typeof BindingSchema>;

export const StateGraphSchema = z.object({
  states: z.array(StateSchema),
  bindings: z.array(BindingSchema),
  updatedAt: z.string().optional(),
});
export type StateGraph = z.infer<typeof StateGraphSchema> & {
  /** Not stored: true when built in memory from precondition-links.json (no states.json yet). */
  derivedFromLinks?: boolean;
};

export const EMPTY_GRAPH: StateGraph = { states: [], bindings: [] };

export function bindingKey(edgeId: string, precondition: string): string {
  return `${edgeId}\u0000${precondition}`;
}

// ---- files ----

/** The project's state graph — from states.json, or (before it exists) converted in memory from the
 *  old precondition links, so planning never depends on whether the conversion was saved yet. */
export async function loadStateGraph(rootDir: string, projectId: string, map: NavigationMap): Promise<StateGraph> {
  const file = abs(rootDir, projectPaths(projectId).states);
  let raw: string | undefined;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw !== undefined) return StateGraphSchema.parse(JSON.parse(raw));
  const links = await loadLinks(rootDir, projectId);
  return { ...statesFromLinks(map, links), derivedFromLinks: true };
}

export async function saveStateGraph(rootDir: string, projectId: string, graph: StateGraph): Promise<StateGraph> {
  const { derivedFromLinks: _derived, ...rest } = graph;
  const saved = StateGraphSchema.parse({ ...rest, updatedAt: new Date().toISOString() });
  const file = abs(rootDir, projectPaths(projectId).states);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(saved, null, 2) + "\n", "utf-8");
  return saved;
}

// ---- ids ----

export function stateSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "") || "state"
  );
}

export function uniqueStateId(title: string, taken: Set<string>): string {
  const base = stateSlug(title);
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}

// ---- conversion from precondition links (free, deterministic) ----

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
const sentence = (text: string) => {
  const t = text.trim().replace(/\.$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** One state per distinct precondition text (and setup), so "cart must contain at least 1 item"
 *  linked on seven actions becomes one state with one flow. Unresolvable/rejected judgments become
 *  states without a flow — questions for the human — or join a linked state with the same text
 *  (the same words mean the same state; whether its flow can run there is the planner's call). */
export function statesFromLinks(map: NavigationMap, links: PreconditionLink[], now = new Date().toISOString()): StateGraph {
  const live = links.filter((l) => map.edges[l.edgeId]?.preconditions.includes(l.precondition));
  const taken = new Set<string>();
  const states: State[] = [];
  type Group = { linked: Map<string, State>; unresolved?: State };
  const byText = new Map<string, Group>();

  const groupFor = (text: string): Group => {
    const key = normalize(text);
    const group: Group = byText.get(key) ?? { linked: new Map() };
    byText.set(key, group);
    return group;
  };

  // Linked judgments first, so unresolved ones with the same words can join them.
  for (const link of live.filter((l) => l.status === "linked")) {
    const group = groupFor(link.precondition);
    const setupKey = `${link.scope}|${link.setupEdgeIds.join(",")}`;
    if (group.linked.has(setupKey)) continue;
    const title = sentence(link.precondition) + (group.linked.size > 0 ? ` (${group.linked.size + 1})` : "");
    const state: State = {
      id: uniqueStateId(title, taken),
      title,
      kind: link.scope === "same-page" ? "transient" : "persistent",
      flow: link.setupEdgeIds.map((edgeId) => ({ edgeId })),
      ...(link.setupEdgeIds.some((id) => map.edges[id]?.scope) ? { perItem: true } : {}),
      note: `Converted from a precondition link: ${link.rationale}`,
      origin: "migrated",
      createdAt: now,
      updatedAt: now,
    };
    group.linked.set(setupKey, state);
    states.push(state);
  }
  for (const link of live.filter((l) => l.status !== "linked")) {
    const group = groupFor(link.precondition);
    if (group.linked.size > 0 || group.unresolved) continue;
    const title = sentence(link.precondition);
    group.unresolved = {
      id: uniqueStateId(title, taken),
      title,
      kind: "persistent",
      note: `${link.status === "rejected" ? "The link was rejected after verification" : "The linker found no recorded action that produces it"}: ${link.rationale}`,
      origin: "migrated",
      createdAt: now,
      updatedAt: now,
    };
    states.push(group.unresolved);
  }

  const bindings: Binding[] = live.map((link) => {
    const group = byText.get(normalize(link.precondition))!;
    const state =
      link.status === "linked" ? group.linked.get(`${link.scope}|${link.setupEdgeIds.join(",")}`)! : ([...group.linked.values()][0] ?? group.unresolved!);
    return { edgeId: link.edgeId, precondition: link.precondition, stateId: state.id, ...(link.status === "linked" && link.shareItem ? { sameItem: true } : {}) };
  });
  return { states, bindings };
}

// ---- validation ----

/** Problems that make a state graph unsavable — the UI's PUT and the agent's save script refuse it. */
export function validateStateGraph(graph: StateGraph, map: NavigationMap, users: ProjectUser[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const s of graph.states) {
    if (ids.has(s.id)) errors.push(`state id "${s.id}" is used twice`);
    ids.add(s.id);
  }
  const byId = new Map(graph.states.map((s) => [s.id, s]));
  for (const s of graph.states) {
    const where = `state "${s.title}"`;
    if ((s.kind === "initial" || s.kind === "account") && s.flow?.length) errors.push(`${where}: an ${s.kind} state has no flow`);
    if (s.kind === "account" && !users.some((u) => u.id === s.userId)) errors.push(`${where}: no user "${s.userId ?? ""}" (pick one from the Users tab)`);
    for (const [i, step] of (s.flow ?? []).entries()) {
      const edge = map.edges[step.edgeId];
      if (!edge) {
        errors.push(`${where} step ${i + 1}: no action "${step.edgeId}" in the map`);
        continue;
      }
      if (edge.authFormLocators) errors.push(`${where} step ${i + 1}: logging in isn't a flow step — tests start with the user's session`);
      if (s.kind === "transient" && edge.toPageId !== edge.fromPageId && !edge.external) {
        errors.push(`${where} step ${i + 1}: "${edge.semanticIntent}" navigates away, which would undo a state that only exists on the page`);
      }
      if (step.on && !map.pages[step.on]) errors.push(`${where} step ${i + 1}: no page "${step.on}"`);
    }
    if (s.perItem && !(s.flow ?? []).some((st) => map.edges[st.edgeId]?.scope)) errors.push(`${where}: "per item" needs a flow step that picks a list item`);
    for (const r of s.requires ?? []) if (!byId.has(r)) errors.push(`${where}: requires an unknown state "${r}"`);
  }
  // requires cycles
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, trail: string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`states require each other in a circle: ${[...trail, id].map((x) => byId.get(x)?.title ?? x).join(" → ")}`);
      return;
    }
    visiting.add(id);
    for (const r of byId.get(id)?.requires ?? []) visit(r, [...trail, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const s of graph.states) visit(s.id, []);

  const seen = new Set<string>();
  for (const b of graph.bindings) {
    const edge = map.edges[b.edgeId];
    const where = `binding of "${b.precondition}"`;
    if (!edge) {
      errors.push(`${where}: no action "${b.edgeId}" in the map`);
      continue;
    }
    if (!edge.preconditions.includes(b.precondition)) errors.push(`${where} on "${edge.semanticIntent}": the precondition must be copied verbatim from the action`);
    const state = byId.get(b.stateId);
    if (!state) errors.push(`${where}: no state "${b.stateId}"`);
    const key = bindingKey(b.edgeId, b.precondition);
    if (seen.has(key)) errors.push(`${where} on "${edge.semanticIntent}" is bound twice`);
    seen.add(key);
    if (b.sameItem && (!edge.scope || !state?.flow?.some((st) => map.edges[st.edgeId]?.scope))) {
      errors.push(`${where} on "${edge.semanticIntent}": "same item" needs both the action and a flow step to pick a list item`);
    }
  }
  return errors;
}

/** Bindings whose action or precondition text left the map (re-explored, reworded) — ignored by the
 *  planner, shown so they can be re-linked. */
export function staleBindings(graph: StateGraph, map: NavigationMap): Binding[] {
  return graph.bindings.filter((b) => !map.edges[b.edgeId]?.preconditions.includes(b.precondition));
}

// ---- dependents ----

/** Which actions and (non-rejected) cases need each state — directly through a precondition or a
 *  case's `given`, or indirectly through another state's flow or `requires`. Structural (no
 *  planning), so a state nobody knows how to reach still shows who is waiting for it. */
export function stateDependents(graph: StateGraph, map: NavigationMap, cases: TestCase[]): Map<string, { actions: Set<string>; cases: Set<string> }> {
  const states = new Map(graph.states.map((s) => [s.id, s]));
  const bound = new Map<string, string[]>(); // edgeId -> state ids its preconditions point to
  for (const b of graph.bindings) if (map.edges[b.edgeId]?.preconditions.includes(b.precondition)) bound.set(b.edgeId, [...(bound.get(b.edgeId) ?? []), b.stateId]);

  const closeState = (id: string, out: Set<string>) => {
    if (out.has(id)) return;
    const s = states.get(id);
    if (!s) return;
    out.add(id);
    for (const r of s.requires ?? []) closeState(r, out);
    const first = s.flow?.[0]?.edgeId;
    if (first) for (const next of bound.get(first) ?? []) closeState(next, out);
  };
  const forEdge = (edgeId: string) => {
    const out = new Set<string>();
    for (const id of bound.get(edgeId) ?? []) closeState(id, out);
    return out;
  };

  const result = new Map(graph.states.map((s) => [s.id, { actions: new Set<string>(), cases: new Set<string>() }]));
  for (const edgeId of Object.keys(map.edges)) for (const id of forEdge(edgeId)) result.get(id)?.actions.add(edgeId);
  for (const c of cases) {
    if (c.status === "rejected") continue;
    const needed = forEdge(c.steps[0].edgeId);
    for (const g of c.given ?? []) closeState(g.state, needed);
    for (const id of needed) result.get(id)?.cases.add(c.id);
  }
  return result;
}

// ---- answers ----

function withoutUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** Applies the human's answer to a state. "Same as" merges it into another state: its bindings,
 *  the cases that ask for it and the states that require it move over. Returns the cases whose
 *  `given` changed, to be saved by the caller. */
export function applyAnswer(
  graph: StateGraph,
  map: NavigationMap,
  cases: TestCase[],
  stateId: string,
  answer: Answer,
  now = new Date().toISOString(),
): { graph: StateGraph; changedCases: TestCase[]; error?: string } {
  const state = graph.states.find((s) => s.id === stateId);
  if (!state) return { graph, changedCases: [], error: `No state "${stateId}"` };
  const replace = (next: State): StateGraph => ({ ...graph, states: graph.states.map((s) => (s.id === stateId ? withoutUndefined({ ...next, origin: "answer" as const, updatedAt: now }) : s)) });
  const cleared = { flow: undefined, perItem: undefined, requires: undefined, userId: undefined, notAutomatable: undefined };

  switch (answer.kind) {
    case "initial":
      return { graph: replace({ ...state, ...cleared, kind: "initial" }), changedCases: [] };
    case "user":
      return { graph: replace({ ...state, ...cleared, kind: "account", userId: answer.userId }), changedCases: [] };
    case "notAutomatable":
      return { graph: replace({ ...state, notAutomatable: { reason: answer.reason } }), changedCases: [] };
    case "flow": {
      const scoped = answer.steps.some((st) => map.edges[st.edgeId]?.scope && !st.item);
      return {
        graph: replace({
          ...state,
          ...cleared,
          kind: answer.stateKind ?? (state.kind === "transient" ? "transient" : "persistent"),
          flow: answer.steps,
          perItem: answer.perItem ?? (scoped || undefined),
          requires: state.requires,
        }),
        changedCases: [],
      };
    }
    case "sameAs": {
      const target = graph.states.find((s) => s.id === answer.stateId);
      if (!target || target.id === stateId) return { graph, changedCases: [], error: "Pick another existing state" };
      const targetScoped = !!target.flow?.some((st) => map.edges[st.edgeId]?.scope);
      const bindings = graph.bindings.map((b) => {
        if (b.stateId !== stateId) return b;
        const sameItem = (answer.sameItem ?? b.sameItem) && !!map.edges[b.edgeId]?.scope && targetScoped;
        return withoutUndefined({ ...b, stateId: target.id, sameItem: sameItem || undefined });
      });
      const states = graph.states
        .filter((s) => s.id !== stateId)
        .map((s) => (s.requires?.includes(stateId) ? withoutUndefined({ ...s, requires: [...new Set(s.requires.map((r) => (r === stateId ? target.id : r)))].filter((r) => r !== s.id), updatedAt: now }) : s));
      const changedCases = cases
        .filter((c) => c.given?.some((g) => g.state === stateId))
        .map((c) => {
          const seen = new Set<string>();
          const given = c.given!.map((g) => (g.state === stateId ? { ...g, state: target.id } : g)).filter((g) => {
            const key = `${g.state}#${g.item ?? ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return { ...c, given, updatedAt: now };
        });
      return { graph: { ...graph, states, bindings }, changedCases };
    }
    default:
      return { graph, changedCases: [] };
  }
}
