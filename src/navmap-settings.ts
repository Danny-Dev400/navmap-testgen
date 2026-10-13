import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { abs, projectPaths } from "./project-paths.js";

/** Models an agent run may use. An enum, never free text: the value becomes a `claude -p --model`
 *  argument. Opus 5.5 is left out until the CLI is updated (`claude update`, needs >= 2.1.280). */
export const AGENT_MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "Default. Same linking judgments as Opus at about half the quota and time (2026-10-06 eval)." },
  { id: "opus", label: "Opus 5", note: "Highest quality, roughly 2x the quota of Sonnet." },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "Cheapest, but made a factual linking error in 1 of 2 eval runs." },
] as const;
export type AgentModelId = (typeof AGENT_MODELS)[number]["id"];
const AgentModel = z.enum(AGENT_MODELS.map((m) => m.id) as [AgentModelId, ...AgentModelId[]]);

const BROWSERS = ["chromium", "firefox", "webkit"] as const;
// 0 means "no limit" for action/navigation, matching Playwright's own convention.
const timeoutMs = (def: number, min: number) => z.number().int().min(min).max(600_000).default(def);

export const ExecutionSettingsSchema = z.object({
  browsers: z.array(z.enum(BROWSERS)).min(1).max(3).default(["chromium"]),
  headless: z.boolean().default(true),
  viewport: z
    .object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(240).max(2160) })
    .default({ width: 1280, height: 720 }),
  testTimeoutMs: timeoutMs(30_000, 1_000),
  expectTimeoutMs: timeoutMs(5_000, 100),
  actionTimeoutMs: timeoutMs(0, 0),
  navigationTimeoutMs: timeoutMs(0, 0),
  retries: z.number().int().min(0).max(5).default(0),
  workers: z.union([z.literal("auto"), z.number().int().min(1).max(16)]).default("auto"),
  trace: z.enum(["off", "on", "retain-on-failure", "on-first-retry"]).default("retain-on-failure"),
  screenshot: z.enum(["off", "on", "only-on-failure"]).default("only-on-failure"),
  video: z.enum(["off", "on", "retain-on-failure"]).default("off"),
  // Auth fixtures log in again when a saved session is older than this (or a cookie expired).
  sessionMaxAgeMinutes: z.number().int().min(1).max(1440).default(30),
});

export const AgentSettingsSchema = z.object({
  // Budgets cap Claude Code's cost *estimate*; on a subscription it's plan quota, not money.
  explorer: z
    .object({
      model: AgentModel.default("claude-sonnet-5-5"),
      budgetUsd: z.number().min(1).max(50).default(25),
      defaultMaxNewPages: z.number().int().min(1).max(50).default(25),
    })
    .prefault({}),
  // A trivial headless prompt already costs ~$0.30 (context load), hence the floor.
  linker: z
    .object({
      model: AgentModel.default("claude-sonnet-5-5"),
      budgetUsd: z.number().min(0.5).max(20).default(5),
    })
    .prefault({}),
  // Triage agent: classifies a failed test and proposes a fix in the right layer (map or case).
  triager: z
    .object({
      model: AgentModel.default("claude-sonnet-5-5"),
      budgetUsd: z.number().min(1).max(20).default(5),
    })
    .prefault({}),
  // Test-design agent: reads the map + snapshots, opens the browser only to verify or observe.
  designer: z
    .object({
      model: AgentModel.default("claude-sonnet-5-5"),
      budgetUsd: z.number().min(1).max(30).default(8),
    })
    .prefault({}),
  // Organizer: groups cases into features → use cases from the map and the cases (text only, no browser).
  organizer: z
    .object({
      model: AgentModel.default("claude-sonnet-5-5"),
      budgetUsd: z.number().min(0.5).max(10).default(2),
    })
    .prefault({}),
  // Analyst: splits a requirement into acceptance criteria and links existing cases (text only, no browser).
  analyst: z
    .object({
      model: AgentModel.default("claude-sonnet-5-5"),
      budgetUsd: z.number().min(0.5).max(5).default(1),
    })
    .prefault({}),
});

/** Every field defaults, so a partial or missing file is still a complete config. */
export const ProjectSettingsSchema = z.object({
  execution: ExecutionSettingsSchema.prefault({}),
  agents: AgentSettingsSchema.prefault({}),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const DEFAULT_SETTINGS: ProjectSettings = ProjectSettingsSchema.parse({});

/** projects/<id>/settings.json — committed, it holds no secrets. */
export function settingsPath(rootDir: string, projectId: string): string {
  return abs(rootDir, projectPaths(projectId).settings);
}

/** Defaults for a missing file; throws on one that exists but is invalid. */
export async function loadProjectSettings(rootDir: string, projectId: string): Promise<ProjectSettings> {
  try {
    return ProjectSettingsSchema.parse(JSON.parse(await readFile(settingsPath(rootDir, projectId), "utf-8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    throw err;
  }
}

/** For playwright.config.ts, which loads synchronously. An invalid file only warns: one bad file
 *  must not stop every other project's tests from running. */
export function loadProjectSettingsSync(rootDir: string, projectId: string): ProjectSettings {
  const file = settingsPath(rootDir, projectId);
  if (!existsSync(file)) return DEFAULT_SETTINGS;
  try {
    return ProjectSettingsSchema.parse(JSON.parse(readFileSync(file, "utf-8")));
  } catch (err) {
    console.warn(`[navmap-settings] ${file} is invalid, using defaults: ${err instanceof Error ? err.message : err}`);
    return DEFAULT_SETTINGS;
  }
}

export async function saveProjectSettings(rootDir: string, projectId: string, settings: ProjectSettings): Promise<void> {
  const file = settingsPath(rootDir, projectId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2), "utf-8");
}

/** One Playwright project per selected browser. Named after the project id alone when there's a
 *  single browser, so `--project=<id>` keeps working for the common case. */
export function toPlaywrightProjects(projectId: string, settings: ProjectSettings, testDir: string) {
  const e = settings.execution;
  return e.browsers.map((browserName) => ({
    name: e.browsers.length === 1 ? projectId : `${projectId}-${browserName}`,
    testDir,
    timeout: e.testTimeoutMs,
    retries: e.retries,
    ...(e.workers === "auto" ? {} : { workers: e.workers }),
    expect: { timeout: e.expectTimeoutMs },
    // Read by the generated fixtures (testInfo.project.metadata) — not a Playwright option.
    metadata: { sessionMaxAgeMinutes: e.sessionMaxAgeMinutes },
    use: {
      browserName,
      headless: e.headless,
      viewport: e.viewport,
      actionTimeout: e.actionTimeoutMs,
      navigationTimeout: e.navigationTimeoutMs,
      trace: e.trace,
      screenshot: e.screenshot,
      video: e.video,
    },
  }));
}
