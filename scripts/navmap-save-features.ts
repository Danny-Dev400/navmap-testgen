import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { NavigationMapSchema, type NavigationMap } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { loadCases } from "../src/navmap-cases.js";
import {
  assignIds,
  caseFeatureIndex,
  diffOrganization,
  loadOrganization,
  OrganizationInputSchema,
  sanitizeOrganization,
  saveProposal,
  validateOrganization,
} from "../src/navmap-features.js";

// Validates the organizer agent's staged organization (features → use cases → cases) and saves it
// as a PROPOSAL (features.proposed.json) for the user to accept or discard in the dashboard. Never
// writes the accepted organization itself. Saves nothing if anything is invalid.
const StagedSchema = OrganizationInputSchema.extend({ rationale: z.string().trim().max(4000).optional() });

const [projectId, file] = process.argv.slice(2);
if (!projectId || !file || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error("Usage: npm run navmap:save-features -- <projectId> <staged-organization.json>");
  process.exit(1);
}

const rootDir = process.cwd();
const map: NavigationMap = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(rootDir, projectPaths(projectId).navmap), "utf-8")));
const parsed = StagedSchema.safeParse(JSON.parse(await readFile(file, "utf-8")));
if (!parsed.success) {
  console.error(`Nothing saved — the staged organization doesn't match the schema:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

const cases = await loadCases(rootDir, projectId);
const organization = assignIds(parsed.data);
const errors = validateOrganization(organization, map, cases);
if (errors.length) {
  console.error(`Nothing saved — fix these and run again:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  process.exit(1);
}

const current = await loadOrganization(rootDir, projectId);
const diff = diffOrganization(current ? sanitizeOrganization(current, map, cases).org : null, organization);
if (current && diff.summary === "No changes") {
  console.log("No changes against the current organization — nothing to propose.");
  process.exit(0);
}

await saveProposal(rootDir, projectId, {
  organization: { ...organization, updatedAt: new Date().toISOString() },
  ...(parsed.data.rationale ? { rationale: parsed.data.rationale } : {}),
  createdAt: new Date().toISOString(),
});

const index = caseFeatureIndex(organization);
const unsorted = cases.filter((c) => c.status !== "rejected" && !index.has(c.id));
const listed = new Set(organization.features.flatMap((f) => f.useCases.flatMap((u) => u.actions)));
const unorganized = Object.keys(map.edges).filter((id) => !listed.has(id));
console.log(`Proposal saved for the user to review: ${diff.summary}`);
for (const f of organization.features) {
  console.log(`- ${f.title} [${f.id}]`);
  for (const u of f.useCases) console.log(`    - ${u.title} [${u.id}]: ${u.cases.length} case(s), ${u.actions.length} action(s)`);
}
if (unsorted.length) console.log(`Cases left unsorted (${unsorted.length}): ${unsorted.map((c) => c.id).join(", ")}`);
if (unorganized.length) console.log(`Actions in no use case (${unorganized.length}): ${unorganized.join(", ")}`);
if (diff.removedFeatures.length || diff.removedUseCases.length || diff.unsortedCases.length) {
  console.log(
    `Warning — this proposal REMOVES things the user has now: ${[
      ...diff.removedFeatures.map((f) => `feature "${f.title}"`),
      ...diff.removedUseCases.map((u) => `use case "${u.title}"`),
      ...(diff.unsortedCases.length ? [`${diff.unsortedCases.length} case assignment(s)`] : []),
    ].join(", ")}. Keep the existing organization unless the request asked to change it.`,
  );
}
