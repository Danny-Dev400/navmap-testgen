// Client-side mirror of app/plugins/navmapStatesApi.ts + src/navmap-states-view.ts.
import type { CaseStep, StateKind } from "./casesClient";

export interface RawState {
  id: string;
  title: string;
  description?: string;
  kind: StateKind;
  flow?: CaseStep[];
  perItem?: boolean;
  userId?: string;
  requires?: string[];
  notAutomatable?: { reason: string };
  note?: string;
  origin: "migrated" | "agent" | "manual" | "answer";
  createdAt: string;
  updatedAt: string;
}

export interface RawBinding {
  edgeId: string;
  precondition: string;
  stateId: string;
  sameItem?: boolean;
}

export type StateStatus = "ok" | "needs_answer" | "cant_run_here" | "not_automatable";

export interface StateView {
  id: string;
  title: string;
  description?: string;
  kind: StateKind;
  flow: { edgeId: string; intent: string; pageTitle: string; item: string | null; input: string | null; on: string | null }[];
  perItem: boolean;
  userId: string | null;
  userLabel: string | null;
  requires: { id: string; title: string }[];
  notAutomatable: { reason: string } | null;
  note: string | null;
  origin: RawState["origin"];
  updatedAt: string;
  status: StateStatus;
  cantRunOn: { pageId: string; pageTitle: string; reason: string }[];
  usedBy: {
    actions: { edgeId: string; intent: string; pageTitle: string; precondition: string; sameItem: boolean; canShareItem: boolean }[];
    cases: { id: string; title: string; status: "draft" | "approved" | "rejected"; runnable: boolean }[];
  };
  blocking: number;
}

export type Answer =
  | { kind: "initial" }
  | { kind: "flow"; steps: CaseStep[]; stateKind?: "transient" | "persistent"; perItem?: boolean }
  | { kind: "sameAs"; stateId: string; sameItem?: boolean }
  | { kind: "user"; userId: string }
  | { kind: "notAutomatable"; reason: string }
  | { kind: "text"; text: string }
  | { kind: "dismiss" };

export interface QuestionView {
  key: string;
  source: "derived" | "agent";
  askedBy: "linker" | "designer" | "planner";
  questionId: string | null;
  stateId: string | null;
  issue: "no_flow" | "cant_run_here" | "free";
  title: string;
  detail: string;
  suggestions: { label: string; answer: Answer }[];
  blocking: number;
  createdAt: string | null;
}

export interface StatesData {
  derivedFromLinks: boolean;
  updatedAt: string | null;
  states: StateView[];
  unbound: { edgeId: string; intent: string; pageTitle: string; precondition: string }[];
  stale: RawBinding[];
  questions: QuestionView[];
  answeredCount: number;
  users: { id: string; label: string; kind: "guest" | "auth" }[];
  /** The raw graph, for whole-graph edits. */
  graph: { states: RawState[]; bindings: RawBinding[] };
  regeneration?: { at: string; filesChanged: number; testsChanged: number } | null;
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/states`;

async function call(url: string, init?: RequestInit): Promise<StatesData> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const statesApi = {
  load: (projectId: string) => call(base(projectId)),
  save: (projectId: string, graph: { states: RawState[]; bindings: RawBinding[] }, baseUpdatedAt: string | null) => call(base(projectId), json("PUT", { ...graph, baseUpdatedAt })),
  answer: (projectId: string, body: { stateId?: string; questionId?: string; answer: Answer }) => call(`${base(projectId)}/answer`, json("POST", body)),
  bind: (projectId: string, body: { edgeId: string; precondition: string; stateId: string | null; sameItem?: boolean }) => call(`${base(projectId)}/binding`, json("POST", body)),
};

export const STATUS_LABEL: Record<StateStatus, string> = {
  ok: "✓ ready",
  needs_answer: "❓ needs an answer",
  cant_run_here: "⚠ can't run everywhere it's needed",
  not_automatable: "⛔ can't be automated",
};

export function newStateId(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug =
    title
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "") || "state";
  let id = slug;
  for (let i = 2; used.has(id); i++) id = `${slug}-${i}`;
  return id;
}
