import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { NavigationMap } from "./navmap-types.js";
import { CASE_ID_RE, uncoveredEdgeIds, type TestCase } from "./navmap-cases.js";
import type { CasePlan } from "./navmap-test-generator.js";
import { executedEdges } from "./navmap-journeys.js";
import { abs, projectPaths } from "./project-paths.js";

/** How test cases are organized by what the app does: features (business capabilities — "Shopping
 *  cart") → use cases (user goals — "Add a product to the cart") → the cases that prove them.
 *  Pages stay the code's organization; this layer only groups cases, adds a feature tag to their
 *  tests and is the anchor for requirements later. Assignment is always explicit (a case is listed
 *  in its use case's `cases`) — a suggestion from the case's actions is only ever shown, never
 *  applied on its own. */

export const ORG_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

const UseCaseInput = z.object({
  id: z.string().regex(ORG_ID_RE).optional(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  /** Map actions that carry this use case — an action can serve several use cases. */
  actions: z.array(z.string().min(1)).max(300).default([]),
  /** The cases that prove it, in display order — a case belongs to at most one use case. */
  cases: z.array(z.string().regex(CASE_ID_RE)).max(500).default([]),
});
const FeatureInput = z.object({
  id: z.string().regex(ORG_ID_RE).optional(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  useCases: z.array(UseCaseInput).max(60).default([]),
});
/** What the organizer stages and the UI sends: ids may be missing on new items (assignIds). */
export const OrganizationInputSchema = z.object({ features: z.array(FeatureInput).max(40) });
export type OrganizationInput = z.infer<typeof OrganizationInputSchema>;

const UseCaseSchema = UseCaseInput.extend({ id: z.string().regex(ORG_ID_RE) });
const FeatureSchema = FeatureInput.extend({ id: z.string().regex(ORG_ID_RE), useCases: z.array(UseCaseSchema).max(60) });
export const OrganizationSchema = z.object({ features: z.array(FeatureSchema).max(40), updatedAt: z.string() });
export type UseCase = z.infer<typeof UseCaseSchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;

export const ProposalSchema = z.object({
  organization: OrganizationSchema,
  rationale: z.string().max(4000).optional(),
  request: z.string().max(1000).optional(),
  createdAt: z.string(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

// ---- files ----

export async function loadOrganization(rootDir: string, projectId: string): Promise<Organization | null> {
  return readJson(abs(rootDir, projectPaths(projectId).features), OrganizationSchema, "features.json");
}

export async function saveOrganization(rootDir: string, projectId: string, org: Organization): Promise<Organization> {
  const saved = OrganizationSchema.parse({ ...org, updatedAt: new Date().toISOString() });
  await writeJson(abs(rootDir, projectPaths(projectId).features), saved);
  return saved;
}

export async function loadProposal(rootDir: string, projectId: string): Promise<Proposal | null> {
  return readJson(abs(rootDir, projectPaths(projectId).featuresProposal), ProposalSchema, "features.proposed.json");
}

export async function saveProposal(rootDir: string, projectId: string, proposal: Proposal): Promise<void> {
  await writeJson(abs(rootDir, projectPaths(projectId).featuresProposal), ProposalSchema.parse(proposal));
}

export async function deleteProposal(rootDir: string, projectId: string): Promise<void> {
  await rm(abs(rootDir, projectPaths(projectId).featuresProposal), { force: true });
}

async function readJson<T>(file: string, schema: z.ZodType<T>, label: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return null;
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch (err) {
    console.warn(`[navmap-features] Ignoring invalid ${label}: ${(err as Error).message}`);
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

// ---- ids, validation, cleanup ----

function slug(title: string, fallback: string): string {
  return (
    title
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "") || fallback
  );
}

function unique(base: string, taken: Set<string>): string {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}

/** Items without an id get one from their title; existing ids are kept as they are, so a rename
 *  never changes a feature's tag. Feature ids and use case ids are separate namespaces. */
export function assignIds(input: OrganizationInput): Omit<Organization, "updatedAt"> {
  const featureIds = new Set(input.features.flatMap((f) => (f.id ? [f.id] : [])));
  const useCaseIds = new Set(input.features.flatMap((f) => f.useCases.flatMap((u) => (u.id ? [u.id] : []))));
  return {
    features: input.features.map((f) => ({
      ...f,
      id: f.id ?? unique(slug(f.title, "feature"), featureIds),
      useCases: f.useCases.map((u) => ({ ...u, id: u.id ?? unique(slug(u.title, "use-case"), useCaseIds) })),
    })),
  };
}

/** Problems that make an organization unsavable — the organizer's save script and the UI's PUT
 *  refuse it with this list. */
export function validateOrganization(org: Omit<Organization, "updatedAt">, map: NavigationMap, cases: TestCase[]): string[] {
  const errors: string[] = [];
  const caseIds = new Set(cases.map((c) => c.id));
  const featureIds = new Set<string>();
  const useCaseIds = new Set<string>();
  const caseOwner = new Map<string, string>();
  for (const f of org.features) {
    if (featureIds.has(f.id)) errors.push(`feature id "${f.id}" is used twice`);
    featureIds.add(f.id);
    for (const u of f.useCases) {
      const where = `use case "${u.title}" (${f.title})`;
      if (useCaseIds.has(u.id)) errors.push(`use case id "${u.id}" is used twice`);
      useCaseIds.add(u.id);
      for (const a of u.actions) if (!map.edges[a]) errors.push(`${where}: no action "${a}" in the map`);
      if (new Set(u.actions).size !== u.actions.length) errors.push(`${where}: an action is listed twice`);
      for (const c of u.cases) {
        if (!caseIds.has(c)) errors.push(`${where}: no test case "${c}"`);
        const owner = caseOwner.get(c);
        if (owner) errors.push(`case "${c}" is in two use cases ("${owner}" and "${u.title}") — a case belongs to one use case`);
        caseOwner.set(c, u.title);
      }
    }
  }
  return errors;
}

/** Drops references that went stale (a deleted case, an action that left the map, a duplicate
 *  assignment) so one outdated id never breaks the whole organization. */
export function sanitizeOrganization<T extends Omit<Organization, "updatedAt">>(org: T, map: NavigationMap, cases: TestCase[]): { org: T; dropped: string[] } {
  const caseIds = new Set(cases.map((c) => c.id));
  const seen = new Set<string>();
  const dropped: string[] = [];
  const features = org.features.map((f) => ({
    ...f,
    useCases: f.useCases.map((u) => ({
      ...u,
      actions: [...new Set(u.actions)].filter((a) => {
        if (map.edges[a]) return true;
        dropped.push(`action ${a} (${u.title})`);
        return false;
      }),
      cases: u.cases.filter((c) => {
        if (!caseIds.has(c)) {
          dropped.push(`case ${c} (${u.title})`);
          return false;
        }
        if (seen.has(c)) return false;
        seen.add(c);
        return true;
      }),
    })),
  }));
  return { org: { ...org, features }, dropped };
}

export const EMPTY_ORGANIZATION: Organization = { features: [], updatedAt: "" };

// ---- lookups ----

export interface CaseFeatureInfo {
  featureId: string;
  featureTitle: string;
  useCaseId: string;
  useCaseTitle: string;
}

export function caseFeatureIndex(org: Pick<Organization, "features"> | null | undefined): Map<string, CaseFeatureInfo> {
  const index = new Map<string, CaseFeatureInfo>();
  for (const f of org?.features ?? []) {
    for (const u of f.useCases) {
      for (const c of u.cases) {
        if (!index.has(c)) index.set(c, { featureId: f.id, featureTitle: f.title, useCaseId: u.id, useCaseTitle: u.title });
      }
    }
  }
  return index;
}

export function findUseCase(org: Pick<Organization, "features">, useCaseId: string): { feature: Feature; useCase: UseCase } | undefined {
  for (const feature of org.features) {
    const useCase = feature.useCases.find((u) => u.id === useCaseId);
    if (useCase) return { feature, useCase };
  }
  return undefined;
}

/** Where an unsorted case most likely belongs: the use case that lists its last step's action,
 *  else any of its steps' (latest first). Only ever shown as a suggestion. */
export function suggestUseCase(testCase: TestCase, org: Pick<Organization, "features">): CaseFeatureInfo | undefined {
  for (const step of [...testCase.steps].reverse()) {
    for (const f of org.features) {
      const u = f.useCases.find((x) => x.actions.includes(step.edgeId));
      if (u) return { featureId: f.id, featureTitle: f.title, useCaseId: u.id, useCaseTitle: u.title };
    }
  }
  return undefined;
}

/** Moves cases into a use case (appended, in the given order), or out of every use case (null). */
export function assignCases<T extends Pick<Organization, "features">>(org: T, caseIds: string[], useCaseId: string | null): T {
  const moving = new Set(caseIds);
  return {
    ...org,
    features: org.features.map((f) => ({
      ...f,
      useCases: f.useCases.map((u) => {
        const kept = u.cases.filter((c) => !moving.has(c));
        return { ...u, cases: u.id === useCaseId ? [...kept, ...caseIds] : kept };
      }),
    })),
  };
}

// ---- views ----

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
  /** Its actions that some approved, runnable case executes (setup included). */
  actionsExercised: string[];
  /** Its actions no case references at all — "Create drafts" makes baseline cases for them. */
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
  /** Cases in no use case, with where they probably belong. */
  unsorted: { caseId: string; suggestion: CaseFeatureInfo | null }[];
  /** Map actions no use case lists (new since the last organization, or left out on purpose). */
  unorganizedActions: string[];
  /** Stale references ignored on load. */
  dropped: string[];
}

export function organizationView(org: Organization | null, map: NavigationMap, cases: TestCase[], plans: Map<string, CasePlan>): OrganizationView {
  const clean = org ? sanitizeOrganization(org, map, cases) : { org: EMPTY_ORGANIZATION, dropped: [] };
  const byId = new Map(cases.map((c) => [c.id, c]));
  const uncovered = new Set(uncoveredEdgeIds(map, cases));
  const exercisedBy = (caseId: string) => {
    const plan = plans.get(caseId);
    // Only tests that really run walk anything — a fixme stub exercises nothing.
    return plan?.runnable && byId.get(caseId)?.status === "approved" ? executedEdges(plan) : [];
  };
  const features = clean.org.features.map((f) => ({
    id: f.id,
    title: f.title,
    ...(f.description ? { description: f.description } : {}),
    useCases: f.useCases.map((u) => {
      const own = u.cases.map((id) => byId.get(id)!);
      const exercised = new Set(u.cases.flatMap(exercisedBy));
      return {
        id: u.id,
        featureId: f.id,
        title: u.title,
        ...(u.description ? { description: u.description } : {}),
        actions: u.actions,
        cases: u.cases,
        approved: own.filter((c) => c.status === "approved").length,
        drafts: own.filter((c) => c.status === "draft").length,
        runnable: own.filter((c) => c.status === "approved" && plans.get(c.id)?.runnable).length,
        actionsExercised: u.actions.filter((a) => exercised.has(a)),
        actionsWithoutCase: u.actions.filter((a) => uncovered.has(a)),
      };
    }),
  }));
  const index = caseFeatureIndex(clean.org);
  const listed = new Set(clean.org.features.flatMap((f) => f.useCases.flatMap((u) => u.actions)));
  return {
    exists: !!org,
    updatedAt: org?.updatedAt ?? null,
    features,
    unsorted: cases.filter((c) => !index.has(c.id)).map((c) => ({ caseId: c.id, suggestion: org ? (suggestUseCase(c, clean.org) ?? null) : null })),
    unorganizedActions: org ? Object.keys(map.edges).filter((id) => !listed.has(id)) : [],
    dropped: clean.dropped,
  };
}

// ---- proposal review ----

export interface OrganizationDiff {
  /** Per node of the proposal: what changes if it's accepted. */
  features: Record<string, "new" | "renamed">;
  useCases: Record<string, "new" | "renamed" | "moved">;
  cases: Record<string, "sorted" | "moved">;
  removedFeatures: { id: string; title: string }[];
  removedUseCases: { id: string; title: string; featureTitle: string }[];
  /** Cases the proposal takes out of their current use case without placing them elsewhere. */
  unsortedCases: string[];
  actionsAdded: number;
  summary: string;
}

export function diffOrganization(current: Pick<Organization, "features"> | null, proposed: Pick<Organization, "features">): OrganizationDiff {
  const cur = current ?? { features: [] };
  const curFeatures = new Map(cur.features.map((f) => [f.id, f]));
  const curUseCases = new Map(cur.features.flatMap((f) => f.useCases.map((u) => [u.id, { u, featureId: f.id, featureTitle: f.title }] as const)));
  const curIndex = caseFeatureIndex(cur);
  const newIndex = caseFeatureIndex(proposed);
  const diff: OrganizationDiff = { features: {}, useCases: {}, cases: {}, removedFeatures: [], removedUseCases: [], unsortedCases: [], actionsAdded: 0, summary: "" };

  for (const f of proposed.features) {
    const before = curFeatures.get(f.id);
    if (!before) diff.features[f.id] = "new";
    else if (before.title !== f.title) diff.features[f.id] = "renamed";
    for (const u of f.useCases) {
      const was = curUseCases.get(u.id);
      if (!was) diff.useCases[u.id] = "new";
      else if (was.u.title !== u.title) diff.useCases[u.id] = "renamed";
      else if (was.featureId !== f.id) diff.useCases[u.id] = "moved";
      const had = new Set(was?.u.actions ?? []);
      diff.actionsAdded += u.actions.filter((a) => !had.has(a)).length;
      for (const c of u.cases) {
        const prev = curIndex.get(c);
        if (!prev) diff.cases[c] = "sorted";
        else if (prev.useCaseId !== u.id) diff.cases[c] = "moved";
      }
    }
  }
  const proposedFeatureIds = new Set(proposed.features.map((f) => f.id));
  const proposedUseCaseIds = new Set(proposed.features.flatMap((f) => f.useCases.map((u) => u.id)));
  diff.removedFeatures = cur.features.filter((f) => !proposedFeatureIds.has(f.id)).map((f) => ({ id: f.id, title: f.title }));
  diff.removedUseCases = [...curUseCases.values()].filter((x) => !proposedUseCaseIds.has(x.u.id)).map((x) => ({ id: x.u.id, title: x.u.title, featureTitle: x.featureTitle }));
  diff.unsortedCases = [...curIndex.keys()].filter((c) => !newIndex.has(c));

  const count = (o: Record<string, string>, v: string) => Object.values(o).filter((x) => x === v).length;
  const ucTotal = proposed.features.reduce((n, f) => n + f.useCases.length, 0);
  const parts = [
    current ? null : `${proposed.features.length} features, ${ucTotal} use cases`,
    count(diff.features, "new") && current ? `${count(diff.features, "new")} new feature(s)` : null,
    count(diff.useCases, "new") && current ? `${count(diff.useCases, "new")} new use case(s)` : null,
    count(diff.features, "renamed") + count(diff.useCases, "renamed") ? `${count(diff.features, "renamed") + count(diff.useCases, "renamed")} renamed` : null,
    count(diff.cases, "sorted") ? `${count(diff.cases, "sorted")} case(s) sorted` : null,
    count(diff.cases, "moved") ? `${count(diff.cases, "moved")} case(s) moved` : null,
    diff.actionsAdded && current ? `${diff.actionsAdded} action(s) placed` : null,
    diff.removedFeatures.length + diff.removedUseCases.length ? `${diff.removedFeatures.length + diff.removedUseCases.length} removed` : null,
    diff.unsortedCases.length ? `${diff.unsortedCases.length} case(s) unsorted` : null,
  ].filter(Boolean);
  diff.summary = parts.length ? parts.join(" · ") : "No changes";
  return diff;
}
