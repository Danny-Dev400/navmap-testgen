import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { z } from "zod/v4";
import { projectSecrets, scrub } from "../../src/navmap-secrets";
import { abs, PROJECTS_DIR, projectPaths } from "../../src/project-paths";
import { loadMap, pathExists, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";
import { killTree, runningJobForProject } from "./agentJobs";
import { locateTests } from "./generatedCode";
import { baselineCaseId, CASE_ID_RE, loadCases, type TestCase } from "../../src/navmap-cases";
import { findUseCase, loadOrganization, ORG_ID_RE } from "../../src/navmap-features";
import { loadSuites } from "../../src/navmap-suites";

// /api/projects/<id>/runs[/latest-status | /<runId>[/cancel | /trace]] — everything else falls through.
const RUNS_RE = /^\/([a-z0-9-]{1,80})\/runs(?:\/(latest-status|[0-9]{8}-[0-9]{6}-[a-z0-9]{4})(?:\/(cancel|trace))?)?\/?$/;
const MAX_RUNS_KEPT = 20;
const MAX_LOG_LINES = 400;

const StartBody = z.object({
  scope: z.enum(["project", "page", "case", "feature", "useCase", "cases", "suite"]),
  pageId: z.string().regex(/^[a-z0-9_-]{1,200}$/).optional(),
  caseId: z.string().regex(CASE_ID_RE).optional(),
  featureId: z.string().regex(ORG_ID_RE).optional(),
  useCaseId: z.string().regex(ORG_ID_RE).optional(),
  /** scope "cases": a hand-picked selection. */
  caseIds: z.array(z.string().regex(CASE_ID_RE)).min(1).max(500).optional(),
  suiteId: z.string().regex(ORG_ID_RE).optional(),
  includeDestructive: z.boolean().default(false),
});

export type TestStatus = "passed" | "failed" | "flaky" | "skipped" | "fixme";

export interface RunTest {
  /** null only in runs stored before test cases existed — use caseIdOf(). */
  caseId?: string | null;
  /** The case's last step's action (what the map heatmap colors). */
  edgeId: string | null;
  /** The data row, for a case with a data table (one test per row). */
  row?: string | null;
  /** Title of the test.step() that failed (the deepest one with an error), when the test has steps. */
  failedStep?: string | null;
  title: string;
  file: string;
  line: number;
  browser: string;
  status: TestStatus;
  durationMs: number;
  error: string | null;
  /** errorContext: Playwright's error-context.md (error + the page's aria snapshot at failure), scrubbed. */
  artifacts: { trace: string | null; video: string | null; screenshots: string[]; errorContext?: string | null };
}

/** A test's case — runs stored before cases existed only know the action, whose baseline case it was. */
export function caseIdOf(t: RunTest): string | null {
  return t.caseId ?? (t.edgeId ? baselineCaseId(t.edgeId) : null);
}

export interface RunSummary {
  runId: string;
  /** "edge" only in runs stored before test cases existed. */
  scope: { kind: "project" | "page" | "case" | "feature" | "useCase" | "cases" | "suite" | "edge"; label: string; includeDestructive: boolean };
  startedAt: string;
  finishedAt: string;
  state: "finished" | "cancelled" | "error";
  counts: Record<TestStatus, number>;
  tests: RunTest[];
}

interface RunJob {
  projectId: string;
  runId: string;
  scope: RunSummary["scope"];
  state: "running" | "finished" | "cancelled" | "error";
  startedAt: string;
  log: string[];
  child?: ChildProcess;
  secrets: string[];
  /** Resolved once the run's summary is written (or the run ended without one). */
  done: Promise<void>;
  resolveDone: () => void;
}

// projectId -> the project's current (or last) dashboard test run.
const runJobs = new Map<string, RunJob>();

/** For other plugins' busy checks (e.g. deleting a project while its tests run). */
export function runningTestRun(projectId: string): boolean {
  return runJobs.get(projectId)?.state === "running";
}

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

async function secretsFor(repoRoot: string, projectId: string): Promise<string[]> {
  const map = await loadMap(repoRoot, projectId);
  return map ? projectSecrets(repoRoot, map) : [];
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

function pushRunLog(job: RunJob, line: string) {
  const clean = scrub(stripAnsi(line), job.secrets).trimEnd();
  if (!clean.trim()) return;
  job.log.push(clean.length > 400 ? `${clean.slice(0, 400)}…` : clean);
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
}

function publicRun(job: RunJob | undefined) {
  if (!job) return null;
  const { child: _child, secrets: _secrets, ...rest } = job;
  return { ...rest, log: rest.log.slice(-120) };
}

/** Playwright JSON report -> our summary: one row per (test, browser), edge id from the annotation,
 *  artifact paths repo-relative and only inside this run's folder, errors scrubbed and trimmed. */
/** The innermost test.step() with an error — what the dashboard reports as "failed in step …". */
function deepestFailedStep(steps: any[] | undefined): string | null {
  for (const step of steps ?? []) {
    if (!step?.error) continue;
    return deepestFailedStep(step.steps) ?? step.title ?? null;
  }
  return null;
}

function summarize(report: any, repoRoot: string, runDirAbs: string, job: RunJob, finishedAt: string, state: RunSummary["state"]): RunSummary {
  const walk = (suite: any): any[] => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(walk)];
  const rootDir: string = report?.config?.rootDir ?? repoRoot;
  const toRepoRel = (p: string) => path.relative(repoRoot, p).split(path.sep).join("/");
  const insideRun = (p: string) => !path.relative(runDirAbs, p).startsWith("..");
  const tests: RunTest[] = [];
  for (const spec of (report?.suites ?? []).flatMap(walk)) {
    for (const t of spec.tests ?? []) {
      const result = (t.results ?? []).at(-1) ?? {};
      const isFixme = (t.annotations ?? []).some((a: any) => a.type === "fixme");
      const status: TestStatus =
        isFixme ? "fixme" : t.status === "skipped" ? "skipped" : t.status === "flaky" ? "flaky" : t.status === "expected" ? "passed" : "failed";
      const attachments: any[] = (t.results ?? []).flatMap((r: any) => r.attachments ?? []).filter((a: any) => a.path && insideRun(a.path));
      const error = (result.errors ?? []).map((e: any) => stripAnsi(e.message ?? "")).join("\n").split("\n").slice(0, 12).join("\n");
      tests.push({
        caseId: (t.annotations ?? []).find((a: any) => a.type === "case")?.description ?? null,
        edgeId: (t.annotations ?? []).find((a: any) => a.type === "edge")?.description ?? null,
        row: (t.annotations ?? []).find((a: any) => a.type === "row")?.description ?? null,
        failedStep: status === "failed" ? deepestFailedStep(result.steps) : null,
        title: spec.title,
        file: toRepoRel(path.join(rootDir, spec.file)),
        line: spec.line,
        browser: t.projectName,
        status,
        durationMs: Math.round((t.results ?? []).reduce((sum: number, r: any) => sum + (r.duration ?? 0), 0)),
        error: error ? scrub(error, job.secrets) : null,
        artifacts: {
          trace: attachments.find((a) => a.name === "trace") ? toRepoRel(attachments.filter((a) => a.name === "trace").at(-1).path) : null,
          video: attachments.find((a) => a.contentType === "video/webm") ? toRepoRel(attachments.filter((a) => a.contentType === "video/webm").at(-1).path) : null,
          screenshots: attachments.filter((a) => a.contentType === "image/png").map((a) => toRepoRel(a.path)),
          errorContext: (() => {
            const ctx = attachments.filter((a) => a.name === "error-context" || String(a.path).endsWith("error-context.md")).at(-1);
            return ctx ? toRepoRel(ctx.path) : null;
          })(),
        },
      });
    }
  }
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0, fixme: 0 } as Record<TestStatus, number>;
  for (const t of tests) counts[t.status]++;
  return { runId: job.runId, scope: job.scope, startedAt: job.startedAt, finishedAt, state, counts, tests };
}

