import { readFile } from "node:fs/promises";
import path from "node:path";
import { NavigationMapSchema, type NavigationMap } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { loadCases } from "../src/navmap-cases.js";
import { loadOrganization } from "../src/navmap-features.js";
import { loadRequirements } from "../src/navmap-requirements.js";
import { loadManualExport } from "../src/navmap-manual-cases.js";
import { loadStateGraph } from "../src/navmap-states.js";
import { loadQuestions, projectKnowledge } from "../src/navmap-questions.js";

// Prints, as compact JSON, everything the requirements analyst needs for one requirement — so it
// never reads the raw map or the case files: the requirement (story + current criteria + links),
// the use cases, every case as the steps a person would follow and what it checks (the manual-case
// wording — no locators, never credentials), pages, named states, and what the user already answered.
const [projectId, requirementId] = process.argv.slice(2);
if (!projectId || !/^[a-z0-9-]{1,80}$/.test(projectId) || !requirementId || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(requirementId)) {
  console.error("Usage: npm run navmap:requirements-context -- <projectId> <requirementId>");
  process.exit(1);
}

const rootDir = process.cwd();
const map: NavigationMap = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(rootDir, projectPaths(projectId).navmap), "utf-8")));
const [file, cases, org, graph, questions] = await Promise.all([
  loadRequirements(rootDir, projectId),
  loadCases(rootDir, projectId),
  loadOrganization(rootDir, projectId),
  loadStateGraph(rootDir, projectId, map),
  loadQuestions(rootDir, projectId),
]);
const requirement = file.requirements.find((r) => r.id === requirementId);
if (!requirement) {
  console.error(`No requirement "${requirementId}" in project "${projectId}".`);
  process.exit(1);
}

const live = cases.filter((c) => c.status !== "rejected");
const manual = live.length ? await loadManualExport(rootDir, map, { kind: "cases", caseIds: live.map((c) => c.id) }, { expandRows: false }) : { cases: [] };
if ("error" in manual) {
  console.error(manual.error);
  process.exit(1);
}

console.log(
  JSON.stringify({
    projectId,
    host: map.targetHost,
    requirement: {
      id: requirement.id,
      ...(requirement.key ? { key: requirement.key } : {}),
      title: requirement.title,
      story: requirement.text,
      ...(requirement.useCaseId ? { useCase: requirement.useCaseId } : {}),
      criteria: requirement.criteria.map((c) => ({ id: c.id, text: c.text, cases: c.caseIds })),
    },
    useCases: (org?.features ?? []).flatMap((f) => f.useCases.map((u) => ({ id: u.id, feature: f.title, title: u.title, ...(u.description ? { description: u.description } : {}) }))),
    // Each existing case: what a person would do and check. Link a criterion only to cases whose steps really prove it.
    cases: manual.cases.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      ...(c.useCase ? { useCase: c.useCase.id } : {}),
      ...(c.preconditions.length ? { preconditions: c.preconditions } : {}),
      steps: c.steps.map((s) => ({ do: s.action, ...(s.data.length ? { data: s.data } : {}), ...(s.expected.length ? { check: s.expected } : {}) })),
      ...(c.dataset ? { dataRows: c.dataset.rows.map((r) => r.name) } : {}),
    })),
    pages: Object.values(map.pages).map((p) => ({ id: p.id, title: p.title, url: p.urlPattern })),
    states: graph.states.map((s) => ({ id: s.id, title: s.title })),
    knowledge: projectKnowledge(questions),
  }),
);
