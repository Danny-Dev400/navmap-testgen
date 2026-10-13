import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { abs, projectPaths } from "../../src/project-paths";

/** Background Claude Code agent runs (`claude -p`) launched by the dashboard: the precondition
 *  linker and the map explorer. They use the user's Claude subscription quota, not API billing —
 *  `costUsd` is Claude Code's own *estimate* at API prices, shown for reference. */

export type AgentJobKind = "link" | "explore" | "design" | "triage" | "organize" | "analyze";
export type AgentJobState = "running" | "succeeded" | "failed" | "cancelled";

export interface AgentJob {
  key: string;
  kind: AgentJobKind;
  projectId: string;
  label: string;
  state: AgentJobState;
  startedAt: string;
  finishedAt?: string;
  model?: string;
  costUsd?: number;
  summary?: string;
  log: string[];
  /** Kind-specific public details (e.g. { verify } for links, { baseUrl, liveView } for explore). */
  meta: Record<string, unknown>;
  /** Why the run ended early when it wasn't the agent's own choice — shown instead of a generic failure. */
  stopReason?: "usage_limit";
  /** When the plan's usage window resets, if the CLI reported it (ISO time). */
  usageResetsAt?: string;
  // ---- private ----
  child?: ChildProcess;
  cancelRequested?: boolean;
  secrets: string[];
}

export interface AgentRunOptions {
  kind: AgentJobKind;
  projectId: string;
  label: string;
  meta?: Record<string, unknown>;
  cwd: string;
  prompt: string;
  model: string;
  budgetUsd: number;
  allowedTools: string[];
  deniedTools?: string[];
  mcpConfig?: { mcpServers: Record<string, unknown> };
  /** Strings that must never appear in the log (e.g. the password used this run). */
  secrets?: string[];
  /** Always runs once the agent process exits, whatever the outcome (cleanup lives here). */
  onExit?: (job: AgentJob) => void | Promise<void>;
}

/** Reads denied to every agent run: other projects' credentials and local secrets. A run that needs
 *  credentials gets a per-run copy in its own project's .staging/ instead. Verified empirically that these
 *  rules also block Grep over the folder. */
export const SECRET_READ_DENIALS = [
  "Read(./projects/**/credentials/**)",
  // Saved sessions (storageState) are bearer tokens for the site — as sensitive as a password.
  "Read(./projects/**/.auth/**)",
  "Read(./credentials/**)", // legacy top-level credentials files left from before projects/
  "Read(./.env*)",
  "Read(**/*.pem)",
];

/** On Windows the agent reaches for PowerShell before Bash (observed); allow each command via both. */
export function shellCommands(commands: string[]): string[] {
  return commands.flatMap((c) => [`Bash(${c})`, `PowerShell(${c})`]);
}

// Tools whose inputs carry typed values (passwords included) — logged by name only.
const SENSITIVE_INPUT_TOOL = /browser_type|browser_fill_form|browser_press_key/;
const LOG_CAP = 300;

const jobs = new Map<string, AgentJob>();

export function jobKey(kind: AgentJobKind, projectId: string): string {
  return `${kind}:${projectId}`;
}

export function getJob(kind: AgentJobKind, projectId: string): AgentJob | undefined {
  return jobs.get(jobKey(kind, projectId));
}

export function listJobs(kind?: AgentJobKind): AgentJob[] {
  return [...jobs.values()].filter((j) => !kind || j.kind === kind);
}

/** Any running agent on this project, of any kind — a map shouldn't be explored and linked at once. */
export function runningJobForProject(projectId: string): AgentJob | undefined {
  return [...jobs.values()].find((j) => j.projectId === projectId && j.state === "running");
}

export function runningJobs(kind: AgentJobKind): AgentJob[] {
  return [...jobs.values()].filter((j) => j.kind === kind && j.state === "running");
}

export function publicJob(job: AgentJob | undefined) {
  if (!job) return null;
  const { child: _c, cancelRequested: _r, secrets: _s, log, ...rest } = job;
  return { ...rest, log: log.slice(-80) };
}

