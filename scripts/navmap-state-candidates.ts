import { readFile } from "node:fs/promises";
import path from "node:path";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { chooseUserForPage, loadProjectUsers } from "../src/navmap-users.js";
import { loadCases } from "../src/navmap-cases.js";
import { loadStateGraph } from "../src/navmap-states.js";
import { loadQuestions } from "../src/navmap-questions.js";
import { buildGraphView } from "../src/navmap-states-view.js";

// Prints, as compact JSON, what the state linker needs — so it never reads the raw map: every
// precondition not linked to a state yet, the existing states (to REUSE first), every recorded
// action as a candidate flow step, pages, users and the questions already open.
const projectId = process.argv[2];
if (!projectId || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error("Usage: npm run navmap:state-candidates -- <projectId>");
  process.exit(1);
}

const rootDir = process.cwd();
const map = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(rootDir, projectPaths(projectId).navmap), "utf-8")));
const users = await loadProjectUsers(rootDir, map);
const graph = await loadStateGraph(rootDir, projectId, map);
const view = buildGraphView(map, users, graph, await loadCases(rootDir, projectId), await loadQuestions(rootDir, projectId));

console.log(
  JSON.stringify({
    projectId,
    pending: view.unbound.map((u) => {
      const edge = map.edges[u.edgeId];
      const runner = chooseUserForPage(map.pages[edge.fromPageId], users)!;
      return { edgeId: u.edgeId, pageId: edge.fromPageId, intent: u.intent, precondition: u.precondition, actsOnListItem: !!edge.scope, runner: { id: runner.id, kind: runner.kind } };
    }),
    states: view.states.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      flow: s.flow.map((f) => ({ edgeId: f.edgeId, intent: f.intent, page: f.pageTitle })),
      ...(s.perItem ? { perItem: true } : {}),
      ...(s.userId ? { userId: s.userId } : {}),
      ...(s.requires.length ? { requires: s.requires.map((r) => r.id) } : {}),
      status: s.status,
      ...(s.cantRunOn.length ? { cantRunOn: s.cantRunOn.map((p) => p.pageId) } : {}),
      boundPreconditions: [...new Set(s.usedBy.actions.map((a) => a.precondition))],
      ...(s.note ? { note: s.note.slice(0, 300) } : {}),
    })),
    candidates: Object.values(map.edges).map((e) => ({
      id: e.id,
      pageId: e.fromPageId,
      intent: e.semanticIntent,
      category: e.intentCategory,
      action: e.action,
      navigatesTo: e.toPageId === e.fromPageId || e.external ? null : e.toPageId,
      ...(e.uiRegion ? { uiRegion: e.uiRegion } : {}),
      ...(e.scope ? { listItem: e.scope.hasText } : {}),
      ...(e.authFormLocators ? { isLogin: true } : {}),
      preconditions: e.preconditions,
      postconditions: e.postconditions.map((p) => p.description),
    })),
    pages: Object.values(map.pages).map((p) => ({ id: p.id, title: p.title, ...(p.requiresAuth ? { requiresAuth: true } : {}) })),
    users: users.map((u) => ({ id: u.id, label: u.label, kind: u.kind })),
    openQuestions: view.questions.map((q) => ({ title: q.title, stateId: q.stateId, issue: q.issue, askedBy: q.askedBy })),
    staleBindings: view.stale.length,
  }),
);
