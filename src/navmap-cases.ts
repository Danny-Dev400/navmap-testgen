import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod/v4";
import type { ActionEdge, NavigationMap, PageElement } from "./navmap-types.js";
import { abs, projectPaths } from "./project-paths.js";

/** Test cases are the test-design layer: what to test, as references to map actions. The map owns
 *  every fact (locators, observed outcomes); a case only picks actions, their data and which of the
 *  observed outcomes to check — so re-exploring never rewrites a case, and a case never invents a
 *  locator. Specs are generated from approved cases only (src/navmap-test-generator.ts). */

export const CASE_ID_RE = /^[a-z0-9_-]{1,120}$/;
/** A named state (projects/<id>/states.json, src/navmap-states.ts). */
export const STATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** A state a case needs before its own steps (its flow runs first, as a "Given" step). */
export const GivenSchema = z.object({ state: z.string().regex(STATE_ID_RE), item: z.string().min(1).optional() });
export type Given = z.infer<typeof GivenSchema>;

/** "<pageId>#<elementId>" — a PageNode.elements entry. */
export const ElementRefSchema = z.string().regex(/^[a-z0-9_-]{1,200}#[a-z0-9-]{1,60}$/);
export const VarNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,30}$/);

export function resolveElement(map: NavigationMap, ref: string): { pageId: string; element: PageElement } | undefined {
  const [pageId, elementId] = ref.split("#");
  const element = map.pages[pageId]?.elements?.find((e) => e.id === elementId);
  return element ? { pageId, element } : undefined;
}

export const isNumericElement = (e: PageElement) => e.valueKind === "number" || e.valueKind === "currency";

/** The page a step leaves the browser on (same rule the generator's page tracker uses). */
export function pageAfterStep(step: { on?: string }, edge: ActionEdge): string {
  return edge.toPageId === edge.fromPageId || edge.external ? (step.on ?? edge.fromPageId) : edge.toPageId;
}

export const ActionStepSchema = z.object({
  edgeId: z.string().min(1),
  /** Runs this (shared UI component) action on another page than the one it was recorded on. */
  on: z.string().min(1).optional(),
  /** Which list item to act on — overrides edge.scope.hasText. */
  item: z.string().min(1).optional(),
  /** Overrides edge.inputValue (typed text, selected option, pressed key). */
  input: z.string().optional(),
  /** Overrides edge.formFields values, by field label. */
  form: z.record(z.string(), z.string()).optional(),
  /** Postcondition descriptions to check after the step; omitted = every recorded one. */
  assert: z.array(z.string()).optional(),
  /** Expected values for this step's has_text/count checks, by postcondition description — the
   *  check's locator stays the map's; only the literal changes (e.g. the cart badge reads "3"
   *  after the third add, not the "1" observed while exploring). */
  expect: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  /** Read page elements (map PageNode.elements, "<pageId>#<elementId>") after this step into named
   *  values a later step can compare against — e.g. each product's price on the catalog. */
  capture: z.array(z.object({ element: ElementRefSchema, item: z.string().min(1).optional(), as: VarNameSchema })).optional(),
  /** Checks on page elements after this step: against a literal, a captured value, or the sum of
   *  captured values (number/currency elements) — e.g. "Item total = p1 + p2 + p3". */
  verify: z
    .array(
      z.object({
        element: ElementRefSchema,
        item: z.string().min(1).optional(),
        op: z.enum(["equals", "contains", "visible", "hidden"]),
        value: z.union([z.string(), z.number()]).optional(),
        equalsVar: VarNameSchema.optional(),
        equalsSumOf: z.array(VarNameSchema).min(1).optional(),
      }),
    )
    .optional(),
});
export type ActionStep = z.infer<typeof ActionStepSchema>;

/** Data rows: the case runs once per row, with "{{column}}" in step values replaced by the row's
 *  value (item, input, form values, expected values, verify values). */
export const DatasetSchema = z.object({
  columns: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/)).min(1).max(12),
  rows: z
    .array(z.object({ name: z.string().trim().min(1).max(80), values: z.record(z.string(), z.string().max(500)) }))
    .min(1)
    .max(40),
});
export type Dataset = z.infer<typeof DatasetSchema>;

const PLACEHOLDER_RE = /\{\{([a-zA-Z][a-zA-Z0-9_]{0,30})\}\}/g;

function substitute(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (_, name: string) => values[name] ?? "");
}

/** Placeholders a step uses, split by whether they feed an expected outcome (which must be
 *  observed, never guessed) or an input. */
