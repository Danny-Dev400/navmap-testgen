import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { abs, projectPaths } from "../../src/project-paths";
import { hintFor } from "../../src/navmap-triage-rules";
import {
  applyProposal,
  listTriageRecords,
  loadMapAndCases,
  saveTriageRecord,
  targetHash,
  writeApplied,
  type TriageRecord,
} from "../../src/navmap-triage";
import { planCases } from "../../src/navmap-test-generator";
import { loadProjectUsers } from "../../src/navmap-users";
import { loadStateGraph } from "../../src/navmap-states";
import { loadEdgeFlags } from "../../src/navmap-edge-flags";
import { baselineCaseId } from "../../src/navmap-cases";
import { regenerateProject } from "./regenerate";
import { runCaseAndWait, runningTestRun } from "./navmapRunsApi";

/** Per failed test of a run: its free rule-based hint and its triage verdict, if any. */
export async function triageOverview(repoRoot: string, projectId: string, runId: string) {
  const summary = JSON.parse(await readFile(abs(repoRoot, path.posix.join(projectPaths(projectId).runs, runId, "summary.json")), "utf-8"));
  const { map } = await loadMapAndCases(repoRoot, projectId);
  const records = new Map((await listTriageRecords(repoRoot, projectId, runId)).map((r) => [r.testIndex, r]));
  return {
    failures: (summary.tests as { title: string; status: string; error: string | null; caseId?: string | null; edgeId: string | null }[])
      .map((t, testIndex) => ({ t, testIndex }))
      .filter(({ t }) => t.status === "failed" || t.status === "flaky")
      .map(({ t, testIndex }) => ({
        testIndex,
        title: t.title,
        caseId: t.caseId ?? (t.edgeId ? baselineCaseId(t.edgeId) : null),
        hint: hintFor(t.error, map),
        record: records.get(testIndex) ?? null,
      })),
  };
}

function targetFile(projectId: string, r: TriageRecord): string {
  return r.proposal!.target === "case"
    ? path.posix.join(projectPaths(projectId).cases, `${r.proposal!.caseId}.json`)
    : projectPaths(projectId).navmap;
}

/** Applies the proposal temporarily, runs only that case (no AI, no quota), then ALWAYS restores
 *  the original file and regenerates — the outcome is recorded on the verdict. Destructive cases
 *  are skipped unless allowed. */
export async function verifyTriageRecord(repoRoot: string, projectId: string, record: TriageRecord, allowDestructive: boolean, log: (line: string) => void): Promise<TriageRecord> {
  const at = () => new Date().toISOString();
  const done = async (verification: NonNullable<TriageRecord["verification"]>) => {
    const updated = { ...record, verification };
    await saveTriageRecord(repoRoot, projectId, updated);
    return updated;
  };
  if (!record.proposal || record.status !== "proposed") return record;

  const { map, cases } = await loadMapAndCases(repoRoot, projectId);
  if (targetHash(record.proposal, map, cases) !== record.targetHash) {
    return done({ result: "skipped", reason: "the map or case changed since the proposal", at: at() });
  }
  const users = await loadProjectUsers(repoRoot, map);
  const flags = await loadEdgeFlags(repoRoot, projectId);
  const plan = planCases(map, users, await loadStateGraph(repoRoot, projectId, map), cases, flags).get(record.caseId);
  if (plan?.destructive && !allowDestructive) return done({ result: "skipped", reason: "destructive case — verify it by hand, or allow destructive verification", at: at() });
  if (runningTestRun(projectId)) return done({ result: "skipped", reason: "a test run was in progress", at: at() });

  const file = abs(repoRoot, targetFile(projectId, record));
  const original = await readFile(file, "utf-8");
  // A draft case has no generated test: approve it for the verification run only.
  const caseFile = abs(repoRoot, path.posix.join(projectPaths(projectId).cases, `${record.caseId}.json`));
  const originalCase = caseFile !== file ? await readFile(caseFile, "utf-8").catch(() => null) : null;
  log(`Verifying the fix for "${record.title}" — running it once with the fix applied…`);
  try {
    const applied = applyProposal(record.proposal, map, cases);
    applied.cases = applied.cases.map((c) => (c.id === record.caseId ? { ...c, status: "approved" as const } : c));
    await writeApplied(repoRoot, projectId, record.proposal, applied);
    if (record.proposal.target !== "case") await writeApplied(repoRoot, projectId, { target: "case", caseId: record.caseId, steps: applied.cases.find((c) => c.id === record.caseId)!.steps }, applied);
    await regenerateProject(repoRoot, projectId);
    const summary = await runCaseAndWait(repoRoot, projectId, record.caseId);
    if (!summary) return await done({ result: "skipped", reason: "the verification run couldn't start", at: at() });
    const failed = summary.tests.filter((t) => t.status === "failed");
    const passed = summary.tests.length > 0 && failed.length === 0 && summary.tests.some((t) => t.status === "passed" || t.status === "flaky");
    log(passed ? `✓ "${record.title}" passed with the fix.` : `✗ "${record.title}" still fails with the fix.`);
    return await done({
      result: passed ? "passed" : "failed",
      runId: summary.runId,
      ...(passed ? {} : { reason: (failed[0]?.error ?? "no test ran").split("\n")[0].slice(0, 300) }),
      at: at(),
    });
  } finally {
    await writeFile(file, original, "utf-8");
    if (originalCase !== null) await writeFile(caseFile, originalCase, "utf-8");
    await regenerateProject(repoRoot, projectId);
  }
}

/** The user's approval: re-checks nothing changed since the proposal, applies it for good (a map
 *  fix records lastRepair), regenerates. */
export async function applyTriageRecord(repoRoot: string, projectId: string, record: TriageRecord): Promise<{ ok: true; record: TriageRecord } | { ok: false; error: string }> {
  if (record.status !== "proposed" || !record.proposal) return { ok: false, error: "Nothing to apply" };
  const { map, cases } = await loadMapAndCases(repoRoot, projectId);
  if (targetHash(record.proposal, map, cases) !== record.targetHash) {
    return { ok: false, error: "The map or the case changed since this fix was proposed — triage it again" };
  }
  const now = new Date().toISOString();
  const applied = applyProposal(record.proposal, map, cases, { at: now, runId: record.runId, reason: record.explanation.slice(0, 300) });
  await writeApplied(repoRoot, projectId, record.proposal, applied);
  await regenerateProject(repoRoot, projectId);
  const updated: TriageRecord = { ...record, status: "applied", decidedAt: now };
  await saveTriageRecord(repoRoot, projectId, updated);
  return { ok: true, record: updated };
}
