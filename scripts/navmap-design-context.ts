import { readFile } from "node:fs/promises";
import path from "node:path";
import { NavigationMapSchema, type NavigationMap } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { loadProjectUsers } from "../src/navmap-users.js";
import { loadCases } from "../src/navmap-cases.js";
import { listPageSnapshots } from "../src/navmap-snapshots.js";
import { isDestructive, loadEdgeFlags } from "../src/navmap-edge-flags.js";
import { computeUiComponents } from "../src/navmapUiComponents.js";
import { caseFeatureIndex, findUseCase, loadOrganization, sanitizeOrganization } from "../src/navmap-features.js";
import { loadStateGraph } from "../src/navmap-states.js";
import { loadQuestions, projectKnowledge } from "../src/navmap-questions.js";
import { buildGraphView } from "../src/navmap-states-view.js";
import { loadRequirements } from "../src/navmap-requirements.js";

// Prints, as compact JSON, everything the test-design agent needs — so it never reads the raw map:
// pages (with their readable elements), actions (no locators: cases reference them by id), the
// route from the entry page to every page, users, existing cases (to avoid duplicates) and which
// pages have a saved snapshot. With --page, actions are limited to that page's neighborhood plus
// the routes to it, to keep the prompt small. With --use-case, actions are limited the same way
// around that use case's actions, and the use case itself is spelled out.
const args = process.argv.slice(2);
const projectId = args[0];
const pageFlag = args.indexOf("--page");
const focusPage = pageFlag >= 0 ? args[pageFlag + 1] : undefined;
const useCaseFlag = args.indexOf("--use-case");
const focusUseCaseId = useCaseFlag >= 0 ? args[useCaseFlag + 1] : undefined;
const requirementFlag = args.indexOf("--requirement");
const focusRequirementId = requirementFlag >= 0 ? args[requirementFlag + 1] : undefined;
if (!projectId || !/^[a-z0-9-]{1,80}$/.test(projectId) || (pageFlag >= 0 && !focusPage) || (useCaseFlag >= 0 && !focusUseCaseId) || (requirementFlag >= 0 && !focusRequirementId)) {
  console.error("Usage: npm run navmap:design-context -- <projectId> [--page <pageId>] [--use-case <useCaseId>] [--requirement <requirementId>]");
  process.exit(1);
}

const rootDir = process.cwd();
const map: NavigationMap = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(rootDir, projectPaths(projectId).navmap), "utf-8")));
if (focusPage && !map.pages[focusPage]) {
  console.error(`No page "${focusPage}" in project "${projectId}".`);
  process.exit(1);
}
const [users, cases, snapshots, flags, rawOrg] = await Promise.all([
  loadProjectUsers(rootDir, map),
  loadCases(rootDir, projectId),
  listPageSnapshots(rootDir, projectId),
  loadEdgeFlags(rootDir, projectId),
  loadOrganization(rootDir, projectId),
]);
const org = rawOrg ? sanitizeOrganization(rawOrg, map, cases).org : null;
const focusUseCase = focusUseCaseId && org ? findUseCase(org, focusUseCaseId) : undefined;
if (focusUseCaseId && !focusUseCase) {
  console.error(`No use case "${focusUseCaseId}" in project "${projectId}".`);
  process.exit(1);
}
const requirement = focusRequirementId ? (await loadRequirements(rootDir, projectId)).requirements.find((r) => r.id === focusRequirementId) : undefined;
if (focusRequirementId && !requirement) {
  console.error(`No requirement "${focusRequirementId}" in project "${projectId}".`);
  process.exit(1);
}
const caseUseCase = caseFeatureIndex(org);
const questions = await loadQuestions(rootDir, projectId);
const stateView = buildGraphView(map, users, await loadStateGraph(rootDir, projectId, map), cases, questions, flags);
const componentEdges = new Set([...computeUiComponents(map).values()].flatMap((c) => c.elements.flatMap((el) => el.memberEdges.map((e) => e.id))));

/** Shortest action path (edge ids) from the entry page to every page — how to reach a page in a case. */
function routes(): Record<string, string[]> {
  const start = map.entryPageId && map.pages[map.entryPageId] ? map.entryPageId : Object.keys(map.pages)[0];
  const out: Record<string, string[]> = { [start]: [] };
  const queue = [start];
  while (queue.length) {
    const from = queue.shift()!;
    for (const e of Object.values(map.edges)) {
      if (e.fromPageId !== from || e.external || out[e.toPageId]) continue;
      out[e.toPageId] = [...out[from], e.id];
      queue.push(e.toPageId);
    }
  }
  return out;
}
const allRoutes = routes();

