import { readFile } from "node:fs/promises";
import path from "node:path";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { fieldKind, suggestRows, variantsFor } from "../src/navmap-test-data.js";

// Prints rule-based input variants for a form action's fields (no AI) — inputs only; the expected
// outcome of each invalid value must be observed on the page, never guessed.
const [projectId, edgeId] = process.argv.slice(2);
if (!projectId || !edgeId || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error("Usage: npm run navmap:test-data -- <projectId> <edgeId>");
  process.exit(1);
}
const map = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(process.cwd(), projectPaths(projectId).navmap), "utf-8")));
const edge = map.edges[edgeId];
if (!edge?.formFields?.length) {
  console.error(`Action "${edgeId}" has no recorded form fields.`);
  process.exit(1);
}
console.log(
  JSON.stringify({
    edgeId,
    fields: edge.formFields.map((f) => ({ label: f.label, kind: fieldKind(f), variants: variantsFor(f) })),
    suggestedTable: suggestRows(edge.formFields),
    note: "Inputs only. Fill each row's expected outcome from what the page really shows — never guess it.",
  }),
);
