import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NavigationMapSchema, type NavigationMap } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { loadManualExport, manualExportFileName, MANUAL_FORMATS, renderManualExport, type ManualFormat, type ManualScope } from "../src/navmap-manual-cases.js";

// Writes a project's approved test cases as manual test cases — Markdown, or CSV for TestRail /
// Xray / Zephyr Scale — to projects/<id>/reports/ (or --out). Same content as the dashboard's
// Test cases › ⋯ › Export manual test cases. Reads the map and the cases only, never credentials.
const USAGE = "Usage: npm run export:manual -- <projectId> [--format markdown|testrail|xray|zephyr] [--feature <featureId> | --suite <suiteId> | --case <caseId>] [--out <file>]";

const [projectId, ...rest] = process.argv.slice(2);
if (!projectId || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error(USAGE);
  process.exit(1);
}
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const format = (flag("format") ?? "markdown") as ManualFormat;
if (!MANUAL_FORMATS.includes(format)) {
  console.error(`Unknown format "${format}". ${USAGE}`);
  process.exit(1);
}
const feature = flag("feature");
const caseId = flag("case");
const suite = flag("suite");
const scope: ManualScope = caseId ? { kind: "case", caseId } : suite ? { kind: "suite", suiteId: suite } : feature ? { kind: "feature", featureId: feature } : { kind: "project" };

const rootDir = process.cwd();
const map: NavigationMap = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(rootDir, projectPaths(projectId).navmap), "utf-8")));
const exp = await loadManualExport(rootDir, map, scope, { expandRows: format !== "markdown" });
if ("error" in exp) {
  console.error(exp.error);
  process.exit(1);
}
const outPath = flag("out") ?? path.join(projectPaths(projectId).reports, manualExportFileName(projectId, scope, format));
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, renderManualExport(exp, format), "utf-8");
console.log(`${exp.cases.length} manual test case${exp.cases.length === 1 ? "" : "s"} (${exp.scopeLabel}) written to ${outPath}`);
