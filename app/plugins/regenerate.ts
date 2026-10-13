import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateNavmapTestFiles } from "../../src/navmap-test-generator";
import { buildCoverageRun } from "../../src/navmap-coverage";
import { buildReportHtml } from "../../src/reportTemplate";
import { loadProjectUsers } from "../../src/navmap-users";
import { loadStateGraph } from "../../src/navmap-states";
import { loadEdgeFlags } from "../../src/navmap-edge-flags";
import { loadCases } from "../../src/navmap-cases";
import { loadOrganization } from "../../src/navmap-features";
import { loadSuites } from "../../src/navmap-suites";
import { loadRequirements } from "../../src/navmap-requirements";
import { abs, projectPaths } from "../../src/project-paths";
import { loadMap } from "./apiHelpers";
import { regenerationHeadline, summarizeRegeneration } from "./regenerationDiff";

export interface RegenerationResult {
  regeneration: ReturnType<typeof regenerationHeadline>;
  testCount: number;
  fixmeCount: number;
}

// projectId -> the last queued regeneration; each one waits for the previous, so two quick case
// edits can't interleave their file writes.
const queues = new Map<string, Promise<unknown>>();

/** Regenerates a project's code from its map + approved cases. Called after anything the code
 *  depends on changes (a case, an edge flag, a user, links, a new exploration) — generation is
 *  plain code, free and fast, so the code is never stale and there's no button to forget.
 *  The diff is only recorded when something actually changed, so "View changes" keeps showing the
 *  last real change. */
export function regenerateProject(repoRoot: string, projectId: string): Promise<RegenerationResult | null> {
  const next = (queues.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(() => run(repoRoot, projectId));
  queues.set(projectId, next);
  return next;
}

/** Fire-and-forget variant for hooks whose response doesn't depend on the result. */
export function regenerateInBackground(repoRoot: string, projectId: string, why: string): void {
  regenerateProject(repoRoot, projectId).catch((err) => console.error(`[regenerate] ${projectId} after ${why} failed:`, err));
}

async function run(repoRoot: string, projectId: string): Promise<RegenerationResult | null> {
  const map = await loadMap(repoRoot, projectId);
  if (!map) return null;
  const paths = projectPaths(projectId);

  const reportPath = abs(repoRoot, paths.coverageReport);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, buildReportHtml(buildCoverageRun(map)), "utf-8");

  const result = await generateNavmapTestFiles(
    map,
    await loadProjectUsers(repoRoot, map),
    await loadStateGraph(repoRoot, projectId, map),
    await loadCases(repoRoot, projectId),
    abs(repoRoot, paths.tests),
    paths.navmap,
    await loadEdgeFlags(repoRoot, projectId),
    await loadOrganization(repoRoot, projectId),
    await loadSuites(repoRoot, projectId),
    await loadRequirements(repoRoot, projectId),
  );
  const summary = summarizeRegeneration(result.changes);
  if (result.changes.length > 0) await writeFile(abs(repoRoot, paths.lastRegeneration), JSON.stringify(summary), "utf-8");
  return { regeneration: regenerationHeadline(summary), testCount: result.testCount, fixmeCount: result.fixmeCount };
}
