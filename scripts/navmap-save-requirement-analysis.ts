import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { loadCases } from "../src/navmap-cases.js";
import { findUseCase, loadOrganization } from "../src/navmap-features.js";
import { AnalysisSchema, loadAnalyses, loadRequirements, saveAnalyses } from "../src/navmap-requirements.js";

// Validates the analyst's staged proposal for one requirement and saves it as pending
// (projects/<id>/requirements.proposed.json) — it never touches requirements.json: the user accepts
// or discards it in the Requirements tab. Nothing is saved when anything is invalid; the errors say why.
const StagedSchema = AnalysisSchema.omit({ createdAt: true });

const [projectId, stagedPath] = process.argv.slice(2);
if (!projectId || !/^[a-z0-9-]{1,80}$/.test(projectId) || !stagedPath) {
  console.error("Usage: npm run navmap:save-requirement-analysis -- <projectId> projects/<projectId>/.staging/requirements-<runId>.json");
  process.exit(1);
}
const rootDir = process.cwd();
const staging = path.resolve(rootDir, "projects", projectId, ".staging");
if (!path.resolve(rootDir, stagedPath).startsWith(staging + path.sep)) {
  console.error(`The staged file must be under projects/${projectId}/.staging/`);
  process.exit(1);
}

let staged: z.infer<typeof StagedSchema>;
try {
  staged = StagedSchema.parse(JSON.parse(await readFile(path.resolve(rootDir, stagedPath), "utf-8")));
} catch (err) {
  console.error(`Invalid proposal: ${err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message}`);
  process.exit(1);
}

const [file, cases, org] = await Promise.all([loadRequirements(rootDir, projectId), loadCases(rootDir, projectId), loadOrganization(rootDir, projectId)]);
const requirement = file.requirements.find((r) => r.id === staged.requirementId);
const errors: string[] = [];
if (!requirement) errors.push(`No requirement "${staged.requirementId}"`);
const caseIds = new Set(cases.filter((c) => c.status !== "rejected").map((c) => c.id));
staged.criteria.forEach((c, i) => {
  if (c.id && requirement && !requirement.criteria.some((x) => x.id === c.id)) errors.push(`criterion ${i + 1}: no existing criterion "${c.id}" — leave "id" out for a new one`);
  for (const id of c.caseIds) if (!caseIds.has(id)) errors.push(`criterion ${i + 1} ("${c.text.slice(0, 40)}"): no case "${id}"`);
});
const ids = staged.criteria.flatMap((c) => (c.id ? [c.id] : []));
if (new Set(ids).size !== ids.length) errors.push("Each existing criterion may appear once");
if (staged.useCaseId && (!org || !findUseCase(org, staged.useCaseId))) errors.push(`No use case "${staged.useCaseId}"`);
if (errors.length) {
  console.error(`Not saved:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

const others = (await loadAnalyses(rootDir, projectId)).filter((a) => a.requirementId !== staged.requirementId);
await saveAnalyses(rootDir, projectId, [...others, { ...staged, createdAt: new Date().toISOString() }]);
const linked = staged.criteria.filter((c) => c.caseIds.length).length;
console.log(
  `Saved the analysis of "${requirement!.title}" for review: ${staged.criteria.length} criteria, ${linked} linked to existing cases, ${staged.criteria.length - linked} uncovered. The user accepts or discards it in the Requirements tab.`,
);
