import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import type { ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { z } from "zod/v4";
import { slugify } from "../../src/navmap-ids";
import { CredentialsSchema } from "../../src/navmap-auth";
import { credentialsPathFor, loadProjectUsers } from "../../src/navmap-users";
import { loadProjectSettings } from "../../src/navmap-settings";
import { abs, projectPaths } from "../../src/project-paths";
import { loadMap, pathExists, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";
import { regenerateInBackground } from "./regenerate";
import { applyTriageRecord, triageOverview, verifyTriageRecord } from "./triage";
import { listTriageRecords, loadTriageRecord, saveTriageRecord } from "../../src/navmap-triage";
import { scrubSnapshots } from "../../src/navmap-snapshots";
import { findUseCase, loadOrganization, ORG_ID_RE } from "../../src/navmap-features";
import { loadRequirements } from "../../src/navmap-requirements";
import {
  cancelAgentJob,
  getJob,
  listJobs,
  publicJob,
  pushLog,
  runningJobForProject,
  runningJobs,
  shellCommands,
  startAgentJob,
  type AgentJob,
} from "./agentJobs";

// Model, budget and the default page count come from the project's settings (projects/<id>/settings.json,
// Settings tab); a brand-new project has no file yet, so it runs on the defaults.

const NewProjectBody = z.object({
  baseUrl: z.url(),
  focus: z.string().max(300).optional(),
  maxNewPages: z.number().int().min(1).max(50).optional(),
  auth: z.object({ username: z.string().min(1), password: z.string().min(1), loginUrl: z.url().optional() }).optional(),
});

const ExploreMoreBody = z.object({
  focus: z.string().max(300).optional(),
  maxNewPages: z.number().int().min(1).max(50).optional(),
  userId: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
});

// Playwright MCP tools the explorer may use. Deliberately absent: browser_run_code_unsafe (arbitrary
// code — documented as RCE-equivalent), browser_file_upload, and browser_close (it would pull the
// page out from under the live stream).
const BROWSER_TOOLS = [
  "navigate",
  "navigate_back",
  "snapshot",
  "find",
  "click",
  "hover",
  "type",
  "fill_form",
  "select_option",
  "press_key",
  "drag",
  "drop",
  "wait_for",
  "evaluate",
  "take_screenshot",
  "tabs",
  "handle_dialog",
  "resize",
  "console_messages",
  "network_requests",
  "network_request",
].map((t) => `mcp__playwright__browser_${t}`);

const NAVMAP_COMMANDS = [
  "npm run navmap:id:*",
  "npm run navmap:run-id:*",
  "npm run navmap:finalize-shot:*",
  "npm run navmap:merge:*",
  "npm run report:navmap:*",
];

// The test-design agent: everything the explorer may do (it can record a missing action the same
// way), plus its read-only context helpers and the validated save of its design.
const DESIGN_COMMANDS = [...NAVMAP_COMMANDS, "npm run navmap:design-context:*", "npm run navmap:snapshot:*", "npm run navmap:save-design:*", "npm run navmap:test-data:*"];

// The triage agent: read-only context, the validated save of its verdicts, snapshots and the
// browser to reproduce. It never merges into the map — fixes are proposals the user approves.
const TRIAGE_COMMANDS = ["npm run navmap:triage-context:*", "npm run navmap:save-triage:*", "npm run navmap:snapshot:*", "npm run navmap:id:*", "npm run navmap:run-id:*"];

const TriageBody = z.object({
  testIndexes: z.array(z.number().int().min(0)).min(1).max(30),
  allowDestructive: z.boolean().default(false),
});

const DesignBody = z.object({
  pageId: z.string().regex(/^[a-z0-9_-]{1,200}$/).optional(),
  /** Design cases for this use case (features.json) — drafts get filed under it. */
  useCaseId: z.string().regex(ORG_ID_RE).optional(),
  /** Design cases for this requirement's uncovered acceptance criteria — drafts get linked to them. */
  requirementId: z.string().regex(ORG_ID_RE).optional(),
  request: z.string().max(1000).optional(),
});

/** The live view of one exploration. The agent's Playwright MCP launches and owns the headless
 *  Chromium (with a debugging port we pick, via an MCP config file), and we attach to it only to
 *  screencast whichever page is active into an MJPEG stream.
 *
 *  Not the other way round: when the MCP *connected* over CDP to a Chromium we had launched, its
 *  clicks stopped reaching pages after the first navigation (0 pointer events — reproduced on
 *  saucedemo 2026-10-06 with @playwright/mcp 0.0.83, which bundles its own Playwright), while the
 *  same clicks work when the MCP launches the browser itself. */
class LiveBrowser {
  readonly viewers = new Set<ServerResponse>();
  lastFrame: Buffer | null = null;
  private browser?: Browser;
  private session?: CDPSession;
  private activePage?: Page;
  private closed = false;

  private constructor(
    readonly endpoint: string,
    /** MCP config that makes it launch Chromium with our debugging port. */
    readonly mcpConfigPath: string,
    private readonly profileDir: string,
  ) {}

  static async launch(): Promise<LiveBrowser> {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as net.AddressInfo;
        srv.close(() => resolve(port));
      });
    });
    const profileDir = await mkdtemp(path.join(tmpdir(), "navmap-explore-"));
    const mcpConfigPath = path.join(profileDir, "mcp-config.json");
    await writeFile(
      mcpConfigPath,
      JSON.stringify({
        browser: {
          browserName: "chromium",
          isolated: true,
          launchOptions: {
            headless: true,
            executablePath: chromium.executablePath(),
            args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
          },
        },
      }),
      "utf-8",
    );
    const live = new LiveBrowser(`http://127.0.0.1:${port}`, mcpConfigPath, profileDir);
    // The MCP launches Chromium on the agent's first browser call — attach whenever it's up.
    void live.attachWhenUp();
    return live;
  }

  private async attachWhenUp() {
    while (!this.closed) {
      try {
        if ((await fetch(`${this.endpoint}/json/version`)).ok && (await this.startScreencast())) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** false = the MCP hasn't created its browser context yet (try again shortly). */
  private async startScreencast(): Promise<boolean> {
    const browser = await chromium.connectOverCDP(this.endpoint);
    const context = browser.contexts()[0];
    if (!context || this.closed) {
      await browser.close().catch(() => undefined);
      return false;
    }
    this.browser = browser;
    const pages = context.pages();
    if (pages.length) await this.follow(pages[pages.length - 1]);
    // Follow the agent into new tabs; fall back to the last remaining tab when one closes.
    context.on("page", (page) => {
      void this.follow(page);
      page.on("close", () => {
        const remaining = context.pages();
        if (this.activePage === page && remaining.length) void this.follow(remaining[remaining.length - 1]);
      });
    });
    return true;
  }

  private async follow(page: Page) {
    if (this.activePage === page) return;
    this.activePage = page;
    await this.session?.detach().catch(() => undefined);
    try {
      const session = await page.context().newCDPSession(page);
      this.session = session;
      session.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
        this.broadcast(Buffer.from(frame.data, "base64"));
        session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      });
      await session.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800 });
    } catch {
      // The page may already be gone (closed tab) — the next page event will pick a new one.
    }
  }

  private broadcast(frame: Buffer) {
    this.lastFrame = frame;
    for (const res of this.viewers) writeFrame(res, frame);
  }

  addViewer(res: ServerResponse) {
    this.viewers.add(res);
    if (this.lastFrame) writeFrame(res, this.lastFrame);
    res.on("close", () => this.viewers.delete(res));
  }

  async close() {
    for (const res of this.viewers) res.end();
    this.viewers.clear();
    this.closed = true;
    await this.session?.detach().catch(() => undefined);
    // The MCP owns the browser and normally closes it when the agent exits; close it explicitly
    // anyway (the job is over) so a crashed MCP can't leave a headless Chromium behind.
    if (this.browser) {
      const cdp = await this.browser.newBrowserCDPSession().catch(() => undefined);
      await cdp?.send("Browser.close").catch(() => undefined);
      await this.browser.close().catch(() => undefined);
    }
    // Chromium holds files in the profile briefly after exit; retry the removal a few times.
    for (let i = 0; i < 10; i++) {
      try {
        await rm(this.profileDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}

function startMjpeg(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache, no-store",
    Connection: "close",
  });
}

function writeFrame(res: ServerResponse, frame: Buffer) {
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  res.write("\r\n");
}

export function navmapExploreApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  // projectId -> the live browser of its running exploration; lastFrames survive the run so the
  // panel keeps showing where the agent ended up.
  const liveBrowsers = new Map<string, LiveBrowser>();
  const lastFrames = new Map<string, Buffer>();

  async function startExploration(
    projectId: string,
    baseUrl: string,
    focus: string | undefined,
    requestedMaxNewPages: number | undefined,
    credsRef: string | undefined,
  ): Promise<AgentJob> {
    const { explorer } = (await loadProjectSettings(repoRoot, projectId)).agents;
    const maxNewPages = requestedMaxNewPages ?? explorer.defaultMaxNewPages;
    const live = await LiveBrowser.launch();
    liveBrowsers.set(projectId, live);

    let credsCopy: string | undefined;
    const secrets: string[] = [];
    try {
      if (credsRef) {
        // The agent can't read credentials/ (denied for every run); it gets a copy of just this one.
        const creds = CredentialsSchema.parse(JSON.parse(await readFile(path.join(repoRoot, credsRef), "utf-8")));
        secrets.push(creds.password);
        credsCopy = path.posix.join(projectPaths(projectId).staging, ".run-explore-creds.json");
        await mkdir(abs(repoRoot, projectPaths(projectId).staging), { recursive: true });
        await writeFile(path.join(repoRoot, credsCopy), JSON.stringify(creds), { encoding: "utf-8", mode: 0o600 });
      }
    } catch (err) {
      await live.close();
      liveBrowsers.delete(projectId);
      throw err;
    }

    // focus is free text from the form: strip quotes/newlines so it stays one well-formed argument.
    const safeFocus = focus?.replace(/["\r\n]+/g, " ").trim();
    const prompt = [
      `/navmap ${baseUrl}`,
      credsCopy ? `creds=${credsCopy} credsRef=${credsRef}` : "",
      safeFocus ? `focus="${safeFocus}"` : "",
      `maxNewPages=${maxNewPages}`,
    ]
      .filter(Boolean)
      .join(" ");

    return startAgentJob({
      kind: "explore",
      projectId,
      label: `explorer for ${baseUrl}`,
      meta: { baseUrl, focus: safeFocus ?? null, maxNewPages, authenticated: !!credsRef, liveView: true },
      cwd: repoRoot,
      prompt,
      model: explorer.model,
      budgetUsd: explorer.budgetUsd,
      allowedTools: ["Read", "Glob", "Grep", `Edit(${projectPaths(projectId).staging}/**)`, ...BROWSER_TOOLS, ...shellCommands(NAVMAP_COMMANDS)],
      deniedTools: ["mcp__playwright__browser_run_code_unsafe", "mcp__playwright__browser_file_upload"],
      mcpConfig: {
        mcpServers: {
          playwright: { command: "node", args: [path.join(repoRoot, "node_modules", "@playwright", "mcp", "cli.js"), "--config", live.mcpConfigPath] },
        },
      },
      secrets,
      onExit: async (job) => {
        // Before anything reads them: page snapshots must never keep a typed password.
        await scrubSnapshots(repoRoot, projectId, secrets).catch(() => undefined);
        if (live.lastFrame) lastFrames.set(projectId, live.lastFrame);
        job.meta.liveView = false;
        await live.close();
        liveBrowsers.delete(projectId);
        if (credsCopy) await rm(path.join(repoRoot, credsCopy), { force: true });
        if (job.state === "succeeded" && !(await pathExists(abs(repoRoot, projectPaths(projectId).navmap)))) {
          pushLog(
            job,
            job.stopReason === "usage_limit"
              ? "No map was written: the run stopped early because your Claude plan's usage limit was nearly reached."
              : "The agent finished but no map was written — check the log above.",
          );
          job.state = "failed";
        }
        // Whatever the outcome, the agent may have merged new pages/actions: page objects follow the
        // map, and cases whose actions changed get flagged. Never creates cases.
        if (await pathExists(abs(repoRoot, projectPaths(projectId).navmap))) regenerateInBackground(repoRoot, projectId, "an exploration");
      },
    });
  }

  /** Designs test cases (the /navmap-design-cases skill): reads the map + snapshots, opens the
   *  same kind of live browser as the explorer only to verify or observe, saves drafts. */
  async function startDesign(
    projectId: string,
    pageId: string | undefined,
    request: string | undefined,
    useCase?: { id: string; title: string },
    requirement?: { id: string; title: string },
  ): Promise<AgentJob> {
    const map = (await loadMap(repoRoot, projectId))!;
    const { designer } = (await loadProjectSettings(repoRoot, projectId)).agents;
    const live = await LiveBrowser.launch();
    liveBrowsers.set(projectId, live);

    // The agent may need to log in to verify something: a copy of the first auth user's
    // credentials, exactly like the explorer gets (credentials/ itself is always denied).
    let credsCopy: string | undefined;
    let credsRef: string | undefined;
    const secrets: string[] = [];
    try {
      const authUser = (await loadProjectUsers(repoRoot, map)).find((u) => u.kind === "auth" && u.credentialsRef);
      if (authUser?.credentialsRef) {
        const creds = CredentialsSchema.parse(JSON.parse(await readFile(path.join(repoRoot, authUser.credentialsRef), "utf-8")));
        secrets.push(creds.password);
        credsRef = authUser.credentialsRef;
        credsCopy = path.posix.join(projectPaths(projectId).staging, ".run-design-creds.json");
        await mkdir(abs(repoRoot, projectPaths(projectId).staging), { recursive: true });
        await writeFile(path.join(repoRoot, credsCopy), JSON.stringify(creds), { encoding: "utf-8", mode: 0o600 });
      }
    } catch (err) {
      await live.close();
      liveBrowsers.delete(projectId);
      throw err;
    }

    // The request is the user's free text: one quoted argument, no quotes/newlines inside.
    const safeRequest = request?.replace(/["\r\n]+/g, " ").trim();
    const prompt = [
      `/navmap-design-cases ${projectId}`,
      pageId ? `page=${pageId}` : "",
      useCase ? `useCase=${useCase.id}` : "",
      requirement ? `requirement=${requirement.id}` : "",
      credsCopy ? `creds=${credsCopy} credsRef=${credsRef}` : "",
      safeRequest ? `request="${safeRequest}"` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return startAgentJob({
      kind: "design",
      projectId,
      label: `test designer${requirement ? ` for "${requirement.title}"` : useCase ? ` for "${useCase.title}"` : pageId ? ` for ${map.pages[pageId]?.title ?? pageId}` : ""}`,
      meta: { pageId: pageId ?? null, useCaseId: useCase?.id ?? null, requirementId: requirement?.id ?? null, request: safeRequest ?? null, liveView: true },
      cwd: repoRoot,
      prompt,
      model: designer.model,
      budgetUsd: designer.budgetUsd,
      allowedTools: ["Read", "Glob", "Grep", `Edit(${projectPaths(projectId).staging}/**)`, ...BROWSER_TOOLS, ...shellCommands(DESIGN_COMMANDS)],
      deniedTools: ["mcp__playwright__browser_run_code_unsafe", "mcp__playwright__browser_file_upload"],
      mcpConfig: {
        mcpServers: {
          playwright: { command: "node", args: [path.join(repoRoot, "node_modules", "@playwright", "mcp", "cli.js"), "--config", live.mcpConfigPath] },
        },
      },
      secrets,
      onExit: async (job) => {
        await scrubSnapshots(repoRoot, projectId, secrets).catch(() => undefined);
        if (live.lastFrame) lastFrames.set(projectId, live.lastFrame);
        job.meta.liveView = false;
        await live.close();
        liveBrowsers.delete(projectId);
        if (credsCopy) await rm(path.join(repoRoot, credsCopy), { force: true });
        // New drafts get previews; new elements/actions reach the page objects.
        regenerateInBackground(repoRoot, projectId, "a design run");
      },
    });
  }

  /** Triages failed tests of one run (the /navmap-triage skill), then verifies every new fix
   *  proposal by re-running its case with the fix applied (and reverted afterwards). */
  async function startTriage(projectId: string, runId: string, testIndexes: number[], allowDestructive: boolean): Promise<AgentJob> {
    const map = (await loadMap(repoRoot, projectId))!;
    const { triager } = (await loadProjectSettings(repoRoot, projectId)).agents;
    const live = await LiveBrowser.launch();
    liveBrowsers.set(projectId, live);

    let credsCopy: string | undefined;
    let credsRef: string | undefined;
    const secrets: string[] = [];
    try {
      const authUser = (await loadProjectUsers(repoRoot, map)).find((u) => u.kind === "auth" && u.credentialsRef);
      if (authUser?.credentialsRef) {
        const creds = CredentialsSchema.parse(JSON.parse(await readFile(path.join(repoRoot, authUser.credentialsRef), "utf-8")));
        secrets.push(creds.password);
        credsRef = authUser.credentialsRef;
        credsCopy = path.posix.join(projectPaths(projectId).staging, ".run-triage-creds.json");
        await mkdir(abs(repoRoot, projectPaths(projectId).staging), { recursive: true });
        await writeFile(path.join(repoRoot, credsCopy), JSON.stringify(creds), { encoding: "utf-8", mode: 0o600 });
      }
    } catch (err) {
      await live.close();
      liveBrowsers.delete(projectId);
      throw err;
    }

    const startedAt = new Date().toISOString();
    const prompt = [`/navmap-triage ${projectId} ${runId} ${testIndexes.join(" ")}`, credsCopy ? `creds=${credsCopy} credsRef=${credsRef}` : ""].filter(Boolean).join(" ");
    return startAgentJob({
      kind: "triage",
      projectId,
      label: `triage of ${testIndexes.length} failure${testIndexes.length === 1 ? "" : "s"}`,
      meta: { runId, testIndexes, allowDestructive, liveView: true, verifying: false },
      cwd: repoRoot,
      prompt,
      model: triager.model,
      budgetUsd: triager.budgetUsd,
      allowedTools: ["Read", "Glob", "Grep", `Edit(${projectPaths(projectId).staging}/**)`, ...BROWSER_TOOLS, ...shellCommands(TRIAGE_COMMANDS)],
      deniedTools: ["mcp__playwright__browser_run_code_unsafe", "mcp__playwright__browser_file_upload"],
      mcpConfig: {
        mcpServers: {
          playwright: { command: "node", args: [path.join(repoRoot, "node_modules", "@playwright", "mcp", "cli.js"), "--config", live.mcpConfigPath] },
        },
      },
      secrets,
      onExit: async (job) => {
        await scrubSnapshots(repoRoot, projectId, secrets).catch(() => undefined);
        if (live.lastFrame) lastFrames.set(projectId, live.lastFrame);
        job.meta.liveView = false;
        await live.close();
        liveBrowsers.delete(projectId);
        if (credsCopy) await rm(path.join(repoRoot, credsCopy), { force: true });
        // Verify each new proposal: no AI, no quota — just the one test with the fix applied.
        const fresh = (await listTriageRecords(repoRoot, projectId, runId)).filter((r) => r.status === "proposed" && r.createdAt >= startedAt && !r.verification);
        if (fresh.length === 0) return;
        job.meta.verifying = true;
        try {
          for (const record of fresh) await verifyTriageRecord(repoRoot, projectId, record, allowDestructive, (line) => pushLog(job, line));
        } finally {
          job.meta.verifying = false;
        }
      },
    });
  }

  function busyReason(projectId: string): string | null {
    const sameProject = runningJobForProject(projectId);
    if (sameProject) {
      return sameProject.kind === "explore"
        ? "This project is already being explored"
        : sameProject.kind === "design"
          ? "Test cases are already being designed for this project"
          : sameProject.kind === "triage"
            ? "Failures are already being triaged on this project"
            : sameProject.kind === "organize"
              ? "The organizer is grouping this project's cases right now"
              : "A linking run is in progress on this project";
    }
    // One browser agent at a time: explorations and design runs share the live-browser setup.
    if (runningJobs("explore").length + runningJobs("design").length + runningJobs("triage").length > 0) {
      return "Another browser agent (exploration, design or triage) is running — one at a time";
    }
    return null;
  }

  return {
    name: "navmap-explore-api",
    configureServer(server) {
      // New projects + job status/stream: /api/explorations[/<projectId>[/cancel|/live.mjpeg]]
      server.middlewares.use("/api/explorations", async (req, res) => {
        const m = /^\/?(?:([a-z0-9-]{1,80})(?:\/(cancel|live\.mjpeg))?)?\/?$/.exec((req.url ?? "/").split("?")[0]);
        if (!m) return sendJson(res, 404, { error: "Not found" });
        const [, projectId, action] = m;
        try {
          if (!projectId && req.method === "GET") return sendJson(res, 200, { jobs: listJobs("explore").map(publicJob) });

          if (!projectId && req.method === "POST") {
            const parsed = NewProjectBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid request", details: z.prettifyError(parsed.error) });
            const body = parsed.data;
            const url = new URL(body.baseUrl);
            if (url.protocol !== "http:" && url.protocol !== "https:") return sendJson(res, 400, { error: "Only http(s) URLs" });
            const newProjectId = slugify(url.hostname.toLowerCase()); // same derivation as scripts/merge-navmap.ts
            if (await loadMap(repoRoot, newProjectId)) {
              return sendJson(res, 409, { error: "This site is already a project — use Explore more on it", projectId: newProjectId });
            }
            const busy = busyReason(newProjectId);
            if (busy) return sendJson(res, 409, { error: busy });
            let credsRef: string | undefined;
            if (body.auth) {
              credsRef = credentialsPathFor(newProjectId, "default");
              await mkdir(path.dirname(abs(repoRoot, credsRef)), { recursive: true });
              await writeFile(
                path.join(repoRoot, credsRef),
                JSON.stringify({ username: body.auth.username, password: body.auth.password, loginUrl: body.auth.loginUrl }, null, 2),
                { encoding: "utf-8", mode: 0o600 },
              );
            }
            const job = await startExploration(newProjectId, url.href, body.focus, body.maxNewPages, credsRef);
            return sendJson(res, 202, { job: publicJob(job) });
          }

          if (!projectId) return sendJson(res, 405, { error: "Method not allowed" });
          const job = getJob("explore", projectId);

          if (!action && req.method === "GET") return sendJson(res, 200, { job: publicJob(job) });

          if (action === "cancel" && req.method === "POST") {
            if (!job || job.state !== "running") return sendJson(res, 409, { error: "No exploration in progress" });
            cancelAgentJob(job);
            return sendJson(res, 202, { job: publicJob(job) });
          }

          if (action === "live.mjpeg" && req.method === "GET") {
            const live = liveBrowsers.get(projectId);
            startMjpeg(res);
            if (live) return live.addViewer(res);
            // Run over: show where it ended, then close the stream.
            const last = lastFrames.get(projectId);
            if (last) writeFrame(res, last);
            return res.end();
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-explore-api] ${req.method} ${req.url} failed: ${(err as Error).message}`);
          return sendJson(res, 500, { error: "Exploration request failed" });
        }
      });

      // Triage: GET/POST /api/projects/<id>/runs/<runId>/triage, GET /triage/job, POST /triage/job/cancel,
      // POST /triage/<recordId>/(apply|reject|verify).
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const url = (req.url ?? "/").split("?")[0];
        const runRoute = /^\/([a-z0-9-]{1,80})\/runs\/([0-9]{8}-[0-9]{6}-[a-z0-9]{4})\/triage\/?$/.exec(url);
        const jobRoute = /^\/([a-z0-9-]{1,80})\/triage\/job(?:\/(cancel))?\/?$/.exec(url);
        const recordRoute = /^\/([a-z0-9-]{1,80})\/triage\/([0-9]{8}-[0-9]{6}-[a-z0-9]{4}__\d{1,4})\/(apply|reject|verify)\/?$/.exec(url);
        const projectId = (runRoute ?? jobRoute ?? recordRoute)?.[1];
        if (!projectId) return next();
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });
        try {
          if (!(await loadMap(repoRoot, projectId))) return sendJson(res, 404, { error: "Project not found" });
          const job = getJob("triage", projectId);

          if (runRoute && req.method === "GET") {
            return sendJson(res, 200, { ...(await triageOverview(repoRoot, projectId, runRoute[2])), job: publicJob(job?.meta.runId === runRoute[2] ? job : undefined) });
          }
          if (runRoute && req.method === "POST") {
            const parsed = TriageBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid request" });
            const overview = await triageOverview(repoRoot, projectId, runRoute[2]);
            const failing = new Set(overview.failures.map((f) => f.testIndex));
            if (parsed.data.testIndexes.some((i) => !failing.has(i))) return sendJson(res, 400, { error: "Only failed tests can be triaged" });
            const busy = busyReason(projectId);
            if (busy) return sendJson(res, 409, { error: busy });
            const started = await startTriage(projectId, runRoute[2], parsed.data.testIndexes, parsed.data.allowDestructive);
            return sendJson(res, 202, { job: publicJob(started) });
          }
          if (jobRoute && !jobRoute[2] && req.method === "GET") return sendJson(res, 200, { job: publicJob(job) });
          if (jobRoute && jobRoute[2] === "cancel" && req.method === "POST") {
            if (!job || job.state !== "running") return sendJson(res, 409, { error: "No triage in progress" });
            cancelAgentJob(job);
            return sendJson(res, 202, { job: publicJob(job) });
          }
          if (recordRoute && req.method === "POST") {
            const record = await loadTriageRecord(repoRoot, projectId, recordRoute[2]);
            if (!record) return sendJson(res, 404, { error: "Verdict not found" });
            if (runningJobForProject(projectId)) return sendJson(res, 409, { error: "An agent is running on this project — wait for it to finish" });
            if (recordRoute[3] === "reject") {
              const updated = { ...record, status: "rejected" as const, decidedAt: new Date().toISOString() };
              await saveTriageRecord(repoRoot, projectId, updated);
              return sendJson(res, 200, { record: updated });
            }
            if (recordRoute[3] === "verify") {
              const body = z.object({ allowDestructive: z.boolean().default(false) }).safeParse(await readJsonBody(req));
              const updated = await verifyTriageRecord(repoRoot, projectId, { ...record, verification: undefined }, body.success ? body.data.allowDestructive : false, () => undefined);
              return sendJson(res, 200, { record: updated });
            }
            const applied = await applyTriageRecord(repoRoot, projectId, record);
            return applied.ok ? sendJson(res, 200, { record: applied.record }) : sendJson(res, 409, { error: applied.error });
          }
          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-triage-api] ${req.method} ${req.url} failed: ${(err as Error).message}`);
          return sendJson(res, 500, { error: "Triage request failed" });
        }
      });

      // Design cases: POST /api/projects/<id>/design, GET /design/job, POST /design/job/cancel.
      // Its live view streams through /api/explorations/<id>/live.mjpeg like an exploration's.
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const m = /^\/([a-z0-9-]{1,80})\/design(?:\/(job)(?:\/(cancel))?)?\/?$/.exec((req.url ?? "/").split("?")[0]);
        if (!m) return next();
        const [, projectId, sub, action] = m;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });
        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });
          const job = getJob("design", projectId);

          if (!sub && req.method === "POST") {
            const parsed = DesignBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid request", details: z.prettifyError(parsed.error) });
            if (parsed.data.pageId && !map.pages[parsed.data.pageId]) return sendJson(res, 400, { error: "Unknown page" });
            const org = parsed.data.useCaseId ? await loadOrganization(repoRoot, projectId) : null;
            const target = org && parsed.data.useCaseId ? findUseCase(org, parsed.data.useCaseId) : undefined;
            if (parsed.data.useCaseId && !target) return sendJson(res, 400, { error: "Unknown use case" });
            const requirement = parsed.data.requirementId ? (await loadRequirements(repoRoot, projectId)).requirements.find((r) => r.id === parsed.data.requirementId) : undefined;
            if (parsed.data.requirementId && !requirement) return sendJson(res, 400, { error: "Unknown requirement" });
            const busy = busyReason(projectId);
            if (busy) return sendJson(res, 409, { error: busy });
            const started = await startDesign(
              projectId,
              parsed.data.pageId,
              parsed.data.request,
              target ? { id: target.useCase.id, title: target.useCase.title } : undefined,
              requirement ? { id: requirement.id, title: requirement.key ?? requirement.title } : undefined,
            );
            return sendJson(res, 202, { job: publicJob(started) });
          }
          if (sub === "job" && !action && req.method === "GET") return sendJson(res, 200, { job: publicJob(job) });
          if (sub === "job" && action === "cancel" && req.method === "POST") {
            if (!job || job.state !== "running") return sendJson(res, 409, { error: "No design run in progress" });
            cancelAgentJob(job);
            return sendJson(res, 202, { job: publicJob(job) });
          }
          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-design-api] ${req.method} ${req.url} failed: ${(err as Error).message}`);
          return sendJson(res, 500, { error: "Design request failed" });
        }
      });

      // Explore more on an existing project: POST /api/projects/<id>/explore
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const m = /^\/([a-z0-9-]{1,80})\/explore\/?$/.exec(req.url ?? "/");
        if (!m) return next();
        const [, projectId] = m;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });
        if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });
          const parsed = ExploreMoreBody.safeParse(await readJsonBody(req));
          if (!parsed.success) return sendJson(res, 400, { error: "Invalid request", details: z.prettifyError(parsed.error) });
          const busy = busyReason(projectId);
          if (busy) return sendJson(res, 409, { error: busy });

          let credsRef: string | undefined;
          if (parsed.data.userId) {
            const user = (await loadProjectUsers(repoRoot, map)).find((u) => u.id === parsed.data.userId);
            if (!user) return sendJson(res, 404, { error: "User not found" });
            if (user.kind === "auth") {
              if (!user.credentialsRef) return sendJson(res, 400, { error: "That user has no credentials — set them in the Users tab" });
              credsRef = user.credentialsRef;
            }
          }
          const entry = map.entryPageId ? map.pages[map.entryPageId]?.sampleUrls[0] : undefined;
          const baseUrl = entry ?? `https://${map.targetHost}/`;
          const job = await startExploration(projectId, baseUrl, parsed.data.focus, parsed.data.maxNewPages, credsRef);
          return sendJson(res, 202, { job: publicJob(job) });
        } catch (err) {
          console.error(`[navmap-explore-api] explore ${projectId} failed: ${(err as Error).message}`);
          return sendJson(res, 500, { error: "Could not start the exploration" });
        }
      });
    },
  };
}
