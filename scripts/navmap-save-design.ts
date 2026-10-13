import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { NavigationMapSchema, PageElementSchema, type NavigationMap } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { mergeElements } from "../src/navmap-merge.js";
import { ActionStepSchema, CASE_ID_RE, DatasetSchema, loadCases, newCaseId, saveCase, type TestCase } from "../src/navmap-cases.js";
import { buildGeneratedCode } from "../src/navmap-test-generator.js";
import { loadProjectUsers } from "../src/navmap-users.js";
import { loadStateGraph } from "../src/navmap-states.js";
import { loadEdgeFlags } from "../src/navmap-edge-flags.js";
import { assignCases, findUseCase, loadOrganization, ORG_ID_RE, saveOrganization } from "../src/navmap-features.js";
import { GivenSchema } from "../src/navmap-cases.js";
import { addQuestions, AskInputSchema, loadQuestions, saveQuestions } from "../src/navmap-questions.js";
import { CRITERION_ID_RE, loadRequirements, saveRequirements } from "../src/navmap-requirements.js";

// Validates and saves a test-design agent's staged output: new readable page elements (merged into
// the map — they're facts about pages) and draft test cases (origin "agent", rationale in notes).
// Dry-runs the real planner and generator first; saves NOTHING if any case would need review or
// can't be generated. Fixme cases (e.g. a precondition with no recorded setup) are saved and listed.
const DesignSchema = z.object({
  elements: z.record(z.string(), z.array(PageElementSchema)).default({}),
  cases: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        rationale: z.string().trim().min(1).max(2000),
        requires: z.array(z.string().regex(CASE_ID_RE)).default([]),
        steps: z.array(ActionStepSchema).min(1),
        dataset: DatasetSchema.optional(),
        /** The use case (features.json) this draft proves — it's filed there. */
        useCase: z.string().regex(ORG_ID_RE).optional(),
        /** States (states.json) to put the app in before the steps — their reusable flows run first. */
        given: z.array(GivenSchema).max(10).optional(),
        /** Acceptance criteria (of the design's "requirement") this draft proves — it's linked to them. */
        criteria: z.array(z.string().regex(CRITERION_ID_RE)).max(20).optional(),
      }),
    )
    .default([]),
  /** The requirement (requirements.json) the design was asked for — its cases may list "criteria". */
  requirement: z.string().regex(ORG_ID_RE).optional(),
  /** What the agent needs from the human instead of guessing (an account, data, how to reach a state). */
  questions: z.array(AskInputSchema).max(10).default([]),
});

const [projectId, file] = process.argv.slice(2);
const dryRun = process.argv.includes("--dry-run");
if (!projectId || !file || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error("Usage: npm run navmap:save-design -- <projectId> <staged-design.json> [--dry-run]");
  process.exit(1);
}

const rootDir = process.cwd();
const mapPath = path.join(rootDir, projectPaths(projectId).navmap);
const map: NavigationMap = NavigationMapSchema.parse(JSON.parse(await readFile(mapPath, "utf-8")));
const parsed = DesignSchema.safeParse(JSON.parse(await readFile(file, "utf-8")));
if (!parsed.success) {
  console.error(`Nothing saved — the staged design doesn't match the schema:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}
const design = parsed.data;
const errors: string[] = [];

// Elements -> a candidate map (not written until everything validates).
const nextMap: NavigationMap = structuredClone(map);
for (const [pageId, elements] of Object.entries(design.elements)) {
  const page = nextMap.pages[pageId];
  if (!page) {
    errors.push(`elements: no page "${pageId}" in the map`);
    continue;
  }
  const ids = elements.map((e) => e.id);
  if (new Set(ids).size !== ids.length) errors.push(`elements on "${pageId}": duplicate ids`);
  page.elements = mergeElements(page.elements, elements);
}

// Cases -> drafts with fresh ids.
const existing = await loadCases(rootDir, projectId);
const titles = new Set(existing.map((c) => c.title.toLowerCase()));
const ids = existing.map((c) => c.id);
const now = new Date().toISOString();
const created: TestCase[] = [];
const org = await loadOrganization(rootDir, projectId);
const graph = await loadStateGraph(rootDir, projectId, nextMap);
const stateIds = new Set(graph.states.map((s) => s.id));
for (const q of design.questions) if (q.about.kind === "state" && !stateIds.has(q.about.stateId)) errors.push(`question "${q.title}": no state "${q.about.stateId}" — ask a free question instead`);
const filing = new Map<string, string[]>(); // useCaseId -> new draft ids
const requirementsFile = design.requirement ? await loadRequirements(rootDir, projectId) : null;
const requirement = requirementsFile?.requirements.find((r) => r.id === design.requirement);
if (design.requirement && !requirement) errors.push(`no requirement "${design.requirement}" (see focusRequirement in the design context)`);
const linking = new Map<string, string[]>(); // criterionId -> new draft ids
for (const c of design.cases) {
  if (c.useCase && !(org && findUseCase(org, c.useCase))) errors.push(`case "${c.title}": no use case "${c.useCase}" (see useCases in the design context)`);
  if (titles.has(c.title.toLowerCase())) {
    errors.push(`case "${c.title}": a case with this title already exists`);
    continue;
  }
  titles.add(c.title.toLowerCase());
  for (const [i, s] of c.steps.entries()) if (!nextMap.edges[s.edgeId]) errors.push(`case "${c.title}" step ${i + 1}: no action "${s.edgeId}" in the map`);
  const id = newCaseId(c.title, ids);
  ids.push(id);
  if (c.useCase) filing.set(c.useCase, [...(filing.get(c.useCase) ?? []), id]);
  for (const cr of c.criteria ?? []) {
    if (!design.requirement) errors.push(`case "${c.title}": "criteria" needs the design's "requirement"`);
    else if (requirement && !requirement.criteria.some((x) => x.id === cr)) errors.push(`case "${c.title}": requirement "${design.requirement}" has no criterion "${cr}"`);
    else linking.set(cr, [...(linking.get(cr) ?? []), id]);
  }
  for (const g of c.given ?? []) if (!stateIds.has(g.state)) errors.push(`case "${c.title}": no state "${g.state}" (see states in the design context)`);
  created.push({ id, title: c.title, status: "draft", origin: "agent", ...(c.given?.length ? { given: c.given } : {}), requires: c.requires, steps: c.steps, ...(c.dataset ? { dataset: c.dataset } : {}), notes: c.rationale, createdAt: now, updatedAt: now });
}

