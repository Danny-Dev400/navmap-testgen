import { readFile } from "node:fs/promises";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { resolveMapArg } from "../src/project-paths.js";
import { baselineCase, loadCases, saveCase, uncoveredEdgeIds } from "../src/navmap-cases.js";

// Creates one baseline case per action no case references yet — drafts by default, approved with
// --approve (keeps a project's suite exactly as one-test-per-action generated it). Never touches
// existing cases, rejected ones included. Then run navmap:generate-tests.
const arg = process.argv[2];
if (!arg) {
  console.error("Usage: npm run navmap:cases:baseline -- <project-id | path-to-navmap.json> [--approve]");
  process.exit(1);
}
const approve = process.argv.includes("--approve");
const map = NavigationMapSchema.parse(JSON.parse(await readFile(resolveMapArg(arg), "utf-8")));
const cases = await loadCases(process.cwd(), map.id);
const edgeIds = uncoveredEdgeIds(map, cases);
const now = new Date().toISOString();
for (const id of edgeIds) await saveCase(process.cwd(), map.id, baselineCase(map.edges[id], approve ? "approved" : "draft", now));
console.log(`Created ${edgeIds.length} baseline case(s) as ${approve ? "approved" : "drafts"} (${cases.length} already existed).`);
