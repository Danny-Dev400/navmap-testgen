import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { LocatorSchema, NavigationMapSchema, PostconditionSchema, type NavigationMap } from "./navmap-types.js";
import { ActionStepSchema, loadCases, saveCase, type TestCase } from "./navmap-cases.js";
import { abs, projectPaths } from "./project-paths.js";

/** Triage verdicts: what the agent concluded about one failed test, and — for a test bug — the
 *  smallest fix in the right layer (a map fact, or the case). Stored as proposals; nothing is
 *  applied until the user approves (after an automatic verification run). */

const ScopeSchema = z.object({ container: LocatorSchema, hasText: z.string().min(1) });

export const ProposalSchema = z.union([
  z.object({
    target: z.literal("map"),
    edgeId: z.string().min(1),
    set: z
      .object({
        locator: LocatorSchema.optional(),
        scope: ScopeSchema.nullable().optional(),
        external: z.object({ url: z.string(), opensNewTab: z.boolean() }).optional(),
        postconditions: z.array(PostconditionSchema).optional(),
      })
      .refine((s) => Object.keys(s).length > 0, "set at least one field"),
  }),
  z.object({
    target: z.literal("map"),
    pageId: z.string().min(1),
    elementId: z.string().optional(),
    set: z
      .object({ locator: LocatorSchema.optional(), scope: ScopeSchema.nullable().optional(), anchor: LocatorSchema.optional() })
      .refine((s) => Object.keys(s).length > 0, "set at least one field"),
  }),
  z.object({ target: z.literal("case"), caseId: z.string().min(1), steps: z.array(ActionStepSchema).min(1) }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

export const VerdictSchema = z.object({
  runId: z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/),
  testIndex: z.number().int().min(0),
  caseId: z.string().min(1),
  classification: z.enum(["app_bug", "test_bug", "environment"]),
  subtype: z.string().max(40).optional(),
  explanation: z.string().min(1).max(3000),
  evidence: z.array(z.string().max(500)).max(12).default([]),
  proposal: ProposalSchema.optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const TriageRecordSchema = VerdictSchema.extend({
  id: z.string(),
  title: z.string(),
  status: z.enum(["report", "proposed", "applied", "rejected"]),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  targetHash: z.string().optional(),
  verification: z
    .object({ result: z.enum(["passed", "failed", "skipped"]), runId: z.string().optional(), reason: z.string().optional(), at: z.string() })
    .optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
});
export type TriageRecord = z.infer<typeof TriageRecordSchema>;

export const triageRecordId = (runId: string, testIndex: number) => `${runId}__${testIndex}`;

const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v ?? null)).digest("hex");

/** The object a proposal changes, in its current state (null when it doesn't exist). */
export function proposalTarget(p: Proposal, map: NavigationMap, cases: TestCase[]): unknown {
  if (p.target === "case") return cases.find((c) => c.id === p.caseId) ?? null;
  if ("edgeId" in p) return map.edges[p.edgeId] ?? null;
  const page = map.pages[p.pageId];
  if (!page) return null;
  return p.elementId ? (page.elements?.find((e) => e.id === p.elementId) ?? null) : page;
}

export function targetHash(p: Proposal, map: NavigationMap, cases: TestCase[]): string {
  return hash(proposalTarget(p, map, cases));
}

/** Applies a proposal to copies — the inputs are never mutated. Throws on a target that doesn't
 *  exist. `repair` stamps lastRepair on a map fact (used when the user approves, not to verify). */
export function applyProposal(
  p: Proposal,
  map: NavigationMap,
  cases: TestCase[],
  repair?: { at: string; runId: string; reason: string },
): { map: NavigationMap; cases: TestCase[]; before: unknown; after: unknown } {
  const nextMap: NavigationMap = structuredClone(map);
  const nextCases = cases.map((c) => structuredClone(c));
  const before = structuredClone(proposalTarget(p, map, cases));
  if (before === null) throw new Error("The proposal's target no longer exists");

  if (p.target === "case") {
    const c = nextCases.find((x) => x.id === p.caseId)!;
    c.steps = p.steps;
    c.updatedAt = repair?.at ?? c.updatedAt;
    return { map: nextMap, cases: nextCases, before, after: structuredClone(c) };
  }
  if ("edgeId" in p) {
    const edge = nextMap.edges[p.edgeId];
    const { scope, ...rest } = p.set;
    Object.assign(edge, rest);
    if (scope === null) delete edge.scope;
    else if (scope) edge.scope = scope;
    if (repair) edge.lastRepair = repair;
    return { map: nextMap, cases: nextCases, before, after: structuredClone(edge) };
  }
  const page = nextMap.pages[p.pageId];
  if (p.elementId) {
    const el = page.elements!.find((e) => e.id === p.elementId)!;
    if (p.set.locator) el.locator = p.set.locator;
    if (p.set.scope === null) delete el.scope;
    else if (p.set.scope) el.scope = p.set.scope;
    if (repair) page.lastRepair = repair;
    return { map: nextMap, cases: nextCases, before, after: structuredClone(el) };
  }
  if (p.set.anchor) page.anchor = p.set.anchor;
  if (repair) page.lastRepair = repair;
  return { map: nextMap, cases: nextCases, before, after: structuredClone(page) };
}

function triageDir(rootDir: string, projectId: string) {
  return abs(rootDir, projectPaths(projectId).triage);
}

export async function saveTriageRecord(rootDir: string, projectId: string, record: TriageRecord): Promise<void> {
  const dir = triageDir(rootDir, projectId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${record.id}.json`), JSON.stringify(TriageRecordSchema.parse(record), null, 2), "utf-8");
}

export async function loadTriageRecord(rootDir: string, projectId: string, id: string): Promise<TriageRecord | null> {
  if (!/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}__\d{1,4}$/.test(id)) return null;
  try {
    return TriageRecordSchema.parse(JSON.parse(await readFile(path.join(triageDir(rootDir, projectId), `${id}.json`), "utf-8")));
  } catch {
    return null;
  }
}

export async function listTriageRecords(rootDir: string, projectId: string, runId?: string): Promise<TriageRecord[]> {
  const out: TriageRecord[] = [];
  for (const name of await readdir(triageDir(rootDir, projectId)).catch(() => [] as string[])) {
    if (!name.endsWith(".json") || (runId && !name.startsWith(`${runId}__`))) continue;
    const r = await loadTriageRecord(rootDir, projectId, name.slice(0, -5));
    if (r) out.push(r);
  }
  return out;
}

/** Writes the patched map / case to disk (the map atomically). */
export async function writeApplied(rootDir: string, projectId: string, p: Proposal, result: { map: NavigationMap; cases: TestCase[] }): Promise<void> {
  if (p.target === "case") {
    await saveCase(rootDir, projectId, result.cases.find((c) => c.id === p.caseId)!);
    return;
  }
  const mapPath = abs(rootDir, projectPaths(projectId).navmap);
  const valid = NavigationMapSchema.parse({ ...result.map, updatedAt: new Date().toISOString() });
  await writeFile(`${mapPath}.tmp`, JSON.stringify(valid, null, 2), "utf-8");
  await rename(`${mapPath}.tmp`, mapPath);
}

export async function loadMapAndCases(rootDir: string, projectId: string): Promise<{ map: NavigationMap; cases: TestCase[] }> {
  const map = NavigationMapSchema.parse(JSON.parse(await readFile(abs(rootDir, projectPaths(projectId).navmap), "utf-8")));
  return { map, cases: await loadCases(rootDir, projectId) };
}