// Dry run of the real planner + generator, as if the new drafts were approved.
const users = await loadProjectUsers(rootDir, nextMap);
const asApproved = [...existing, ...created.map((c) => ({ ...c, status: "approved" as const }))];
const code = errors.length ? undefined : buildGeneratedCode(nextMap, users, graph, asApproved, projectPaths(projectId).navmap, await loadEdgeFlags(rootDir, projectId));
const report: string[] = [];
for (const c of created) {
  const plan = code?.plans.get(c.id);
  if (!plan) continue;
  if (plan.health.health === "needs_review") errors.push(...plan.health.reasons.map((r) => `case "${c.title}": ${r}`));
  else if (code!.blocks.get(c.id)?.includes("Generator error")) errors.push(`case "${c.title}": the generator couldn't build it — ${code!.blocks.get(c.id)!.split("\n")[1]?.trim()}`);
  else report.push(plan.runnable ? `✓ "${c.title}" — runnable as ${plan.user?.label}` : `… "${c.title}" — would be fixme: ${plan.blockers.join(" | ")}`);
}

if (errors.length) {
  console.error(`Nothing saved — fix these and re-run:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  process.exit(1);
}
if (dryRun) {
  console.log(`Dry run OK (nothing saved):\n${report.join("\n")}`);
  process.exit(0);
}

const elementCount = Object.values(design.elements).reduce((n, els) => n + els.length, 0);
if (elementCount > 0) {
  nextMap.updatedAt = now;
  const tmp = `${mapPath}.tmp`;
  await writeFile(tmp, JSON.stringify(nextMap, null, 2), "utf-8");
  await rename(tmp, mapPath);
}
for (const c of created) await saveCase(rootDir, projectId, c);
if (design.questions.length) {
  const asked = addQuestions(await loadQuestions(rootDir, projectId), design.questions, "designer");
  await saveQuestions(rootDir, projectId, asked.questions);
  console.log(`Asked the user ${asked.added.length} question(s)${asked.skipped.length ? ` (skipped, already asked: ${asked.skipped.join("; ")})` : ""} — they answer in the 🧩 States tab.`);
}
if (requirementsFile && requirement && linking.size) {
  await saveRequirements(
    rootDir,
    projectId,
    requirementsFile.requirements.map((r) =>
      r.id === requirement.id ? { ...r, criteria: r.criteria.map((c) => ({ ...c, caseIds: [...c.caseIds, ...(linking.get(c.id) ?? [])] })), updatedAt: now } : r,
    ),
  );
  console.log(`Linked the drafts to ${linking.size} criteria of "${requirement.title}" — the Requirements tab shows them as drafts until approved.`);
}
if (org && filing.size) {
  let next = org;
  for (const [useCaseId, ids] of filing) next = assignCases(next, ids, useCaseId);
  await saveOrganization(rootDir, projectId, next);
}
console.log(`Saved ${elementCount} page element(s) into the map and ${created.length} draft case(s):\n${report.join("\n")}`);
console.log(`Draft ids: ${created.map((c) => c.id).join(", ") || "(none)"} — the user reviews and approves them in the Test cases tab.`);