export async function listSummaries(repoRoot: string, projectId: string): Promise<RunSummary[]> {
  const runsDir = abs(repoRoot, projectPaths(projectId).runs);
  const ids = (await readdir(runsDir).catch(() => [] as string[])).filter((d) => /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/.test(d)).sort().reverse();
  const out: RunSummary[] = [];
  for (const id of ids) {
    try {
      out.push(withCaseIds(JSON.parse(await readFile(path.join(runsDir, id, "summary.json"), "utf-8"))));
    } catch {
      // a run that never produced a summary (crashed mid-way) — skip it
    }
  }
  return out;
}

/** Fills caseId on tests from runs stored before test cases existed (see caseIdOf). */
function withCaseIds(summary: RunSummary): RunSummary {
  return { ...summary, tests: summary.tests.map((t) => ({ ...t, caseId: caseIdOf(t) })) };
}

/** The newest stored run that has a summary, without reading the whole history. */
export async function latestRunSummary(repoRoot: string, projectId: string): Promise<RunSummary | undefined> {
  const runsDir = abs(repoRoot, projectPaths(projectId).runs);
  const ids = (await readdir(runsDir).catch(() => [] as string[])).filter((d) => /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/.test(d)).sort().reverse();
  for (const id of ids) {
    try {
      return JSON.parse(await readFile(path.join(runsDir, id, "summary.json"), "utf-8"));
    } catch {
      // no summary (crashed run) — try the previous one
    }
  }
  return undefined;
}

