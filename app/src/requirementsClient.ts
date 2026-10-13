import type { LatestEntry } from "./runsClient";

/** Mirror of src/navmap-requirements.ts + the API's computed statuses. */
export type CriterionStatus = "uncovered" | "draft" | "fixme" | "not_run" | "failing" | "passing";

export interface LinkedCase {
  id: string;
  title: string;
  status: "draft" | "approved" | "rejected";
  runnable: boolean;
  last: LatestEntry | null;
}

export interface CriterionView {
  id: string;
  text: string;
  caseIds: string[];
  status: CriterionStatus;
  cases: LinkedCase[];
}

export interface AnalysisView {
  requirementId: string;
  createdAt: string;
  summary?: string;
  useCaseId?: string;
  criteria: { id?: string; text: string; caseIds: string[]; why?: string }[];
}

export interface RequirementView {
  id: string;
  key?: string;
  title: string;
  text: string;
  useCaseId?: string;
  criteria: CriterionView[];
  source: "pasted" | "imported";
  createdAt: string;
  updatedAt: string;
  status: CriterionStatus;
  analysis: AnalysisView | null;
}

export interface AnalystJob {
  state: "running" | "succeeded" | "failed" | "cancelled";
  stopReason?: "usage_limit";
  meta: { requirementId?: string; request?: string | null; proposal?: boolean };
  startedAt: string;
  finishedAt?: string;
  model?: string;
  costUsd?: number;
  summary?: string;
  log: string[];
}

export interface RequirementsData {
  updatedAt: string | null;
  requirements: RequirementView[];
  summary: { requirements: number; criteria: number; covered: number; failing: number; passing: number };
  useCases: { id: string; title: string; feature: string }[];
  cases: { id: string; title: string; status: "draft" | "approved" | "rejected" }[];
  job: AnalystJob | null;
}

export interface ParsedRequirement {
  key?: string;
  title: string;
  text: string;
  criteria: string[];
}

export interface CriterionInput {
  id?: string;
  text: string;
  caseIds: string[];
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/requirements`;

async function call<T = RequirementsData>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const requirementsApi = {
  load: (projectId: string) => call(base(projectId)),
  create: (projectId: string, text: string, title?: string) => call<RequirementsData & { createdIds: string[] }>(base(projectId), json("POST", { text, ...(title ? { title } : {}) })),
  preview: (projectId: string, text: string, format: "markdown" | "csv") => call<{ preview: ParsedRequirement[] }>(`${base(projectId)}/import`, json("POST", { text, format, dryRun: true })),
  importFile: (projectId: string, text: string, format: "markdown" | "csv") => call<RequirementsData & { createdIds: string[] }>(`${base(projectId)}/import`, json("POST", { text, format })),
  update: (
    projectId: string,
    id: string,
    body: { title?: string; key?: string | null; text?: string; useCaseId?: string | null; criteria?: CriterionInput[]; baseUpdatedAt?: string | null },
  ) => call(`${base(projectId)}/${encodeURIComponent(id)}`, json("PUT", body)),
  remove: (projectId: string, id: string) => call(`${base(projectId)}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  analyze: (projectId: string, id: string, request?: string) => call<{ job: AnalystJob }>(`${base(projectId)}/${encodeURIComponent(id)}/analyze`, json("POST", { ...(request ? { request } : {}) })),
  job: (projectId: string) => call<{ job: AnalystJob | null }>(`${base(projectId)}/job`),
  cancelJob: (projectId: string) => call<{ job: AnalystJob }>(`${base(projectId)}/job/cancel`, { method: "POST" }),
  accept: (projectId: string, id: string) => call(`${base(projectId)}/${encodeURIComponent(id)}/proposal/accept`, { method: "POST" }),
  discard: (projectId: string, id: string) => call(`${base(projectId)}/${encodeURIComponent(id)}/proposal/discard`, { method: "POST" }),
};

export const matrixUrl = (projectId: string, format: "markdown" | "csv", download = false) => `${base(projectId)}/matrix?format=${format}${download ? "&download=1" : ""}`;

/** As a criterion's glyph / words. */
export const CRITERION_LABEL: Record<CriterionStatus, string> = {
  passing: "Passing",
  failing: "Failing",
  not_run: "Not run yet",
  fixme: "Can't run yet",
  draft: "Only draft cases",
  uncovered: "No test case",
};
