import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { loadProjectUsers } from "../src/navmap-users.js";
import { LinksFileSchema, loadLinks, mergeLinks, saveLinks } from "../src/navmap-links.js";
import { planEdges } from "../src/navmap-test-generator.js";
import { statesFromLinks } from "../src/navmap-states.js";

// Validates a staged links file against the current map, merges it into
// projects/<projectId>/precondition-links.json, then dry-runs the real planner so the linker sees
// exactly which tests became runnable and which linked chains are still infeasible (and why).
const [projectId, stagedPath] = process.argv.slice(2);
if (!projectId || !stagedPath || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error("Usage: npm run navmap:save-links -- <projectId> <staged-links.json>");
  process.exit(1);
}

const rootDir = process.cwd();
// Projects with a state graph link preconditions to states instead (navmap:save-states); links
// written here would be ignored by the planner.
if (existsSync(path.join(rootDir, projectPaths(projectId).states))) {
  console.error(`Nothing saved — ${projectId} links preconditions to states now (projects/${projectId}/states.json). Use npm run navmap:state-candidates / navmap:save-states.`);
  process.exit(1);
}
const map = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(rootDir, projectPaths(projectId).navmap), "utf-8")));

const parsed = LinksFileSchema.safeParse(JSON.parse(await readFile(stagedPath, "utf-8")));
if (!parsed.success) {
  console.error("Staged links don't match the schema:\n" + parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}

const problems: string[] = [];
for (const link of parsed.data.links) {
  const edge = map.edges[link.edgeId];
  if (!edge) {
    problems.push(`${link.edgeId}: no such edge in the map`);
    continue;
  }
  if (!edge.preconditions.includes(link.precondition)) {
    problems.push(`${link.edgeId}: precondition must be copied verbatim from the edge — got "${link.precondition}"`);
  }
  for (const setupId of link.setupEdgeIds) {
    if (!map.edges[setupId]) problems.push(`${link.edgeId}: setup edge "${setupId}" doesn't exist`);
    if (setupId === link.edgeId) problems.push(`${link.edgeId}: an edge can't be its own setup`);
  }
  if (link.shareItem && (!edge.scope || !link.setupEdgeIds.some((id) => map.edges[id]?.scope))) {
    problems.push(`${link.edgeId}: shareItem needs both the action and a setup step to act on a list item (both with a scope)`);
  }
}
if (problems.length > 0) {
  console.error("Nothing saved — fix these and re-run:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

const users = await loadProjectUsers(rootDir, map);
const before = await loadLinks(rootDir, map.id);
const after = mergeLinks(before, parsed.data.links);

const runnableBefore = new Set([...planEdges(map, users, statesFromLinks(map, before))].filter(([, p]) => p.runnable).map(([id]) => id));
const plansAfter = planEdges(map, users, statesFromLinks(map, after));
await saveLinks(rootDir, map.id, after);

const promoted = [...plansAfter].filter(([id, p]) => p.runnable && !runnableBefore.has(id));
const stillBlocked = [...plansAfter].filter(([, p]) => !p.runnable && p.given.length > 0);
const counts = after.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.status]: (acc[l.status] ?? 0) + 1 }), {});

console.log(`Saved ${after.length} link(s) for ${map.id}: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ")}`);
console.log(`Runnable tests: ${runnableBefore.size} -> ${[...plansAfter.values()].filter((p) => p.runnable).length}`);
if (promoted.length > 0) {
  console.log("\nNewly runnable:");
  for (const [id, plan] of promoted) {
    console.log(`  + ${map.edges[id].semanticIntent} [${id}]  setup: ${plan.setup.map((s) => `${s.edge.semanticIntent} (${s.scope} @ ${s.location})`).join(" -> ")}`);
  }
}
if (stillBlocked.length > 0) {
  console.log("\nLinked but still blocked (fix these links, or mark them unresolvable):");
  for (const [id, plan] of stillBlocked) {
    console.log(`  ! ${map.edges[id].semanticIntent} [${id}]`);
    for (const b of plan.blockers) console.log(`      - ${b}`);
  }
}
