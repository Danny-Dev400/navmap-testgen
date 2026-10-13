import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { projectPaths, resolveMapArg } from "../src/project-paths.js";
import { NavigationMapSchema, type NavigationMap } from "../src/navmap-types.js";
import { inlineNavMapScreenshots } from "./screenshots.js";

const PLACEHOLDER = "__APP_DATA_JSON__";
const APP_DIST_INDEX = path.join("app", "dist", "index.html");

if (!process.argv[2]) {
  console.error("Usage: npm run report:navmap -- <project-id | path-to-navmap.json> [output.html]");
  process.exit(1);
}
const inputPath = resolveMapArg(process.argv[2]);

let template: string;
try {
  template = await readFile(APP_DIST_INDEX, "utf-8");
} catch {
  console.error(`Could not read ${APP_DIST_INDEX}. Run \`npm run build:map\` first.`);
  process.exit(1);
}

const raw = await readFile(inputPath, "utf-8");
const map = NavigationMapSchema.parse(JSON.parse(raw));

const screenshotDataUris = await inlineNavMapScreenshots(map);

const mapWithInlinedScreenshots: NavigationMap = {
  ...map,
  edges: Object.fromEntries(
    Object.entries(map.edges).map(([id, edge]) => [
      id,
      {
        ...edge,
        screenshot: edge.screenshot ? screenshotDataUris.get(edge.screenshot) : undefined,
        screenshotBefore: edge.screenshotBefore ? screenshotDataUris.get(edge.screenshotBefore) : undefined,
      },
    ]),
  ),
};

const jsonText = JSON.stringify({ kind: "navigationMap", map: mapWithInlinedScreenshots }).replace(/<\/script/gi, "<\\/script");

if (!template.includes(PLACEHOLDER)) {
  console.error(`Could not find placeholder "${PLACEHOLDER}" in ${APP_DIST_INDEX}. Rebuild with \`npm run build:map\`.`);
  process.exit(1);
}
const html = template.replace(PLACEHOLDER, jsonText);

const outputPath = process.argv[3] ?? projectPaths(map.id).navmapReport;
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, "utf-8");

console.log(`Navigation map report written to ${outputPath}`);
