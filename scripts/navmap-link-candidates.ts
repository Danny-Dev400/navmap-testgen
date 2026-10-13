import { readFile } from "node:fs/promises";
import path from "node:path";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { chooseUserForPage, loadProjectUsers } from "../src/navmap-users.js";
import { indexLinks, linkKey, loadLinks } from "../src/navmap-links.js";
import { remainingPreconditions } from "../src/navmap-test-generator.js";

// Prints, as compact JSON, every (edge, precondition) pair that still needs a linking judgment,
// plus every recorded action as a candidate setup step — so the linker never has to read the raw map.
const projectId = process.argv[2];
const includeJudged = process.argv.includes("--all");
if (!projectId || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error("Usage: npm run navmap:link-candidates -- <projectId> [--all]");
  process.exit(1);
}

const rootDir = process.cwd();
const map = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(rootDir, projectPaths(projectId).navmap), "utf-8")));
const users = await loadProjectUsers(rootDir, map);
const links = await loadLinks(rootDir, map.id);
const linkIndex = indexLinks(links);

const pending = [];
for (const edge of Object.values(map.edges)) {
  if (edge.authFormLocators) continue;
  const page = map.pages[edge.fromPageId];
  const runner = page ? chooseUserForPage(page, users) : undefined;
  if (!runner) continue; // nobody can run this page's tests — linking wouldn't help
  for (const precondition of remainingPreconditions(edge, runner.kind === "auth")) {
    const existing = linkIndex.get(linkKey(edge.id, precondition));
    if (existing && !includeJudged) continue;
    pending.push({
      edgeId: edge.id,
      pageId: edge.fromPageId,
      semanticIntent: edge.semanticIntent,
      runner: { id: runner.id, kind: runner.kind },
      precondition,
      ...(existing ? { currentJudgment: { status: existing.status, scope: existing.scope, setupEdgeIds: existing.setupEdgeIds } } : {}),
    });
  }
}

const candidates = Object.values(map.edges).map((e) => ({
  id: e.id,
  pageId: e.fromPageId,
  semanticIntent: e.semanticIntent,
  intentCategory: e.intentCategory,
  action: e.action,
  target: e.target,
  navigatesTo: e.toPageId === e.fromPageId ? null : e.toPageId,
  uiRegion: e.uiRegion ?? null,
  preconditions: e.preconditions,
  postconditions: e.postconditions.map((p) => p.description),
}));

const pages = Object.values(map.pages).map((p) => ({ id: p.id, title: p.title, requiresAuth: p.requiresAuth === true }));

console.log(JSON.stringify({ projectId, existingLinks: links.length, pending, candidates, pages }, null, 2));
