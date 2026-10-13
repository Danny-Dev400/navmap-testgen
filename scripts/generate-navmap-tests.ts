import { readFile } from "node:fs/promises";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { generateNavmapTestFiles } from "../src/navmap-test-generator.js";
import { loadProjectUsers } from "../src/navmap-users.js";
import { loadStateGraph } from "../src/navmap-states.js";
import { projectPaths, resolveMapArg } from "../src/project-paths.js";
import { loadEdgeFlags } from "../src/navmap-edge-flags.js";
import { loadCases } from "../src/navmap-cases.js";
import { loadOrganization } from "../src/navmap-features.js";
import { loadSuites } from "../src/navmap-suites.js";
import { loadRequirements } from "../src/navmap-requirements.js";

if (!process.argv[2]) {
  console.error("Usage: npm run navmap:generate-tests -- <project-id | path-to-navmap.json> [output-dir]");
  process.exit(1);
}
const inputPath = resolveMapArg(process.argv[2]);

const map = NavigationMapSchema.parse(JSON.parse(await readFile(inputPath, "utf-8")));
const users = await loadProjectUsers(process.cwd(), map);
const graph = await loadStateGraph(process.cwd(), map.id, map);
const cases = await loadCases(process.cwd(), map.id);
const outputDir = process.argv[3] ?? projectPaths(map.id).tests;

const flags = await loadEdgeFlags(process.cwd(), map.id);
const { fileCount, testCount, fixmeCount, authDependentCount } = await generateNavmapTestFiles(
  map,
  users,
  graph,
  cases,
  outputDir,
  inputPath,
  flags,
  await loadOrganization(process.cwd(), map.id),
  await loadSuites(process.cwd(), map.id),
  await loadRequirements(process.cwd(), map.id),
);

const approved = cases.filter((c) => c.status === "approved").length;
console.log(`Generated ${fileCount} spec file(s) in ${outputDir} for ${users.length} user(s): ${users.map((u) => u.id).join(", ")}`);
console.log(`${approved} approved case(s) of ${cases.length}: ${testCount} runnable test(s), ${fixmeCount} fixme stub(s) — using ${graph.states.length} state(s)${graph.derivedFromLinks ? " converted from precondition links" : ""}`);
if (cases.length === 0) {
  console.log(`No test cases yet — create them in the Cases tab or with \`npm run navmap:cases:baseline -- ${map.id} [--approve]\`.`);
}
if (authDependentCount > 0) {
  console.log(`${authDependentCount} of those run as an authenticated user — set up sessions with \`npm run navmap:auth-setup -- ${map.id}\` (or the Users tab).`);
}