async function pruneRuns(repoRoot: string, projectId: string) {
  const runsDir = abs(repoRoot, projectPaths(projectId).runs);
  const ids = (await readdir(runsDir).catch(() => [] as string[])).filter((d) => /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/.test(d)).sort().reverse();
  for (const old of ids.slice(MAX_RUNS_KEPT)) await rm(path.join(runsDir, old), { recursive: true, force: true });
}

type LatestEntry = { status: TestStatus; runId: string; at: string };
const STATUS_RANK: Record<TestStatus, number> = { failed: 4, flaky: 3, skipped: 2, fixme: 1, passed: 0 };

/** Newest result per case across the stored runs (worst across browsers within one run), and per
 *  action: the worst latest result of the cases that step through it — what the map heatmap shows. */
export function latestStatus(summaries: RunSummary[], cases: TestCase[]) {
  const byCase: Record<string, LatestEntry> = {};
  for (const s of summaries) {
    const inRun: Record<string, TestStatus> = {};
    for (const t of s.tests) {
      const id = caseIdOf(t);
      if (!id) continue;
      const prev = inRun[id];
      if (!prev || STATUS_RANK[t.status] > STATUS_RANK[prev]) inRun[id] = t.status;
    }
    for (const [id, status] of Object.entries(inRun)) {
      if (!byCase[id]) byCase[id] = { status, runId: s.runId, at: s.finishedAt };
    }
  }
  const byEdge: Record<string, LatestEntry> = {};
  for (const c of cases) {
    const latest = byCase[c.id];
    if (!latest) continue;
    for (const step of c.steps) {
      const prev = byEdge[step.edgeId];
      if (!prev || STATUS_RANK[latest.status] > STATUS_RANK[prev.status]) byEdge[step.edgeId] = latest;
    }
  }
  return { cases: byCase, edges: byEdge };
}

// Set when the plugin starts — lets other plugins (triage auto-verify) run a case and wait for it.
let startRunForOthers: ((projectId: string, body: z.infer<typeof StartBody>, labelSuffix?: string) => Promise<RunJob | { error: string; status: number }>) | undefined;

/** Runs one case (destructive included — the caller decided) and resolves with its summary; null
 *  when a run is already in progress on the project or the run couldn't start. */
export async function runCaseAndWait(repoRoot: string, projectId: string, caseId: string): Promise<RunSummary | null> {
  if (!startRunForOthers || runningTestRun(projectId)) return null;
  const started = await startRunForOthers(projectId, { scope: "case", caseId, includeDestructive: true }, " (triage verification, fix applied temporarily)");
  if ("error" in started) return null;
  await started.done;
  try {
    return JSON.parse(await readFile(abs(repoRoot, path.posix.join(projectPaths(projectId).runs, started.runId, "summary.json")), "utf-8"));
  } catch {
    return null;
  }
}

