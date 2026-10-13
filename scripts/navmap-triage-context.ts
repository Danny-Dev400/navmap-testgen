import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { abs, projectPaths } from "../src/project-paths.js";
import { loadMapAndCases } from "../src/navmap-triage.js";
import { hintFor } from "../src/navmap-triage-rules.js";
import { normalizeSnapshot } from "../src/navmap-snapshots.js";
import { projectSecrets, scrub } from "../src/navmap-secrets.js";
import { buildGeneratedCode } from "../src/navmap-test-generator.js";
import { loadOrganization } from "../src/navmap-features.js";
import { loadProjectUsers } from "../src/navmap-users.js";
import { loadStateGraph } from "../src/navmap-states.js";
import { loadEdgeFlags } from "../src/navmap-edge-flags.js";
import { baselineCaseId, pageAfterStep, requiredSteps, resolveElement } from "../src/navmap-cases.js";

// Prints, as JSON, everything the triage agent needs about ONE failed test: the error, the free
// rule-based hint, the generated test, the case's steps with the map facts they rely on (locators
// included — fixing them is the point), and the page's aria snapshot at the moment of failure.
// Credentials are scrubbed from everything printed.
const [projectId, runId, indexArg] = process.argv.slice(2);
const testIndex = Number(indexArg);
if (!projectId || !/^[a-z0-9-]{1,80}$/.test(projectId) || !/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/.test(runId ?? "") || !Number.isInteger(testIndex) || testIndex < 0) {
  console.error("Usage: npm run navmap:triage-context -- <projectId> <runId> <testIndex>");
  process.exit(1);
}

const rootDir = process.cwd();
const runDir = abs(rootDir, path.posix.join(projectPaths(projectId).runs, runId));
const summary = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf-8"));
const test = summary.tests[testIndex];
if (!test) {
  console.error(`Run ${runId} has no test #${testIndex}.`);
  process.exit(1);
}
const { map, cases } = await loadMapAndCases(rootDir, projectId);
const secrets = await projectSecrets(rootDir, map);
const caseId: string | null = test.caseId ?? (test.edgeId ? baselineCaseId(test.edgeId) : null);
const testCase = cases.find((c) => c.id === caseId);

/** error-context.md: the error plus the page snapshot when it failed. Older runs didn't record
 *  its path — find it by the test title. */
async function errorContext(): Promise<{ error: string | null; pageSnapshot: string | null }> {
  let file = test.artifacts?.errorContext ? abs(rootDir, test.artifacts.errorContext) : undefined;
  if (!file) {
    const artifacts = path.join(runDir, "artifacts");
    for (const dir of await readdir(artifacts).catch(() => [] as string[])) {
      const candidate = path.join(artifacts, dir, "error-context.md");
      const text = await readFile(candidate, "utf-8").catch(() => "");
      if (text.includes(`>> ${test.title}\n`) || text.includes(`>> ${test.title}\r\n`)) {
        file = candidate;
        break;
      }
    }
  }
  if (!file) return { error: null, pageSnapshot: null };
  const raw = scrub(await readFile(file, "utf-8").catch(() => ""), secrets);
  const yaml = /# Page snapshot\s*```yaml\r?\n([\s\S]*?)```/.exec(raw)?.[1] ?? /```yaml\r?\n([\s\S]*?)```/.exec(raw)?.[1] ?? null;
  const details = /# Error details\s*([\s\S]*?)(?:# Page snapshot|```yaml)/.exec(raw)?.[1]?.trim() ?? null;
  return { error: details, pageSnapshot: yaml ? normalizeSnapshot(yaml) : null };
}

const facts = (() => {
  if (!testCase) return null;
  const ordered = [...requiredSteps(testCase, new Map(cases.map((c) => [c.id, c]))).map((r) => r.step), ...testCase.steps];
  return ordered.map((step, i) => {
    const e = map.edges[step.edgeId];
    if (!e) return { index: i + 1, edgeId: step.edgeId, missing: true };
    const elements = [...(step.capture ?? []), ...(step.verify ?? [])].map((v) => {
      const found = resolveElement(map, v.element);
      return found ? { ref: v.element, label: found.element.label, locator: found.element.locator, scope: found.element.scope } : { ref: v.element, missing: true };
    });
    return {
      index: i + 1,
      step,
      action: {
        id: e.id,
        from: e.fromPageId,
        to: e.toPageId,
        leavesOn: pageAfterStep(step, e),
        intent: e.semanticIntent,
        action: e.action,
        locator: e.locator,
        ...(e.scope ? { scope: e.scope } : {}),
        ...(e.external ? { external: e.external } : {}),
        ...(e.formFields?.length ? { formFields: e.formFields.map((f) => ({ label: f.label, locator: f.locator, value: f.value })) } : {}),
        ...(e.authFormLocators ? { login: true } : {}),
        postconditions: e.postconditions,
        ...(e.lastRepair ? { lastRepair: e.lastRepair } : {}),
      },
      ...(elements.length ? { elements } : {}),
    };
  });
})();

const code = testCase
  ? buildGeneratedCode(
      map,
      await loadProjectUsers(rootDir, map),
      await loadStateGraph(rootDir, projectId, map),
      cases,
      projectPaths(projectId).navmap,
      await loadEdgeFlags(rootDir, projectId),
      await loadOrganization(rootDir, projectId),
    )
  : undefined;
const ctx = await errorContext();
const visited = facts ? [...new Set(facts.flatMap((f) => ("action" in f && f.action ? [f.action.from, f.action.leavesOn] : [])))] : [];

console.log(
  JSON.stringify({
    project: projectId,
    runId,
    testIndex,
    test: { title: test.title, caseId, browser: test.browser, status: test.status, durationMs: test.durationMs, failedStep: test.failedStep ?? null, row: test.row ?? null },
    error: scrub(ctx.error ?? test.error ?? "", secrets),
    hint: hintFor(test.error, map),
    case: testCase ? { id: testCase.id, title: testCase.title, status: testCase.status, origin: testCase.origin, requires: testCase.requires } : null,
    generatedTest: testCase ? (code?.blocks.get(testCase.id) ?? null) : null,
    steps: facts,
    pageSnapshotAtFailure: ctx.pageSnapshot,
    pagesVisited: visited.map((id) => ({ id, title: map.pages[id]?.title, url: map.pages[id]?.sampleUrls[0], urlPattern: map.pages[id]?.urlPattern })),
    note: "Saved snapshots of these pages (from exploration): npm run navmap:snapshot -- <projectId> <pageId>",
  }),
);
