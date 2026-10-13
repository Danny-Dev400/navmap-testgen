import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { NavMapRunBatchSchema, NavigationMapSchema } from "../src/navmap-types.js";
import { mergeNavigationMap } from "../src/navmap-merge.js";
import { slugify } from "../src/navmap-ids.js";
import { projectPaths } from "../src/project-paths.js";

const batchPath = process.argv[2];
if (!batchPath) {
  console.error("Usage: npm run navmap:merge -- <path-to-staged-batch.json>");
  process.exit(1);
}

const rawBatch = await readFile(batchPath, "utf-8");
const batch = NavMapRunBatchSchema.parse(JSON.parse(rawBatch));

const targetHost = new URL(batch.targetUrl).hostname.toLowerCase();
const hostSlug = slugify(targetHost);
const mapPath = projectPaths(hostSlug).navmap;

let existing = null;
try {
  const rawMap = await readFile(mapPath, "utf-8");
  existing = NavigationMapSchema.parse(JSON.parse(rawMap));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
    console.error(`${mapPath} exists but failed to validate — refusing to overwrite it.`);
    throw err;
  }
}

const pagesBefore = existing ? Object.keys(existing.pages).length : 0;
const edgesBefore = existing ? Object.keys(existing.edges).length : 0;

const merged = mergeNavigationMap(existing, batch, hostSlug, targetHost);

await mkdir(path.dirname(mapPath), { recursive: true });
const tmpPath = `${mapPath}.tmp`;
await writeFile(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
await rename(tmpPath, mapPath);

const pagesAfter = Object.keys(merged.pages).length;
const edgesAfter = Object.keys(merged.edges).length;

console.log(`Merged into ${mapPath}`);
console.log(`Pages: ${pagesBefore} -> ${pagesAfter} (+${pagesAfter - pagesBefore} new, ${batch.pages.length} touched this run)`);
console.log(`Edges: ${edgesBefore} -> ${edgesAfter} (+${edgesAfter - edgesBefore} new, ${batch.edges.length} touched this run)`);
