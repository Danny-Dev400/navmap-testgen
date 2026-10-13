// Client-side mirror of app/plugins/navmapCasesApi.ts — the shapes the cases endpoints return.

export type CaseStatus = "draft" | "approved" | "rejected";

/** Data rows: the case runs once per row; "{{column}}" in step values takes the row's value. */
export interface Dataset {
  columns: string[];
  rows: { name: string; values: Record<string, string> }[];
}

export interface CaseStep {
  edgeId: string;
  on?: string;
  item?: string;
  input?: string;
  form?: Record<string, string>;
  assert?: string[];
  expect?: Record<string, string | number>;
  /** Read page elements ("<pageId>#<elementId>") into named values after this step. */
  capture?: { element: string; item?: string; as: string }[];
  /** Checks on page elements after this step. */
  verify?: {
    element: string;
    item?: string;
    op: "equals" | "contains" | "visible" | "hidden";
    value?: string | number;
    equalsVar?: string;
    equalsSumOf?: string[];
  }[];
}

/** A readable page element (PageNode.elements), for showing captures/checks. */
export interface ElementView {
  ref: string;
  label: string;
  valueKind: "text" | "number" | "currency";
  perItem: string | null;
}

/** Checks whose expected literal a case can change (the locator stays the map's). */
export const hasEditableValue = (p: ActionView["postconditions"][number]) => p.checkKind === "has_text" || p.checkKind === "count";

export interface ActionView {
  id: string;
  fromPageId: string;
  toPageId: string;
  semanticIntent: string;
  intentCategory: string;
  action: string;
  target: string;
  inputValue?: string;
  /** The list item it was recorded on, when it acts on one of several identical elements. */
  item?: string;
  formFields?: { label: string; value: string }[];
  postconditions: {
    description: string;
    assertionType: string;
    checkKind?: "visible" | "hidden" | "has_text" | "url" | "count";
    /** The literal observed while exploring, for has_text/count checks. */
    checkValue?: string | number;
  }[];
  preconditions: string[];
  external?: { url: string; opensNewTab: boolean };
  isLogin: boolean;
  inComponent: boolean;
  destructive: boolean;
  destructiveSource: "agent" | "user" | null;
  screenshot?: string;
}

export interface SetupView {
  edgeId: string;
  semanticIntent: string;
  action: string;
  target: string;
  pageTitle: string;
  scope: "same-page" | "persistent";
  /** The list item this setup step acts on (when it acts on one). */
  item: string | null;
}

export type StateKind = "transient" | "persistent" | "initial" | "account";

export const STATE_KIND_LABEL: Record<StateKind, string> = {
  transient: "on the page",
  persistent: "persists",
  initial: "already true",
  account: "user",
};

/** A state a case asks for (TestCase.given). */
export interface Given {
  state: string;
  item?: string;
}

/** A state the test is put in before its steps, as planned — why, and its flow. */
export interface GivenChainView {
  stateId: string;
  title: string;
  kind: StateKind;
  item: string | null;
  via: { kind: "precondition"; edgeId: string; precondition: string; sameItem: boolean; action: string } | { kind: "requires"; from: string } | { kind: "given" };
  canShareItem: boolean;
  steps: { edgeId: string; semanticIntent: string; action: string; pageTitle: string; item: string | null }[];
}

export interface CaseView {
  id: string;
  title: string;
  status: CaseStatus;
  origin: "baseline" | "manual" | "agent";
  requires: string[];
  /** States the case asks for before its steps. */
  given?: Given[];
  steps: CaseStep[];
  dataset?: Dataset;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  health: "ok" | "needs_review";
  reasons: string[];
  runnable: boolean;
  blockers: string[];
  runAs: string | null;
  destructive: boolean;
  firstPageId: string | null;
  setup: SetupView[];
  /** The planned Given chain (the case's own given + what its first step's preconditions point to). */
  givenChain: GivenChainView[];
  requiredSteps: number;
}

export interface JourneyView {
  id: string;
  pages: string[];
  edges: string[];
  covered: boolean;
  coveredBy: string[];
  /** Share of its actions some approved case executes (0–1). */
  partial: number;
}