export function stepPlaceholders(step: ActionStep): { inputs: Set<string>; expected: Set<string> } {
  const grab = (text: string | undefined, into: Set<string>) => {
    for (const m of (text ?? "").matchAll(PLACEHOLDER_RE)) into.add(m[1]);
  };
  const inputs = new Set<string>();
  const expected = new Set<string>();
  grab(step.item, inputs);
  grab(step.input, inputs);
  for (const v of Object.values(step.form ?? {})) grab(v, inputs);
  for (const v of Object.values(step.expect ?? {})) grab(String(v), expected);
  for (const v of step.verify ?? []) grab(typeof v.value === "string" ? v.value : undefined, expected);
  for (const c of step.capture ?? []) grab(c.item, inputs);
  for (const v of step.verify ?? []) grab(v.item, inputs);
  return { inputs, expected };
}

export function substituteStep(step: ActionStep, values: Record<string, string>): ActionStep {
  const s = (t: string | undefined) => (t === undefined ? undefined : substitute(t, values));
  return {
    ...step,
    ...(step.item !== undefined ? { item: s(step.item) } : {}),
    ...(step.input !== undefined ? { input: s(step.input) } : {}),
    ...(step.form ? { form: Object.fromEntries(Object.entries(step.form).map(([k, v]) => [k, s(v)!])) } : {}),
    ...(step.expect ? { expect: Object.fromEntries(Object.entries(step.expect).map(([k, v]) => [k, typeof v === "string" ? s(v)! : v])) } : {}),
    ...(step.capture ? { capture: step.capture.map((c) => ({ ...c, ...(c.item !== undefined ? { item: s(c.item) } : {}) })) } : {}),
    ...(step.verify
      ? { verify: step.verify.map((v) => ({ ...v, ...(v.item !== undefined ? { item: s(v.item) } : {}), ...(typeof v.value === "string" ? { value: s(v.value) } : {}) })) }
      : {}),
  };
}

export interface ExpandedRow {
  /** undefined for a case without a dataset (a single run). */
  row?: { name: string; values: Record<string, string> };
  steps: ActionStep[];
  /** Why this row can't run yet (an expected value nobody has observed/filled in). */
  blocker?: string;
}

/** One concrete step list per data row (or the case's own steps when it has no dataset). */
export function expandRows(testCase: TestCase): ExpandedRow[] {
  if (!testCase.dataset) return [{ steps: testCase.steps }];
  const expectedCols = new Set(testCase.steps.flatMap((s) => [...stepPlaceholders(s).expected]));
  return testCase.dataset.rows.map((row) => {
    const missing = [...expectedCols].filter((c) => !(row.values[c] ?? "").trim());
    return {
      row,
      steps: testCase.steps.map((s) => substituteStep(s, row.values)),
      ...(missing.length ? { blocker: `Row "${row.name}": the expected value for ${missing.map((c) => `{{${c}}}`).join(", ")} isn't set yet — fill it in from what the page really shows.` } : {}),
    };
  });
}

