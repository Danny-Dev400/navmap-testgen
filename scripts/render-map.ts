import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ExplorationRunSchema, type ExplorationRun } from "../src/types.js";
import { inlineScreenshots } from "./screenshots.js";

const PLACEHOLDER = "__APP_DATA_JSON__";
const APP_DIST_INDEX = path.join("app", "dist", "index.html");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run report:map -- <path-to-results.json> [output.html]");
  process.exit(1);
}

let template: string;
try {
  template = await readFile(APP_DIST_INDEX, "utf-8");
} catch {
  console.error(`Could not read ${APP_DIST_INDEX}. Run \`npm run build:map\` first.`);
  process.exit(1);
}

const raw = await readFile(inputPath, "utf-8");
const run = ExplorationRunSchema.parse(JSON.parse(raw));

const screenshotDataUris = await inlineScreenshots(run);

const runWithInlinedScreenshots: ExplorationRun = {
  ...run,
  stepNodes: Object.fromEntries(
    Object.entries(run.stepNodes).map(([id, node]) => [
      id,
      { ...node, screenshot: node.screenshot ? screenshotDataUris.get(node.screenshot) : undefined },
    ]),
  ),
};

const jsonText = JSON.stringify({ kind: "explorationRun", run: runWithInlinedScreenshots }).replace(/<\/script/gi, "<\\/script");

if (!template.includes(PLACEHOLDER)) {
  console.error(`Could not find placeholder "${PLACEHOLDER}" in ${APP_DIST_INDEX}. Rebuild with \`npm run build:map\`.`);
  process.exit(1);
}
const html = template.replace(PLACEHOLDER, jsonText);

const outputPath = process.argv[3] ?? path.join("reports", `${run.id}-map.html`);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, "utf-8");

console.log(`Map report written to ${outputPath}`);