export interface PageView {
  id: string;
  title: string;
  urlPattern: string;
}

export interface CasesData {
  cases: CaseView[];
  /** Actions no case references. */
  uncovered: string[];
  pages: PageView[];
  actions: Record<string, ActionView>;
  /** pageId -> actions a step can use there (own ones, plus shared component actions with `on`). */
  available: Record<string, { edgeId: string; on?: string }[]>;
  /** "<pageId>#<elementId>" -> element. */
  elements: Record<string, ElementView>;
  /** End-to-end journeys through the map and which approved cases walk them. */
  journeys: JourneyView[];
  /** Approved cases executing each action. */
  edgeCoverage: Record<string, number>;
  /** Named states (projects/<id>/states.json, or converted in memory from precondition links). */
  states: { id: string; title: string; kind: StateKind; perItem: boolean }[];
  auth: { hasAuthUsers: boolean; usersNeedingSession: { id: string; label: string }[] };
  /** Features → use cases → cases (src/navmap-features.ts organizationView). */
  organization: OrganizationView;
  /** The organizer's pending proposal, if any. */
  proposal: ProposalView | null;
  /** Saved selections (projects/<id>/suites.json). */
  suites: { updatedAt: string | null; list: SuiteView[] };
  /** caseId -> the acceptance criteria it proves (requirements.json). */
  requirementsByCase: Record<string, { requirementId: string; key: string | null; title: string; criterionId: string; criterion: string }[]>;
  /** Requirements, as design scopes. */
  requirementList: { id: string; label: string; uncovered: number }[];
}

export interface SuiteView {
  id: string;
  name: string;
  description: string | null;
  /** Any status; only the approved ones run. */
  caseIds: string[];
  approved: number;
}

// ---- organization (mirror of src/navmap-features.ts) ----

export interface UseCaseDef {
  id?: string;
  title: string;
  description?: string;
  actions: string[];
  cases: string[];
}

export interface FeatureDef {
  id?: string;
  title: string;
  description?: string;
  useCases: UseCaseDef[];
}

export interface CaseFeatureInfo {
  featureId: string;
  featureTitle: string;
  useCaseId: string;
  useCaseTitle: string;
}

export interface UseCaseView {
  id: string;
  featureId: string;
  title: string;
  description?: string;
  actions: string[];
  cases: string[];
  approved: number;
  drafts: number;
  runnable: number;
  actionsExercised: string[];
  actionsWithoutCase: string[];
}

export interface FeatureView {
  id: string;
  title: string;
  description?: string;
  useCases: UseCaseView[];
}

export interface OrganizationView {
  exists: boolean;
  updatedAt: string | null;
  features: FeatureView[];
  unsorted: { caseId: string; suggestion: CaseFeatureInfo | null }[];
  unorganizedActions: string[];
  dropped: string[];
}

export interface OrganizationDiff {
  features: Record<string, "new" | "renamed">;
  useCases: Record<string, "new" | "renamed" | "moved">;
  cases: Record<string, "sorted" | "moved">;
  removedFeatures: { id: string; title: string }[];
  removedUseCases: { id: string; title: string; featureTitle: string }[];
  unsortedCases: string[];
  actionsAdded: number;
  summary: string;
}

export interface ProposalView {
  createdAt: string;
  rationale: string | null;
  request: string | null;
  features: { id: string; title: string; description?: string; useCases: { id: string; title: string; description?: string; actions: string[]; cases: string[] }[] }[];
  diff: OrganizationDiff;
}

/** The editable organization (ids kept) from the view the cases response carries. */
export function organizationDefs(view: OrganizationView): FeatureDef[] {
  return view.features.map((f) => ({
    id: f.id,
    title: f.title,
    ...(f.description ? { description: f.description } : {}),
    useCases: f.useCases.map((u) => ({ id: u.id, title: u.title, ...(u.description ? { description: u.description } : {}), actions: u.actions, cases: u.cases })),
  }));
}