export const CaseStatusSchema = z.enum(["draft", "approved", "rejected"]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const TestCaseSchema = z.object({
  id: z.string().regex(CASE_ID_RE),
  title: z.string().trim().min(1).max(300),
  status: CaseStatusSchema,
  origin: z.enum(["baseline", "manual", "agent"]),
  /** Cases whose steps run first, in order — a case used as another case's precondition. */
  requires: z.array(z.string().regex(CASE_ID_RE)).default([]),
  /** States to put the app in first (reusable flows) — preferred over requires. */
  given: z.array(GivenSchema).max(10).optional(),
  steps: z.array(ActionStepSchema).min(1),
  dataset: DatasetSchema.optional(),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const MAX_REQUIRES_DEPTH = 5;

function casesDir(rootDir: string, projectId: string): string {
  return abs(rootDir, projectPaths(projectId).cases);
}

/** Invalid files are skipped with a warning rather than failing the whole project — one hand-edit
 *  gone wrong shouldn't take every other case down with it. */
export async function loadCases(rootDir: string, projectId: string): Promise<TestCase[]> {
  const dir = casesDir(rootDir, projectId);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
  const cases: TestCase[] = [];
  for (const name of names) {
    try {
      const parsed = TestCaseSchema.parse(JSON.parse(await readFile(path.join(dir, name), "utf-8")));
      if (`${parsed.id}.json` !== name) throw new Error(`id "${parsed.id}" doesn't match its file name`);
      cases.push(parsed);
    } catch (err) {
      console.warn(`[navmap-cases] Skipping invalid case file ${name}: ${(err as Error).message}`);
    }
  }
  return cases;
}

export async function saveCase(rootDir: string, projectId: string, testCase: TestCase): Promise<void> {
  const valid = TestCaseSchema.parse(testCase);
  const dir = casesDir(rootDir, projectId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${valid.id}.json`), JSON.stringify(valid, null, 2) + "\n", "utf-8");
}

export async function deleteCase(rootDir: string, projectId: string, caseId: string): Promise<void> {
  if (!CASE_ID_RE.test(caseId)) throw new Error("Invalid case id");
  await rm(path.join(casesDir(rootDir, projectId), `${caseId}.json`), { force: true });
}

/** Deterministic, so creating baselines twice is idempotent and an old run result that only knows
 *  its edge id still finds its case. Long edge ids are shortened with a hash (Windows paths). */
export function baselineCaseId(edgeId: string): string {
  const slug = edgeId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const id = `base-${slug}`;
  if (id.length <= 100) return id;
  const hash = createHash("sha1").update(edgeId).digest("hex").slice(0, 8);
  return `${id.slice(0, 90)}-${hash}`;
}

/** Today's "one action = one test", as a draft the user approves. */
export function baselineCase(edge: ActionEdge, status: CaseStatus, now = new Date().toISOString()): TestCase {
  return {
    id: baselineCaseId(edge.id),
    title: edge.semanticIntent,
    status,
    origin: "baseline",
    requires: [],
    steps: [{ edgeId: edge.id }],
    createdAt: now,
    updatedAt: now,
  };
}

/** A readable id for a new manual case, unique among the existing ones. */
export function newCaseId(title: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base =
    "case-" +
    (title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled");
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/** Edges no case (in any status) references — shown as "no case" so the user decides. */
export function uncoveredEdgeIds(map: NavigationMap, cases: TestCase[]): string[] {
  const referenced = new Set(cases.flatMap((c) => c.steps.map((s) => s.edgeId)));
  return Object.keys(map.edges).filter((id) => !referenced.has(id));
}

export interface CaseHealth {
  health: "ok" | "needs_review";
  reasons: string[];
}

/** Derived, never stored: whether a case still fits the current map. A re-exploration that removes
 *  or rewords something a case relies on flags the case here — it is never deleted or rewritten. */
export function caseHealth(testCase: TestCase, map: NavigationMap, casesById: Map<string, TestCase>): CaseHealth {
  const reasons: string[] = [];
  testCase.steps.forEach((step, i) => {
    const label = `Step ${i + 1}`;
    const edge = map.edges[step.edgeId];
    if (!edge) {
      reasons.push(`${label}: its action ("${step.edgeId}") is no longer in the map.`);
      return;
    }
    if (step.on && !map.pages[step.on]) reasons.push(`${label}: page "${step.on}" is no longer in the map.`);
    for (const wanted of step.assert ?? []) {
      if (!edge.postconditions.some((p) => p.description === wanted)) {
        reasons.push(`${label}: the checked outcome "${wanted}" is no longer recorded for "${edge.semanticIntent}".`);
      }
    }
    for (const [wanted, value] of Object.entries(step.expect ?? {})) {
      const post = edge.postconditions.find((p) => p.description === wanted);
      if (!post) {
        reasons.push(`${label}: the outcome "${wanted}" whose expected value this case sets is no longer recorded for "${edge.semanticIntent}".`);
      } else if (post.check?.kind !== "has_text" && post.check?.kind !== "count") {
        reasons.push(`${label}: "${wanted}" is no longer a text or count check, so its expected value can't be set.`);
      } else if (post.check.kind === "count" && !Number.isInteger(Number(value))) {
        reasons.push(`${label}: "${wanted}" counts elements, but the expected value "${value}" isn't a whole number.`);
      }
    }
    if (step.item && !edge.scope) reasons.push(`${label}: "${edge.semanticIntent}" no longer acts on a list item, so the item can't be chosen.`);
    for (const label2 of Object.keys(step.form ?? {})) {
      if (!edge.formFields?.some((f) => f.label === label2)) {
        reasons.push(`${label}: form field "${label2}" is no longer recorded for "${edge.semanticIntent}".`);
      }
    }
    if (edge.external?.opensNewTab && i < testCase.steps.length - 1) {
      reasons.push(`${label}: "${edge.semanticIntent}" opens a new tab, so it can only be the last step.`);
    }
  });

  // Captured values and element checks, in run order (required cases' steps first): every element
  // must still be in the map and on the page the step leaves the browser on, and every value must
  // be captured before it's compared.
  const vars = new Map<string, boolean>(); // name -> numeric
  const ordered = [...requiredSteps(testCase, casesById).map((r) => ({ step: r.step, label: `In required case "${r.fromCase.title}"` })), ...testCase.steps.map((step, i) => ({ step, label: `Step ${i + 1}` }))];
  for (const { step, label } of ordered) {
    const edge = map.edges[step.edgeId];
    if (!edge) continue; // already reported
    const here = pageAfterStep(step, edge);
    const elementAt = (ref: string, item: string | undefined) => {
      const found = resolveElement(map, ref);
      if (!found) {
        reasons.push(`${label}: element "${ref}" is no longer in the map.`);
        return undefined;
      }
      if (found.pageId !== here) reasons.push(`${label}: element "${found.element.label}" is on "${map.pages[found.pageId]?.title ?? found.pageId}", not where this step leaves the browser.`);
      if (item && !found.element.scope) reasons.push(`${label}: "${found.element.label}" isn't one-per-item, so an item can't be chosen.`);
      return found.element;
    };
    for (const c of step.capture ?? []) {
      const el = elementAt(c.element, c.item);
      if (vars.has(c.as)) reasons.push(`${label}: the value "${c.as}" is captured twice.`);
      vars.set(c.as, !!el && isNumericElement(el));
    }
    for (const v of step.verify ?? []) {
      const el = elementAt(v.element, v.item);
      const sources = [v.value !== undefined, v.equalsVar !== undefined, v.equalsSumOf !== undefined].filter(Boolean).length;
      const needsOne = v.op === "equals" || v.op === "contains";
      if (needsOne && sources !== 1) reasons.push(`${label}: a "${v.op}" check needs exactly one of value, equalsVar or equalsSumOf.`);
      if (!needsOne && sources > 0) reasons.push(`${label}: a "${v.op}" check takes no value.`);
      for (const name of [...(v.equalsVar ? [v.equalsVar] : []), ...(v.equalsSumOf ?? [])]) {
        if (!vars.has(name)) reasons.push(`${label}: "${name}" is used before it's captured.`);
      }
      if (v.equalsSumOf) {
        if (v.op !== "equals") reasons.push(`${label}: a sum can only be checked with "equals".`);
        if (el && !isNumericElement(el)) reasons.push(`${label}: "${el.label}" isn't a number, so it can't equal a sum.`);
        if (v.equalsSumOf.some((n) => vars.get(n) === false)) reasons.push(`${label}: a sum can only add numeric captured values.`);
      }
    }
  }

  // Data table: every placeholder must be a column, every row must give every column a value
  // (an empty expected value is a per-row blocker, see expandRows — not a reason to review the case).
  const used = new Set(testCase.steps.flatMap((s) => {
    const p = stepPlaceholders(s);
    return [...p.inputs, ...p.expected];
  }));
  if (testCase.dataset) {
    const cols = testCase.dataset.columns;
    if (new Set(cols).size !== cols.length) reasons.push("Data table: duplicate column names.");
    for (const name of used) if (!cols.includes(name)) reasons.push(`Data table: {{${name}}} is used in a step but isn't a column.`);
    const rowNames = testCase.dataset.rows.map((r) => r.name.toLowerCase());
    if (new Set(rowNames).size !== rowNames.length) reasons.push("Data table: two rows have the same name.");
    for (const row of testCase.dataset.rows) {
      const missing = cols.filter((c) => !(c in row.values));
      if (missing.length) reasons.push(`Data table row "${row.name}": no value for ${missing.map((c) => `{{${c}}}`).join(", ")}.`);
    }
  } else if (used.size > 0) {
    reasons.push(`Steps use ${[...used].map((n) => `{{${n}}}`).join(", ")} but the case has no data table.`);
  }

  const visit = (c: TestCase, trail: string[]) => {
    for (const reqId of c.requires) {
      if (trail.includes(reqId)) {
        reasons.push(`Circular "requires": ${[...trail, reqId].join(" → ")}.`);
        continue;
      }
      const req = casesById.get(reqId);
      if (!req) {
        reasons.push(`Required case "${reqId}" no longer exists.`);
        continue;
      }
      if (req.status === "rejected") reasons.push(`Required case "${req.title}" was rejected.`);
      if (trail.length >= MAX_REQUIRES_DEPTH) {
        reasons.push(`"requires" chain is deeper than ${MAX_REQUIRES_DEPTH} levels.`);
        continue;
      }
      for (const s of req.steps) if (!map.edges[s.edgeId]) reasons.push(`Required case "${req.title}" uses an action that is no longer in the map.`);
      visit(req, [...trail, reqId]);
    }
  };
  visit(testCase, [testCase.id]);

  return { health: reasons.length ? "needs_review" : "ok", reasons: [...new Set(reasons)] };
}

/** The steps a case's "requires" contribute, flattened in run order (each required case's own
 *  requirements first). Assumes caseHealth passed — cycles/missing cases are skipped defensively. */
export function requiredSteps(testCase: TestCase, casesById: Map<string, TestCase>): { step: ActionStep; fromCase: TestCase }[] {
  const out: { step: ActionStep; fromCase: TestCase }[] = [];
  const walk = (c: TestCase, trail: Set<string>, depth: number) => {
    for (const reqId of c.requires) {
      const req = casesById.get(reqId);
      if (!req || trail.has(reqId) || depth >= MAX_REQUIRES_DEPTH) continue;
      walk(req, new Set([...trail, reqId]), depth + 1);
      for (const step of req.steps) out.push({ step, fromCase: req });
    }
  };
  walk(testCase, new Set([testCase.id]), 0);
  return out;
}
