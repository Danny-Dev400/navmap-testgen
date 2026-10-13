import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { abs, projectPaths } from "../src/project-paths.js";
import { applyProposal, loadMapAndCases, saveTriageRecord, targetHash, triageRecordId, VerdictSchema, type TriageRecord } from "../src/navmap-triage.js";
import { buildGeneratedCode } from "../src/navmap-test-generator.js";
import { loadProjectUsers } from "../src/navmap-users.js";
import { loadStateGraph } from "../src/navmap-states.js";
import { loadEdgeFlags } from "../src/navmap-edge-flags.js";

// Validates and stores the triage agent's verdicts (one or many, from a staged JSON array). A
// proposal is applied to in-memory copies only, to prove it's valid: its case must stay healthy and
// generate without errors. Proposals on app bugs / environment problems are refused (those are
// reports). Nothing is ever applied here — the dashboard verifies by re-running, the user approves.
const [projectId, file] = process.argv.slice(2);
if (!projectId || !file || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error("Usage: npm run navmap:save-triage -- <projectId> <staged-verdicts.json>");
  process.exit(1);
}

const rootDir = process.cwd();
const raw = JSON.parse(await readFile(file, "utf-8"));
const parsed = z.array(VerdictSchema).safeParse(Array.isArray(raw) ? raw : [raw]);
if (!parsed.success) {
  console.error(`Nothing saved — the staged verdicts don't match the schema:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

const { map, cases } = await loadMapAndCases(rootDir, projectId);
const users = await loadProjectUsers(rootDir, map);
const graph = await loadStateGraph(rootDir, projectId, map);
const flags = await loadEdgeFlags(rootDir, projectId);
const errors: string[] = [];
const records: TriageRecord[] = [];

for (const v of parsed.data) {
  const label = `run ${v.runId} test #${v.testIndex}`;
  let summary: { tests: { title: string; status: string }[] };
  try {
    summary = JSON.parse(await readFile(abs(rootDir, path.posix.join(projectPaths(projectId).runs, v.runId, "summary.json")), "utf-8"));
  } catch {
    errors.push(`${label}: no such run`);
    continue;
  }
  const test = summary.tests[v.testIndex];
  if (!test) {
    errors.push(`${label}: no such test in that run`);
    continue;
  }
  if (!cases.some((c) => c.id === v.caseId)) errors.push(`${label}: no case "${v.caseId}"`);
  const record: TriageRecord = {
    ...v,
    id: triageRecordId(v.runId, v.testIndex),
    title: test.title,
    status: v.proposal ? "proposed" : "report",
    createdAt: new Date().toISOString(),
  };

  if (v.proposal) {
    if (v.classification !== "test_bug") {
      errors.push(`${label}: only a test bug gets a fix proposal — an ${v.classification.replace("_", " ")} is a report`);
      continue;
    }
    if (v.proposal.target === "case" && v.proposal.caseId !== v.caseId) errors.push(`${label}: a case fix must target the failing case "${v.caseId}"`);
    try {
      const applied = applyProposal(v.proposal, map, cases);
      const code = buildGeneratedCode(applied.map, users, graph, applied.cases.map((c) => (c.id === v.caseId ? { ...c, status: "approved" as const } : c)), projectPaths(projectId).navmap, flags);
      const plan = code.plans.get(v.caseId);
      if (plan?.health.health === "needs_review") errors.push(...plan.health.reasons.map((r) => `${label}: with the fix, the case would need review — ${r}`));
      else if (code.blocks.get(v.caseId)?.includes("Generator error")) errors.push(`${label}: with the fix, the test can't be generated`);
      record.before = applied.before;
      record.after = applied.after;
      record.targetHash = targetHash(v.proposal, map, cases);
    } catch (err) {
      errors.push(`${label}: ${(err as Error).message}`);
    }
  }
  records.push(record);
}

if (errors.length) {
  console.error(`Nothing saved — fix these and re-run:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  process.exit(1);
}
for (const r of records) await saveTriageRecord(rootDir, projectId, r);
for (const r of records) {
  console.log(`${r.status === "proposed" ? "🔧" : "📝"} ${r.title} — ${r.classification}${r.subtype ? ` (${r.subtype})` : ""}${r.proposal ? ` · proposes a ${r.proposal.target} fix` : ""}`);
}
console.log(`Saved ${records.length} verdict(s). Proposals are verified by re-running and approved by the user in the Runs tab — never applied here.`);