/** caseId -> its feature/use case. */
export function caseUseCaseIndex(view: OrganizationView): Map<string, CaseFeatureInfo> {
  const index = new Map<string, CaseFeatureInfo>();
  for (const f of view.features) for (const u of f.useCases) for (const c of u.cases) index.set(c, { featureId: f.id, featureTitle: f.title, useCaseId: u.id, useCaseTitle: u.title });
  return index;
}

export interface RegenerationHeadline {
  at: string;
  filesChanged: number;
  testsChanged: number;
}

export type CasesResponse = CasesData & { regeneration?: RegenerationHeadline | null; createdId?: string; created?: number };

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/cases`;

async function call(url: string, init?: RequestInit): Promise<CasesResponse> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const casesApi = {
  load: (projectId: string) => call(base(projectId)),
  createBaseline: (projectId: string, approve: boolean, pageId?: string, useCaseId?: string) =>
    call(`${base(projectId)}/baseline`, json("POST", { approve, ...(pageId ? { pageId } : {}), ...(useCaseId ? { useCaseId } : {}) })),
  setStatus: (projectId: string, ids: string[], status: CaseStatus) => call(`${base(projectId)}/status`, json("POST", { ids, status })),
  create: (projectId: string, body: { title: string; steps: CaseStep[]; requires: string[]; given?: Given[]; dataset?: Dataset; useCaseId?: string }) => call(base(projectId), json("POST", body)),
  update: (projectId: string, caseId: string, body: Partial<{ title: string; status: CaseStatus; steps: CaseStep[]; requires: string[]; given: Given[] | null; dataset: Dataset | null }>) =>
    call(`${base(projectId)}/${encodeURIComponent(caseId)}`, json("PUT", body)),
  remove: (projectId: string, caseId: string) => call(`${base(projectId)}/${encodeURIComponent(caseId)}`, { method: "DELETE" }),
  removeMany: (projectId: string, ids: string[]) => call(`${base(projectId)}/delete`, json("POST", { ids })),
};

const suitesBase = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/suites`;

/** Suite mutations — each answers with the fresh cases response (suites included). */
export const suitesApi = {
  create: (projectId: string, name: string, caseIds: string[]) => call(suitesBase(projectId), json("POST", { name, caseIds })) as Promise<CasesResponse & { createdSuiteId?: string }>,
  update: (projectId: string, suiteId: string, body: { name?: string; caseIds?: string[]; addCaseIds?: string[]; removeCaseIds?: string[] }) =>
    call(`${suitesBase(projectId)}/${encodeURIComponent(suiteId)}`, json("PUT", body)),
  remove: (projectId: string, suiteId: string) => call(`${suitesBase(projectId)}/${encodeURIComponent(suiteId)}`, { method: "DELETE" }),
};

const featuresBase = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/features`;

/** Organization mutations — each answers with the fresh cases response (and what regeneration changed). */
export const featuresApi = {
  save: (projectId: string, features: FeatureDef[], baseUpdatedAt: string | null) => call(featuresBase(projectId), json("PUT", { organization: { features }, baseUpdatedAt })),
  assign: (projectId: string, caseIds: string[], useCaseId: string | null) => call(`${featuresBase(projectId)}/assign`, json("POST", { caseIds, useCaseId })),
  acceptProposal: (projectId: string) => call(`${featuresBase(projectId)}/proposal/accept`, { method: "POST" }),
  discardProposal: (projectId: string) => call(`${featuresBase(projectId)}/proposal/discard`, { method: "POST" }),
};

/** Sets or clears (null) the user's destructive override for an action; the server regenerates. */
export async function setDestructiveFlag(projectId: string, edgeId: string, value: boolean | null): Promise<void> {
  await fetch(`/api/projects/${encodeURIComponent(projectId)}/edge-flags`, json("PUT", { edgeId, destructive: value }));
}

/** The page a step leaves the browser on — where the next step's actions are offered. */
export function pageAfter(step: CaseStep, action: ActionView | undefined): string | undefined {
  if (!action) return undefined;
  if (action.external || action.toPageId === action.fromPageId) return step.on ?? action.fromPageId;
  return action.toPageId;
}

export const STATUS_LABEL: Record<CaseStatus | "needs_review", string> = {
  draft: "draft",
  approved: "approved",
  rejected: "rejected",
  needs_review: "needs review",
};