function redact(job: AgentJob, text: string): string {
  let out = text;
  for (const s of job.secrets) if (s) out = out.split(s).join("***");
  return out;
}

export function pushLog(job: AgentJob, line: string) {
  const clean = redact(job, line).replace(/\s+/g, " ").trim();
  if (!clean) return;
  job.log.push(clean.length > 300 ? `${clean.slice(0, 300)}…` : clean);
  if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
}

function toolDetail(name: string, input: any): string {
  if (SENSITIVE_INPUT_TOOL.test(name)) return "";
  return String(input?.command ?? input?.url ?? input?.file_path ?? input?.element ?? input?.pattern ?? "");
}

// Claude Code injects this instruction when the subscription's usage window is nearly spent; the
// agent then stops after a short checkpoint (observed: a /navmap run that never opened the browser).
const USAGE_CHECKPOINT_RE = /usage limit approaching/i;
// Fallback when only the agent's reply is seen: the checkpoint's required shape.
const CHECKPOINT_REPLY_RE = /^\s*\**checkpoint\**:[\s\S]*remaining work/i;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: any) => (typeof b?.text === "string" ? b.text : typeof b?.content === "string" ? b.content : "")).join("\n");
}

/** Normalizes a reset time the CLI may report as epoch seconds, epoch ms or an ISO string. */
function toIso(value: unknown): string | undefined {
  if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

export function usageLimitSummary(job: AgentJob): string {
  const when = job.usageResetsAt ? ` It resets around ${new Date(job.usageResetsAt).toLocaleString()}.` : "";
  return (
    "Stopped early: your Claude plan's usage limit was nearly reached, so Claude Code told the agent to wrap up " +
    `before doing the work. Nothing is broken.${when} Wait for the usage window to reset (see claude.ai → Settings → Usage), ` +
    "then run it again — a focus or a smaller page limit uses less of the plan."
  );
}

function markUsageLimit(job: AgentJob) {
  if (job.stopReason === "usage_limit") return;
  job.stopReason = "usage_limit";
  pushLog(job, "⚠ Your Claude plan's usage limit is nearly reached — the agent was told to wrap up early.");
}

export function handleEvent(job: AgentJob, event: any) {
  if (event.type === "rate_limit_event") {
    // Usage-window info from the CLI. Only status/reset fields are logged — nothing sensitive in it.
    const info = event.rate_limit_info ?? event;
    const status = String(info.status ?? info.type ?? "");
    const resetsAt = toIso(info.resetsAt ?? info.resets_at ?? info.reset_at);
    if (resetsAt) job.usageResetsAt = resetsAt;
    pushLog(job, `ℹ plan usage: ${status || "update"}${resetsAt ? ` · resets ${new Date(resetsAt).toLocaleString()}` : ""}`);
    // A warning alone doesn't stop the run — only an actual rejection does. The checkpoint the agent
    // is then told to write is caught separately (user message / reply shape).
    if (/reject|exceed|limit_reached|blocked/i.test(status)) markUsageLimit(job);
    return;
  }
  if (event.type === "user" && USAGE_CHECKPOINT_RE.test(textOf(event.message?.content))) {
    markUsageLimit(job);
    return;
  }
  if (event.type === "system" && event.subtype !== "init" && event.subtype !== "permission_denied") {
    // Anything else the CLI reports (e.g. retries, compaction) — just the subtype, never payloads.
    pushLog(job, `ℹ ${String(event.subtype ?? "system event")}`);
    return;
  }
  if (event.type === "system" && event.subtype === "init") {
    job.model = event.model;
    pushLog(job, `Model: ${event.model}`);
  } else if (event.type === "assistant") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "text") pushLog(job, block.text);
      if (block.type === "tool_use") pushLog(job, `→ ${String(block.name).replace(/^mcp__playwright__/, "")} ${toolDetail(block.name, block.input)}`);
    }
  } else if (event.type === "system" && event.subtype === "permission_denied") {
    pushLog(job, "⛔ a tool call was denied (outside this agent's allowed tools)");
  } else if (event.type === "result") {
    job.costUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : job.costUsd;
    job.summary = typeof event.result === "string" ? redact(job, event.result) : undefined;
    if (typeof event.result === "string" && CHECKPOINT_REPLY_RE.test(event.result)) markUsageLimit(job);
    if (event.subtype !== "success") pushLog(job, `Agent stopped: ${event.subtype}`);
  }
}

