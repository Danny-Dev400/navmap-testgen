import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ExplorationRunSchema } from "../src/types.js";
import { buildReportHtml } from "../src/reportTemplate.js";
import { inlineScreenshots } from "./screenshots.js";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run report -- <path-to-results.json> [output.html]");
  process.exit(1);
}

const raw = await readFile(inputPath, "utf-8");
const run = ExplorationRunSchema.parse(JSON.parse(raw));

const screenshotDataUris = await inlineScreenshots(run);

const outputPath = process.argv[3] ?? path.join("reports", `${run.id}.html`);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, buildReportHtml(run, (p) => screenshotDataUris.get(p)), "utf-8");

console.log(`Report written to ${outputPath}`);
