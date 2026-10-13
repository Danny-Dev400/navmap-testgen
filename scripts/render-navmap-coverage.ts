import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { projectPaths, resolveMapArg } from "../src/project-paths.js";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { buildCoverageRun } from "../src/navmap-coverage.js";
import { buildReportHtml } from "../src/reportTemplate.js";
import { inlineScreenshotsForPaths } from "./screenshots.js";

if (!process.argv[2]) {
  console.error("Usage: npm run report:navmap-coverage -- <project-id | path-to-navmap.json> [output.html]");
  process.exit(1);
}
const inputPath = resolveMapArg(process.argv[2]);

const raw = await readFile(inputPath, "utf-8");
const map = NavigationMapSchema.parse(JSON.parse(raw));

const run = buildCoverageRun(map);

const screenshotPaths = new Set<string>();
for (const node of Object.values(run.stepNodes)) {
  if (node.screenshot) screenshotPaths.add(node.screenshot);
}
const screenshotDataUris = await inlineScreenshotsForPaths(screenshotPaths);

const outputPath = process.argv[3] ?? projectPaths(map.id).coverageReport;
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, buildReportHtml(run, (p) => screenshotDataUris.get(p)), "utf-8");

console.log(`Coverage report written to ${outputPath}`);
console.log(`${run.workflows.length} pages, ${run.testPlans.length} test plans generated from ${inputPath}`);