/** Starts a hardened headless run. Callers check locks first (runningJobForProject / runningJobs).
 *  Hardening, verified empirically:
 *  - --setting-sources user,project: loads the project's skills but NOT .claude/settings.local.json,
 *    whose broad allows (`npm run *`, `npx tsx *`) would otherwise be inherited.
 *  - --strict-mcp-config + an explicit --mcp-config: only the MCP servers we pass.
 *  - an explicit tool allowlist plus SECRET_READ_DENIALS. */
export function startAgentJob(opts: AgentRunOptions): AgentJob {
  const job: AgentJob = {
    key: jobKey(opts.kind, opts.projectId),
    kind: opts.kind,
    projectId: opts.projectId,
    label: opts.label,
    state: "running",
    startedAt: new Date().toISOString(),
    log: [],
    meta: opts.meta ?? {},
    secrets: opts.secrets ?? [],
  };
  jobs.set(job.key, job);

  const args = [
    "-p",
    opts.prompt,
    "--model",
    opts.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    String(opts.budgetUsd),
    "--setting-sources",
    "user,project",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(opts.mcpConfig ?? { mcpServers: {} }),
    "--allowedTools",
    ...opts.allowedTools,
    "--disallowedTools",
    ...SECRET_READ_DENIALS,
    ...(opts.deniedTools ?? []),
  ];
  // claude is a native executable here, so no shell: arguments pass verbatim. stdin closed, or
  // `claude -p` waits 3s for piped input first.
  const child = spawn("claude", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
  job.child = child;
  pushLog(job, `Started ${opts.label}`);

  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleEvent(job, JSON.parse(line));
      } catch {
        pushLog(job, line);
      }
    }
  });
  child.stderr!.on("data", (chunk) => pushLog(job, `stderr: ${chunk.toString()}`));

  let finished = false;
  const finish = async (state: AgentJobState) => {
    if (finished) return;
    finished = true;
    job.child = undefined;
    job.finishedAt = new Date().toISOString();
    job.state = job.cancelRequested ? "cancelled" : state;
    try {
      await opts.onExit?.(job);
    } catch (err) {
      pushLog(job, `Cleanup error: ${(err as Error).message}`);
    }
    await recordUsage(opts.cwd, job).catch(() => undefined);
    if (job.stopReason === "usage_limit") {
      // The agent's own reply is just its checkpoint notes — replace it with what the user needs to know.
      job.summary = usageLimitSummary(job);
      if (job.state === "succeeded") job.state = "failed";
    }
    pushLog(job, `Finished: ${job.state}${job.costUsd !== undefined ? ` · estimated $${job.costUsd.toFixed(2)}` : ""}`);
  };
  child.on("error", (err) => {
    pushLog(job, `Could not start claude: ${err.message}`);
    void finish("failed");
  });
  child.on("close", (code) => void finish(code === 0 ? "succeeded" : "failed"));
  return job;
}

/** Kills the whole process tree — the agent spawns npm/tsx/node and the MCP server below it. */
/** Local accounting for the project card's cumulative quota estimate: one line per finished agent
 *  run — kind, time, model, estimated cost. Never the prompt or any output. Skipped when the run
 *  left no project folder (e.g. a new-project exploration that failed before writing a map). */
async function recordUsage(repoRoot: string, job: AgentJob) {
  if (job.costUsd === undefined) return;
  const paths = projectPaths(job.projectId);
  if (!existsSync(abs(repoRoot, paths.dir))) return;
  const line = JSON.stringify({ kind: job.kind, at: job.finishedAt, model: job.model ?? null, costUsd: job.costUsd, state: job.state });
  await appendFile(abs(repoRoot, paths.agentUsage), `${line}\n`, "utf-8");
}

export function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  }
}

export function cancelAgentJob(job: AgentJob) {
  if (job.state !== "running" || !job.child?.pid) return;
  job.cancelRequested = true;
  killTree(job.child.pid);
}
