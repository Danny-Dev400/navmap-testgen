// Client-side mirror of app/plugins/navmapRunsApi.ts — the shapes the runs endpoints return.

export type TestStatus = "passed" | "failed" | "flaky" | "skipped" | "fixme";

export interface RunTest {
  /** Filled by the server for old runs too (their action's baseline case). */
  caseId: string | null;
  /** The case's last step's action. */
  edgeId: string | null;
  row?: string | null;
  /** The test.step() that failed, when the test has steps. */
  failedStep?: string | null;
  title: string;
  file: string;
  line: number;
  browser: string;
  status: TestStatus;
  durationMs: number;
  error: string | null;
  artifacts: { trace: string | null; video: string | null; screenshots: string[] };
}

export interface RunSummary {
  runId: string;
  scope: { kind: "project" | "page" | "case" | "feature" | "useCase" | "cases" | "suite" | "edge"; label: string; includeDestructive: boolean };
  startedAt: string;
  finishedAt: string;
  state: "finished" | "cancelled" | "error";
  counts: Record<TestStatus, number>;
  tests: RunTest[];
}

export interface LiveRun {
  runId: string;
  scope: RunSummary["scope"];
  state: "running" | "finished" | "cancelled" | "error";
  startedAt: string;
  log: string[];
}

export type LatestEntry = { status: TestStatus; runId: string; at: string };
/** Newest result per case, and per action (worst of the cases that step through it). */
export type LatestStatus = { cases: Record<string, LatestEntry>; edges: Record<string, LatestEntry> };
export const EMPTY_LATEST: LatestStatus = { cases: {}, edges: {} };

export type RunRequest =
  | { scope: "project"; includeDestructive?: boolean }
  | { scope: "page"; pageId: string; includeDestructive?: boolean }
  | { scope: "case"; caseId: string }
  | { scope: "feature"; featureId: string; includeDestructive?: boolean }
  | { scope: "useCase"; useCaseId: string; includeDestructive?: boolean }
  /** Hand-picked cases / a saved suite: destructive ones run too (they were picked explicitly). */
  | { scope: "cases"; caseIds: string[] }
  | { scope: "suite"; suiteId: string };

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/runs`;

/** Starts a run; resolves to an error message (e.g. one already in progress) or null. */
export async function startRun(projectId: string, request: RunRequest): Promise<string | null> {
  const res = await fetch(base(projectId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  if (res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return body.error ?? `${res.status}`;
}

export async function fetchRuns(projectId: string): Promise<{ runs: RunSummary[]; current: LiveRun | null }> {
  const res = await fetch(base(projectId));
  return res.json();
}

export async function fetchLatestStatus(projectId: string): Promise<LatestStatus> {
  const res = await fetch(`${base(projectId)}/latest-status`);
  return res.ok ? res.json() : EMPTY_LATEST;
}

export async function cancelRun(projectId: string, runId: string) {
  await fetch(`${base(projectId)}/${runId}/cancel`, { method: "POST" });
}

export async function openTrace(projectId: string, runId: string, testIndex: number): Promise<string | null> {
  const res = await fetch(`${base(projectId)}/${runId}/trace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ testIndex }) });
  return res.ok ? null : ((await res.json().catch(() => ({}))).error ?? `${res.status}`);
}

export const STATUS_ICON: Record<TestStatus | "never", string> = {
  passed: "✓",
  failed: "✗",
  flaky: "≈",
  skipped: "⤼",
  fixme: "…",
  never: "·",
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
