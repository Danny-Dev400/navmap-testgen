import { readFile } from "node:fs/promises";
import path from "node:path";
import { NavigationMapSchema, type NavigationMap } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { loadCases } from "../src/navmap-cases.js";
import { isDestructive, loadEdgeFlags } from "../src/navmap-edge-flags.js";
import { computeJourneys } from "../src/navmap-journeys.js";
import { caseFeatureIndex, loadOrganization, loadProposal, sanitizeOrganization } from "../src/navmap-features.js";

// Prints, as compact JSON, everything the organizer agent needs to group test cases into features →
// use cases — so it never reads the raw map: pages, actions (no locators), end-to-end journeys,
// every case with what its steps do, the current organization (to keep) and what isn't organized yet.
const projectId = process.argv[2];
if (!projectId || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error("Usage: npm run navmap:organize-context -- <projectId>");
  process.exit(1);
}

const rootDir = process.cwd();
const map: NavigationMap = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(rootDir, projectPaths(projectId).navmap), "utf-8")));
const [cases, flags, org, proposal] = await Promise.all([
  loadCases(rootDir, projectId),
  loadEdgeFlags(rootDir, projectId),
  loadOrganization(rootDir, projectId),
  loadProposal(rootDir, projectId),
]);
const current = org ? sanitizeOrganization(org, map, cases).org : null;
const index = caseFeatureIndex(current);
const listedActions = new Set((current?.features ?? []).flatMap((f) => f.useCases.flatMap((u) => u.actions)));
const pageTitle = (id: string) => map.pages[id]?.title ?? id;

console.log(
  JSON.stringify({
    projectId,
    host: map.targetHost,
    entryPageId: map.entryPageId ?? null,
    pages: Object.values(map.pages).map((p) => ({
      id: p.id,
      title: p.title,
      ...(p.group ? { group: p.group } : {}),
      ...(p.requiresAuth ? { requiresAuth: true } : {}),
    })),
    actions: Object.values(map.edges).map((e) => ({
      id: e.id,
      page: e.fromPageId,
      ...(e.toPageId !== e.fromPageId ? { goesTo: e.toPageId } : {}),
      intent: e.semanticIntent,
      category: e.intentCategory,
      ...(e.uiRegion ? { uiRegion: e.uiRegion } : {}),
      ...(e.external ? { external: e.external.url } : {}),
      ...(e.authFormLocators ? { isLogin: true } : {}),
      ...(isDestructive(e, flags) ? { destructive: true } : {}),
    })),
    journeys: computeJourneys(map).map((j) => ({ pages: j.pages.map(pageTitle).join(" → "), actions: j.edges })),
    cases: cases.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      origin: c.origin,
      steps: c.steps.map((s) => map.edges[s.edgeId]?.semanticIntent ?? `(missing action ${s.edgeId})`),
      ...(c.requires.length ? { requires: c.requires } : {}),
      ...(c.dataset ? { dataRows: c.dataset.rows.length } : {}),
      ...(c.notes ? { notes: c.notes.split("\n")[0].slice(0, 200) } : {}),
    })),
    currentOrganization: current ? { features: current.features } : null,
    unsortedCases: cases.filter((c) => !index.has(c.id)).map((c) => c.id),
    unorganizedActions: current ? Object.keys(map.edges).filter((id) => !listedActions.has(id)) : Object.keys(map.edges),
    pendingProposal: proposal ? { createdAt: proposal.createdAt } : null,
  }),
);