let edgeIds = Object.keys(map.edges);
if (focusPage) {
  const near = new Set<string>([focusPage]);
  for (const e of Object.values(map.edges)) {
    if (e.fromPageId === focusPage) near.add(e.toPageId);
    if (e.toPageId === focusPage) near.add(e.fromPageId);
  }
  const onRoute = new Set(allRoutes[focusPage] ?? []);
  edgeIds = edgeIds.filter((id) => near.has(map.edges[id].fromPageId) || onRoute.has(id));
}
if (focusUseCase) {
  const own = new Set(focusUseCase.useCase.actions);
  const pages = new Set(focusUseCase.useCase.actions.flatMap((id) => [map.edges[id].fromPageId, map.edges[id].toPageId]));
  const onRoute = new Set([...pages].flatMap((p) => allRoutes[p] ?? []));
  edgeIds = edgeIds.filter((id) => own.has(id) || onRoute.has(id) || pages.has(map.edges[id].fromPageId));
}

const context = {
  project: projectId,
  entryPageId: map.entryPageId,
  focusPage: focusPage ?? null,
  // The use case the user asked cases for: save every draft with "useCase": <this id>.
  focusUseCase: focusUseCase
    ? { id: focusUseCase.useCase.id, feature: focusUseCase.feature.title, title: focusUseCase.useCase.title, description: focusUseCase.useCase.description ?? null, actions: focusUseCase.useCase.actions }
    : null,
  // The requirement the user asked cases for: design for its uncovered criteria and give each draft
  // "criteria": [<the ids it proves>] (and "useCase" when the requirement has one).
  focusRequirement: requirement
    ? {
        id: requirement.id,
        ...(requirement.key ? { key: requirement.key } : {}),
        title: requirement.title,
        story: requirement.text,
        useCase: requirement.useCaseId ?? null,
        uncovered: requirement.criteria.filter((c) => !c.caseIds.some((id) => cases.some((x) => x.id === id && x.status !== "rejected"))).map((c) => ({ id: c.id, text: c.text })),
        covered: requirement.criteria.filter((c) => c.caseIds.some((id) => cases.some((x) => x.id === id && x.status !== "rejected"))).map((c) => ({ id: c.id, text: c.text, cases: c.caseIds })),
      }
    : null,
  // How cases are organized (features → use cases): give each draft the use case it proves.
  useCases: (org?.features ?? []).flatMap((f) => f.useCases.map((u) => ({ id: u.id, feature: f.title, title: u.title, ...(u.description ? { description: u.description } : {}) }))),
  users: users.map((u) => ({ id: u.id, label: u.label, kind: u.kind, pages: u.allowedPageIds ?? "all its kind may access" })),
  pages: Object.values(map.pages).map((p) => ({
    id: p.id,
    title: p.title,
    url: p.sampleUrls[0],
    requiresAuth: !!p.requiresAuth,
    snapshot: p.id in snapshots,
    routeFromEntry: allRoutes[p.id] ?? null,
    elements: (p.elements ?? []).map((el) => ({ ref: `${p.id}#${el.id}`, label: el.label, valueKind: el.valueKind, perItem: el.scope?.hasText ?? null, source: el.source, sample: el.sample })),
  })),
  actions: edgeIds.map((id) => {
    const e = map.edges[id];
    return {
      id,
      from: e.fromPageId,
      to: e.toPageId,
      intent: e.semanticIntent,
      action: e.action,
      ...(e.scope ? { item: e.scope.hasText } : {}),
      ...(e.inputValue !== undefined ? { input: e.inputValue } : {}),
      ...(e.formFields?.length ? { form: e.formFields.map((f) => ({ label: f.label, value: f.value })) } : {}),
      ...(e.external ? { external: e.external.url } : {}),
      ...(e.authFormLocators ? { login: true } : {}),
      ...(componentEdges.has(id) ? { sharedComponent: true } : {}),
      ...(isDestructive(e, flags) ? { destructive: true } : {}),
      checks: e.postconditions.map((p) => ({ description: p.description, kind: p.check?.kind ?? null, ...(p.check?.value !== undefined ? { value: p.check.value } : {}) })),
      preconditions: e.preconditions,
    };
  }),
  // Named states with reusable flows: put a case in one with "given" instead of copying its steps.
  states: stateView.states.map((s) => ({
    id: s.id,
    title: s.title,
    kind: s.kind,
    ...(s.perItem ? { perItem: true } : {}),
    status: s.status,
    ...(s.flow.length ? { flow: s.flow.map((f) => f.intent).join(" → ") } : {}),
  })),
  // Questions already asked (don't ask again) and what the user answered in free text.
  openQuestions: stateView.questions.map((q) => q.title),
  knowledge: projectKnowledge(questions),
  cases: cases.map((c) => ({
    id: c.id,
    title: c.title,
    status: c.status,
    origin: c.origin,
    ...(c.given?.length ? { given: c.given } : {}),
    steps: c.steps.map((s) => s.edgeId),
    ...(caseUseCase.has(c.id) ? { useCase: caseUseCase.get(c.id)!.useCaseId } : {}),
  })),
};
console.log(JSON.stringify(context));
