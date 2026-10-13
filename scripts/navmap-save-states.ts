import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { loadProjectUsers } from "../src/navmap-users.js";
import { loadCases } from "../src/navmap-cases.js";
import { BindingSchema, bindingKey, loadStateGraph, saveStateGraph, StateSchema, validateStateGraph, type State, type StateGraph } from "../src/navmap-states.js";
import { addQuestions, AskInputSchema, loadQuestions, saveQuestions } from "../src/navmap-questions.js";
import { planCases, planEdges } from "../src/navmap-test-generator.js";

// Validates the state linker's staged work and merges it into projects/<id>/states.json:
// - new states (transient/persistent, with or without a flow) — reuse existing ones first;
// - a flow for an existing state that has none (only if the user hasn't answered/edited it);
// - bindings for preconditions that aren't linked yet;
// - questions for the user (what it couldn't resolve).
// The user owns everything else: an agent never changes an existing state's kind, flow or answer,
// never re-links a precondition the graph already links, never marks anything initial, a user's
// or not automatable — it suggests those in a question instead. Dry-runs the planner and reports
// what became runnable and what is still blocked. Saves nothing if anything is invalid.
const StagedState = StateSchema.omit({ origin: true, createdAt: true, updatedAt: true }).extend({ kind: z.enum(["transient", "persistent"]) });
const Staged = z.object({
  states: z.array(StagedState).max(40).default([]),
  bindings: z.array(BindingSchema).max(200).default([]),
  questions: z.array(AskInputSchema).max(10).default([]),
});

const [projectId, stagedPath] = process.argv.slice(2);
if (!projectId || !stagedPath || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error("Usage: npm run navmap:save-states -- <projectId> <staged-states.json>");
  process.exit(1);
}
const rootDir = process.cwd();
const map = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(rootDir, projectPaths(projectId).navmap), "utf-8")));
const parsed = Staged.safeParse(JSON.parse(await readFile(stagedPath, "utf-8")));
if (!parsed.success) {
  console.error(`Nothing saved — the staged states don't match the schema:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}
const staged = parsed.data;
const users = await loadProjectUsers(rootDir, map);
const cases = await loadCases(rootDir, projectId);
const before = await loadStateGraph(rootDir, projectId, map);
const now = new Date().toISOString();
const errors: string[] = [];

const states = new Map(before.states.map((s) => [s.id, s]));
for (const s of staged.states) {
  const existing = states.get(s.id);
  if (!existing) {
    if (s.notAutomatable) errors.push(`state "${s.title}": only the user marks a state as not automatable — ask instead`);
    states.set(s.id, { ...s, notAutomatable: undefined, origin: "agent", createdAt: now, updatedAt: now } as State);
    continue;
  }
  // The only change an agent may make to an existing state: give a flow to one nobody answered yet.
  const userOwned = existing.origin === "answer" || existing.origin === "manual";
  if (existing.flow?.length || userOwned || existing.kind === "initial" || existing.kind === "account" || existing.notAutomatable) {
    errors.push(`state "${existing.title}" already exists${userOwned ? " and the user owns it" : " with a flow"} — reuse it as it is (bind to it), or ask the user to change it`);
    continue;
  }
  if (!s.flow?.length) continue;
  states.set(s.id, { ...existing, kind: s.kind, flow: s.flow, ...(s.perItem ? { perItem: true } : {}), ...(s.requires?.length ? { requires: s.requires } : {}), origin: "agent", updatedAt: now });
}

const bindings = new Map(before.bindings.map((b) => [bindingKey(b.edgeId, b.precondition), b]));
for (const b of staged.bindings) {
  const key = bindingKey(b.edgeId, b.precondition);
  const existing = bindings.get(key);
  const stale = existing && !map.edges[existing.edgeId]?.preconditions.includes(existing.precondition);
  if (existing && !stale && existing.stateId !== b.stateId) {
    errors.push(`"${b.precondition}" on ${b.edgeId} is already linked to "${states.get(existing.stateId)?.title ?? existing.stateId}" — moving it is the user's call (ask if you think it's wrong)`);
    continue;
  }
  bindings.set(key, b);
}

const after: StateGraph = { states: [...states.values()], bindings: [...bindings.values()] };
errors.push(...validateStateGraph(after, map, users));
const stateIds = new Set(after.states.map((s) => s.id));
for (const q of staged.questions) {
  if (q.about.kind === "state" && !stateIds.has(q.about.stateId)) errors.push(`question "${q.title}": no state "${q.about.stateId}"`);
  for (const s of q.suggestions ?? []) {
    if (s.answer.kind === "text" || s.answer.kind === "dismiss") errors.push(`question "${q.title}": suggestion "${s.label}" must be a concrete answer`);
    if (s.answer.kind === "sameAs" && !stateIds.has(s.answer.stateId)) errors.push(`question "${q.title}": suggestion "${s.label}" points to an unknown state`);
  }
}
if (errors.length) {
  console.error(`Nothing saved — fix these and re-run:\n${[...new Set(errors)].map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}

const runnableEdgesBefore = new Set([...planEdges(map, users, before)].filter(([, p]) => p.runnable).map(([id]) => id));
const casePlansBefore = planCases(map, users, before, cases);
const edgePlansAfter = planEdges(map, users, after);
const casePlansAfter = planCases(map, users, after, cases);
await saveStateGraph(rootDir, projectId, after);
if (staged.questions.length) {
  const { questions } = addQuestions(await loadQuestions(rootDir, projectId), staged.questions, "linker", now);
  await saveQuestions(rootDir, projectId, questions);
}

const touched = new Set(staged.bindings.map((b) => b.edgeId));
const promoted = [...edgePlansAfter].filter(([id, p]) => p.runnable && !runnableEdgesBefore.has(id));
const stillBlocked = [...edgePlansAfter].filter(([id, p]) => !p.runnable && touched.has(id));
const casesPromoted = cases.filter((c) => c.status === "approved" && casePlansAfter.get(c.id)?.runnable && !casePlansBefore.get(c.id)?.runnable);
console.log(
  `Saved ${after.states.length} state(s) (${staged.states.filter((s) => !before.states.some((b) => b.id === s.id)).length} new) and ${after.bindings.length} binding(s) (${staged.bindings.length} staged)${staged.questions.length ? `; asked ${staged.questions.length} question(s)` : ""}.`,
);
console.log(`Runnable actions: ${runnableEdgesBefore.size} -> ${[...edgePlansAfter.values()].filter((p) => p.runnable).length}; approved cases newly runnable: ${casesPromoted.length}`);
for (const [id, plan] of promoted) console.log(`  + ${map.edges[id].semanticIntent} [${id}]  given: ${plan.given.map((g) => g.state.title).join(" → ") || "(nothing)"}`);
for (const c of casesPromoted) console.log(`  + case "${c.title}"`);
if (stillBlocked.length) {
  console.log("\nLinked but still blocked (fix the state or its flow, or ask the user):");
  for (const [id, plan] of stillBlocked) {
    console.log(`  ! ${map.edges[id].semanticIntent} [${id}]`);
    for (const b of plan.blockers) console.log(`      - ${b}`);
  }
}