export function navmapRunsApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  const playwrightCli = path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js");

  async function startRun(projectId: string, body: z.infer<typeof StartBody>, labelSuffix = ""): Promise<RunJob | { error: string; status: number }> {
    const paths = projectPaths(projectId);
    if (!(await pathExists(abs(repoRoot, path.posix.join(paths.tests, "fixtures.ts"))))) {
      return { error: "No generated tests yet — approve some test cases first", status: 409 };
    }
    const map = (await loadMap(repoRoot, projectId))!;
    let targets: string[];
    let label: string;
    if (body.scope === "project") {
      const specs = (await readdir(abs(repoRoot, paths.tests)).catch(() => [] as string[])).filter((f) => f.endsWith(".spec.ts"));
      if (specs.length === 0) return { error: "No approved test cases yet — approve some in the Cases tab", status: 409 };
      targets = [paths.tests];
      label = "All tests";
    } else if (body.scope === "page") {
      if (!body.pageId || !map.pages[body.pageId]) return { error: "Unknown page", status: 400 };
      const spec = path.posix.join(paths.tests, `${body.pageId}.spec.ts`);
      if (!(await pathExists(abs(repoRoot, spec)))) return { error: "That page has no approved test cases", status: 404 };
      targets = [spec];
      label = `Page: ${map.pages[body.pageId].title}`;
    } else if (body.scope === "feature" || body.scope === "useCase") {
      // A feature or use case: its approved cases' tests (every data row), wherever their specs live.
      const org = await loadOrganization(repoRoot, projectId);
      const feature = body.scope === "feature" ? org?.features.find((f) => f.id === body.featureId) : undefined;
      const found = body.scope === "useCase" && org && body.useCaseId ? findUseCase(org, body.useCaseId) : undefined;
      if (!feature && !found) return { error: `Unknown ${body.scope === "feature" ? "feature" : "use case"}`, status: 400 };
      const caseIds = new Set(feature ? feature.useCases.flatMap((u) => u.cases) : found!.useCase.cases);
      const approved = (await loadCases(repoRoot, projectId)).filter((c) => caseIds.has(c.id) && c.status === "approved");
      targets = [];
      for (const c of approved) for (const t of await locateTests(repoRoot, projectId, c.id)) targets.push(`${t.file}:${t.line}`);
      if (targets.length === 0) return { error: `That ${feature ? "feature" : "use case"} has no approved test cases yet`, status: 404 };
      label = feature ? `Feature: ${feature.title}` : `Use case: ${found!.useCase.title}`;
    } else if (body.scope === "cases" || body.scope === "suite") {
      // A hand-picked selection or a saved suite: its approved cases' tests (every data row).
      const suite = body.scope === "suite" ? (await loadSuites(repoRoot, projectId)).suites.find((s) => s.id === body.suiteId) : undefined;
      if (body.scope === "suite" && !suite) return { error: "Unknown suite", status: 400 };
      const picked = new Set(suite ? suite.caseIds : (body.caseIds ?? []));
      if (picked.size === 0) return { error: "No test cases selected", status: 400 };
      const approved = (await loadCases(repoRoot, projectId)).filter((c) => picked.has(c.id) && c.status === "approved");
      targets = [];
      for (const c of approved) for (const t of await locateTests(repoRoot, projectId, c.id)) targets.push(`${t.file}:${t.line}`);
      if (targets.length === 0) return { error: suite ? `Suite "${suite.name}" has no approved test cases yet` : "None of the selected cases is approved yet — only approved cases have tests", status: 404 };
      label = suite ? `Suite: ${suite.name}` : `${approved.length} selected case${approved.length === 1 ? "" : "s"}`;
    } else {
      const testCase = body.caseId ? (await loadCases(repoRoot, projectId)).find((c) => c.id === body.caseId) : undefined;
      if (!testCase) return { error: "Unknown test case", status: 400 };
      // A data-table case has one test per row — run them all.
      const located = await locateTests(repoRoot, projectId, testCase.id);
      if (located.length === 0) return { error: "That case has no generated test — approve it first", status: 404 };
      targets = located.map((t) => `${t.file}:${t.line}`);
      label = `Test: ${testCase.title}${labelSuffix}`;
    }

    const runId = newRunId();
    const runDir = path.posix.join(paths.runs, runId);
    await mkdir(abs(repoRoot, runDir), { recursive: true });
    const job: RunJob = {
      projectId,
      runId,
      scope: { kind: body.scope, label, includeDestructive: body.includeDestructive },
      state: "running",
      startedAt: new Date().toISOString(),
      log: [],
      secrets: await secretsFor(repoRoot, projectId),
      done: Promise.resolve(),
      resolveDone: () => undefined,
    };
    job.done = new Promise<void>((resolve) => (job.resolveDone = resolve));
    runJobs.set(projectId, job);

    // A single test, a selection or a suite runs even if destructive — the user picked those cases explicitly.
    const explicit = body.scope === "case" || body.scope === "cases" || body.scope === "suite";
    const grepInvert = !body.includeDestructive && !explicit ? ["--grep-invert", "@destructive"] : [];
    const args = [playwrightCli, "test", ...targets, "--reporter=list,json", `--output=${path.posix.join(runDir, "artifacts")}`, ...grepInvert];
    pushRunLog(job, `$ playwright test ${targets.join(" ")}${grepInvert.length ? " (excluding @destructive)" : ""}`);
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: abs(repoRoot, path.posix.join(runDir, "results.json")), FORCE_COLOR: "0" },
    });
    job.child = child;
    let partial = "";
    const onData = (chunk: Buffer) => {
      partial += chunk.toString();
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) pushRunLog(job, line);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", async () => {
      if (partial) pushRunLog(job, partial);
      job.child = undefined;
      const cancelled = job.state === "cancelled";
      const finishedAt = new Date().toISOString();
      try {
        const report = JSON.parse(await readFile(abs(repoRoot, path.posix.join(runDir, "results.json")), "utf-8"));
        const summary = summarize(report, repoRoot, abs(repoRoot, runDir), job, finishedAt, cancelled ? "cancelled" : "finished");
        await writeFile(abs(repoRoot, path.posix.join(runDir, "summary.json")), JSON.stringify(summary, null, 2), "utf-8");
        // error-context.md holds the page snapshot at failure, which can show typed values.
        for (const t of summary.tests) {
          if (!t.artifacts.errorContext) continue;
          const file = abs(repoRoot, t.artifacts.errorContext);
          const raw = await readFile(file, "utf-8").catch(() => null);
          if (raw !== null) await writeFile(file, scrub(raw, job.secrets), "utf-8");
        }
        // The raw report holds unscrubbed error text — only the scrubbed summary is kept.
        await rm(abs(repoRoot, path.posix.join(runDir, "results.json")), { force: true });
        if (!cancelled) job.state = "finished";
        pushRunLog(job, `Done: ${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.flaky} flaky, ${summary.counts.skipped + summary.counts.fixme} skipped`);
      } catch {
        if (!cancelled) job.state = "error";
        pushRunLog(job, cancelled ? "Cancelled." : "The run ended without a report — see the log above.");
      }
      await pruneRuns(repoRoot, projectId).catch(() => undefined);
      job.resolveDone();
    });
    child.on("error", (err) => {
      job.state = "error";
      pushRunLog(job, `Could not start Playwright: ${err.message}`);
      job.resolveDone();
    });
    return job;
  }
  startRunForOthers = startRun;

  return {
    name: "navmap-runs-api",
    configureServer(server) {
      // Reset/delete a project: DELETE /api/projects/<id> with { confirm: "<id>" }. Removes the whole
      // projects/<id>/ folder (map, users, credentials, sessions, tests, runs) — the same as the
      // user deleting it by hand, so "New project" works again for that site.
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const m = /^\/([a-z0-9-]{1,80})\/?$/.exec((req.url ?? "/").split("?")[0]);
        if (!m || req.method !== "DELETE") return next();
        const projectId = m[1];
        try {
          const body = z.object({ confirm: z.string() }).safeParse(await readJsonBody(req));
          if (!body.success || body.data.confirm !== projectId) {
            return sendJson(res, 400, { error: "Type the project id exactly to confirm" });
          }
          if (!(await loadMap(repoRoot, projectId))) return sendJson(res, 404, { error: "Project not found" });
          if (runningJobForProject(projectId) || runningTestRun(projectId)) {
            return sendJson(res, 409, { error: "An agent or a test run is active on this project — cancel it first" });
          }
          const projectsRoot = abs(repoRoot, PROJECTS_DIR);
          const target = abs(repoRoot, projectPaths(projectId).dir);
          if (path.dirname(target) !== projectsRoot) return sendJson(res, 400, { error: "Invalid project path" });
          await rm(target, { recursive: true, force: true });
          runJobs.delete(projectId);
          return sendJson(res, 200, { deleted: projectId });
        } catch (err) {
          console.error(`[navmap-runs-api] delete ${projectId} failed:`, err);
          return sendJson(res, 500, { error: "Could not delete the project" });
        }
      });

      server.middlewares.use("/api/projects", async (req, res, next) => {
        const m = RUNS_RE.exec((req.url ?? "/").split("?")[0]);
        if (!m) return next();
        const [, projectId, sub, action] = m;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });
        try {
          if (!(await loadMap(repoRoot, projectId))) return sendJson(res, 404, { error: "Project not found" });
          const job = runJobs.get(projectId);

          if (!sub && req.method === "GET") return sendJson(res, 200, { runs: await listSummaries(repoRoot, projectId), current: publicRun(job) });

          if (!sub && req.method === "POST") {
            if (job?.state === "running") return sendJson(res, 409, { error: "A test run is already in progress for this project", current: publicRun(job) });
            const parsed = StartBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid run request" });
            const started = await startRun(projectId, parsed.data);
            if ("error" in started) return sendJson(res, started.status, { error: started.error });
            return sendJson(res, 202, { current: publicRun(started) });
          }

          if (sub === "latest-status" && req.method === "GET") {
            return sendJson(res, 200, latestStatus(await listSummaries(repoRoot, projectId), await loadCases(repoRoot, projectId)));
          }

          if (sub && sub !== "latest-status" && !action && req.method === "GET") {
            const live = job?.runId === sub ? publicRun(job) : null;
            try {
              const summary = withCaseIds(JSON.parse(await readFile(abs(repoRoot, path.posix.join(projectPaths(projectId).runs, sub, "summary.json")), "utf-8")));
              return sendJson(res, 200, { summary, current: live });
            } catch {
              return live ? sendJson(res, 200, { summary: null, current: live }) : sendJson(res, 404, { error: "Run not found" });
            }
          }

          if (sub && action === "cancel" && req.method === "POST") {
            if (!job || job.runId !== sub || job.state !== "running" || !job.child?.pid) return sendJson(res, 409, { error: "That run isn't in progress" });
            job.state = "cancelled";
            killTree(job.child.pid);
            return sendJson(res, 202, { current: publicRun(job) });
          }

          if (sub && action === "trace" && req.method === "POST") {
            const { testIndex } = z.object({ testIndex: z.number().int().min(0) }).parse(await readJsonBody(req));
            const runDir = abs(repoRoot, path.posix.join(projectPaths(projectId).runs, sub));
            const summary: RunSummary = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf-8"));
            const trace = summary.tests[testIndex]?.artifacts.trace;
            if (!trace) return sendJson(res, 404, { error: "No trace for that test" });
            const traceAbs = abs(repoRoot, trace);
            const rel = path.relative(runDir, traceAbs);
            if (rel.startsWith("..") || path.isAbsolute(rel) || !traceAbs.endsWith(".zip")) return sendJson(res, 400, { error: "Invalid trace" });
            // Opens Playwright's trace viewer as a local window — traces are never served over HTTP.
            spawn(process.execPath, [playwrightCli, "show-trace", traceAbs], { cwd: repoRoot, detached: true, stdio: "ignore" }).unref();
            return sendJson(res, 202, { opened: true });
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-runs-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Runs request failed" });
        }
      });
    },
  };
}
