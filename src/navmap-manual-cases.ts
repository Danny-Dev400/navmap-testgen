import type { ActionEdge, NavigationMap } from "./navmap-types.js";
import { expandRows, loadCases, pageAfterStep, resolveElement, type ActionStep, type Dataset, type TestCase } from "./navmap-cases.js";
import { planCases, resolveOrigin, type CasePlan, type PlannedState } from "./navmap-test-generator.js";
import { loadProjectUsers } from "./navmap-users.js";
import { loadStateGraph } from "./navmap-states.js";
import { loadEdgeFlags } from "./navmap-edge-flags.js";
import { caseFeatureIndex, loadOrganization, sanitizeOrganization, type CaseFeatureInfo } from "./navmap-features.js";
import { loadSuites } from "./navmap-suites.js";

/** Manual test cases: the same cases the generated tests come from, written as steps a person can
 *  follow — preconditions, where to start, what to do, the data to use and what to check. Built
 *  only from the map and the cases (never from credentials: a sign-in step names the user, not its
 *  password). Exported as Markdown, or CSV for test-management tools (TestRail, Xray, Zephyr Scale). */

export interface ManualStep {
  /** What to do, in plain words. */
  action: string;
  /** Values to use: form fields, typed text (never credentials). */
  data: string[];
  /** What to check after it. */
  expected: string[];
}

export interface ManualCase {
  id: string;
  title: string;
  status: TestCase["status"];
  feature?: { id: string; title: string };
  useCase?: { id: string; title: string };
  preconditions: string[];
  start: { page: string; url: string } | null;
  steps: ManualStep[];
  /** Data-driven case: the steps run once per row, "{{column}}" standing for the row's value. */
  dataset?: Dataset;
  destructive: boolean;
  /** Its generated test runs (not fixme). */
  automated: boolean;
  notes?: string;
}

export interface ManualExport {
  host: string;
  baseUrl: string;
  exportedAt: string;
  /** "whole project", "feature Checkout", "case Buy a backpack" */
  scopeLabel: string;
  cases: ManualCase[];
}

export type ManualScope =
  | { kind: "project" }
  | { kind: "feature"; featureId: string }
  | { kind: "case"; caseId: string }
  /** A hand-picked selection: exported whatever their status, like a single case. */
  | { kind: "cases"; caseIds: string[] }
  | { kind: "suite"; suiteId: string };
export type ManualFormat = "markdown" | "testrail" | "xray" | "zephyr";
export const MANUAL_FORMATS: ManualFormat[] = ["markdown", "testrail", "xray", "zephyr"];

// ---- wording ----

const q = (s: string | number) => `"${s}"`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const withArticle = (target: string) => (/^(the|a|an|your|my)\s/i.test(target) ? target : `the ${target}`);

function actionText(edge: ActionEdge, step: ActionStep, signInAs: string | undefined): string {
  const item = step.item ?? edge.scope?.hasText;
  const forItem = item ? ` for ${q(item)}` : "";
  const target = withArticle(edge.target);
  if (edge.authFormLocators) return `Sign in${signInAs ? ` as ${signInAs}` : ""}: enter the username and password, then click ${target}`;
  const value = step.input ?? edge.inputValue;
  switch (edge.action.toLowerCase()) {
    case "fill":
    case "type":
      return value ? `Type ${q(value)} in ${target}${forItem}` : `Leave ${target} empty${forItem}`;
    case "select":
    case "selectoption":
      return `Select ${q(value ?? "")} in ${target}${forItem}`;
    case "check":
      return `Check ${target}${forItem}`;
    case "uncheck":
      return `Uncheck ${target}${forItem}`;
    case "hover":
      return `Hover over ${target}${forItem}`;
    case "press":
      return `Press ${value ?? edge.target}`;
    case "goto":
    case "navigate":
      return `Go to ${edge.target}`;
    case "dblclick":
      return `Double-click ${target}${forItem}`;
    case "click":
    case "tap":
      return `Click ${target}${forItem}`;
    default:
      return `${capitalize(edge.action)} ${target}${forItem}${value ? ` with ${q(value)}` : ""}`;
  }
}

function elementLabel(map: NavigationMap, ref: string, item: string | undefined): string {
  const label = resolveElement(map, ref)?.element.label ?? ref;
  return `the ${lowerFirst(label)}${item ? ` of ${q(item)}` : ""}`;
}

/** One step: the action (with its page when the browser isn't already there), its data, and the
 *  checks the generated test makes after it — same postconditions, same expected values. */
function manualStep(map: NavigationMap, edge: ActionEdge, step: ActionStep, opts: { signInAs?: string; onPage?: string; fromCase?: string }): ManualStep {
  const fields = (edge.formFields ?? []).map((f) => ({ label: f.label, value: step.form?.[f.label] ?? f.value, kind: f.action ?? "fill" }));
  let action = actionText(edge, step, opts.signInAs);
  if (fields.length) action = `Fill in the form (see data), then ${lowerFirst(action)}`;
  if (opts.onPage) action = `On ${opts.onPage}: ${lowerFirst(action)}`;
  const notes = (step.capture ?? []).map((c) => `${elementLabel(map, c.element, c.item)} (call it ${c.as})`);
  if (notes.length) action += `. Then note ${notes.join(" and ")}`;
  if (opts.fromCase) action += ` (from ${q(opts.fromCase)})`;

  const data = fields.map((f) =>
    f.kind === "check" ? `${f.label}: ${f.value === "false" ? "unchecked" : "checked"}` : `${f.label}: ${f.value === "" ? "(leave empty)" : q(f.value)}`,
  );
  if (edge.authFormLocators) data.push(`Username and password of ${opts.signInAs ?? "the test user"} (kept out of this document)`);

  const expected: string[] = [];
  const wanted = step.assert ? edge.postconditions.filter((p) => step.assert!.includes(p.description)) : edge.postconditions;
  for (const p of wanted) {
    const override = step.expect?.[p.description];
    const literal = override ?? (p.check && (p.check.kind === "has_text" || p.check.kind === "count") ? p.check.value : undefined);
    expected.push(literal !== undefined && literal !== "" ? `${p.description} (${q(literal)})` : p.description);
  }
  if (edge.external) expected.push(`${edge.external.url} opens${edge.external.opensNewTab ? " in a new tab" : ""}`);
  else if (edge.toPageId !== edge.fromPageId && !wanted.some((p) => p.check?.kind === "url" || p.assertionType === "url_matches")) {
    expected.push(`${map.pages[edge.toPageId]?.title ?? edge.toPageId} opens`);
  }
  for (const v of step.verify ?? []) {
    const what = capitalize(elementLabel(map, v.element, v.item));
    if (v.op === "visible" || v.op === "hidden") expected.push(`${what} is ${v.op}`);
    else if (v.equalsSumOf) expected.push(`${what} equals ${v.equalsSumOf.join(" + ")} (noted earlier)`);
    else if (v.equalsVar) expected.push(`${what} equals ${v.equalsVar} (noted earlier)`);
    else expected.push(`${what} ${v.op === "equals" ? "is" : "contains"} ${q(v.value ?? "")}`);
  }
  return { action, data, expected };
}

function givenText(g: PlannedState, pageTitle: (id: string) => string): string {
  const item = g.item ?? (g.state.perItem ? g.steps.find((st) => st.edge.scope)?.edge.scope?.hasText : undefined);
  let text = `${g.state.title}${item ? ` (${q(item)})` : ""}`;
  if (g.state.notAutomatable) text += ` — set it up by hand: ${g.state.notAutomatable.reason}`;
  else if (g.steps.length) {
    const how = g.steps.map((st) => {
      const stItem = st.item ?? st.step?.item ?? st.edge.scope?.hasText;
      return `${lowerFirst(st.edge.semanticIntent)}${stItem ? ` (${q(stItem)})` : ""} on ${pageTitle(st.location)}`;
    });
    text += ` — to get there: ${how.join(", then ")}`;
  }
  return text;
}

/** A case as manual steps. `ownSteps` replaces the case's own steps (a data row's, values filled in). */
interface ExportContext {
  map: NavigationMap;
  origin: string;
  /** The user a login step signs in as — the generator's login user (first auth user with credentials). */
  signInAs?: string;
}

function manualCase(ctx: ExportContext, testCase: TestCase, plan: CasePlan, info: CaseFeatureInfo | undefined, ownSteps?: ActionStep[]): ManualCase {
  const { map, origin } = ctx;
  const pageTitle = (id: string) => map.pages[id]?.title ?? id;
  const userLabel = plan.user?.kind === "auth" ? plan.user.label : undefined;

  const preconditions: string[] = [];
  if (userLabel) preconditions.push(`Signed in as ${userLabel}`);
  for (const g of plan.given) {
    if (g.state.kind === "account" && userLabel) continue; // the "Signed in as" line says it
    preconditions.push(givenText(g, pageTitle));
  }

  const first = plan.steps[0];
  const startPage = first ? map.pages[first.location] : undefined;
  const start = startPage ? { page: startPage.title, url: startPage.sampleUrls[0] ?? `${origin}${startPage.urlPattern}` } : null;

  const steps: ManualStep[] = [];
  let current = first?.location;
  for (const s of plan.steps) {
    const step = ownSteps && s.origin.kind === "own" ? (ownSteps[s.origin.index] ?? s.step) : s.step;
    steps.push(
      manualStep(map, s.edge, step, {
        signInAs: ctx.signInAs,
        onPage: s.location !== current ? pageTitle(s.location) : undefined,
        fromCase: s.origin.kind === "required" ? s.origin.caseTitle : undefined,
      }),
    );
    current = pageAfterStep(s.step, s.edge);
  }

  return {
    id: testCase.id,
    title: testCase.title,
    status: testCase.status,
    ...(info ? { feature: { id: info.featureId, title: info.featureTitle }, useCase: { id: info.useCaseId, title: info.useCaseTitle } } : {}),
    preconditions,
    start,
    steps,
    ...(testCase.dataset && !ownSteps ? { dataset: testCase.dataset } : {}),
    destructive: plan.destructive,
    automated: plan.runnable,
    ...(testCase.notes ? { notes: testCase.notes } : {}),
  };
}

/** A data-driven case as one case per row (in a test-management tool each row is its own test),
 *  the row's values filled in — the same split the generated tests make. */
function manualCaseRows(ctx: ExportContext, testCase: TestCase, plan: CasePlan, info: CaseFeatureInfo | undefined): ManualCase[] {
  if (!testCase.dataset) return [manualCase(ctx, testCase, plan, info)];
  return expandRows(testCase).map((r) => {
    const c = manualCase(ctx, testCase, plan, info, r.steps);
    return { ...c, id: `${c.id}--${slug(r.row!.name)}`, title: `${c.title} — ${r.row!.name}` };
  });
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "row";

// ---- loading ----

/** The cases to export, in the order a reader expects: feature → use case → case as organized,
 *  then the unsorted ones in the generated specs' order. Project, feature and suite scopes take
 *  approved cases only; a single case or a hand-picked selection is exported whatever its status. */
export async function loadManualExport(repoRoot: string, map: NavigationMap, scope: ManualScope, opts: { expandRows: boolean; now?: Date }): Promise<ManualExport | { error: string }> {
  const [users, graph, flags, cases, org] = await Promise.all([
    loadProjectUsers(repoRoot, map),
    loadStateGraph(repoRoot, map.id, map),
    loadEdgeFlags(repoRoot, map.id),
    loadCases(repoRoot, map.id),
    loadOrganization(repoRoot, map.id),
  ]);
  const clean = org ? sanitizeOrganization(org, map, cases).org : null;
  const index = caseFeatureIndex(clean);
  const byId = new Map(cases.map((c) => [c.id, c]));

  const ordered: TestCase[] = [];
  const seen = new Set<string>();
  for (const f of clean?.features ?? []) {
    for (const u of f.useCases) {
      for (const id of u.cases) {
        const c = byId.get(id);
        if (c && !seen.has(id)) (ordered.push(c), seen.add(id));
      }
    }
  }
  const edgeOrder = new Map(Object.keys(map.edges).map((id, i) => [id, i]));
  const unsorted = cases
    .filter((c) => !seen.has(c.id))
    .sort((a, b) => (edgeOrder.get(a.steps[0].edgeId) ?? Infinity) - (edgeOrder.get(b.steps[0].edgeId) ?? Infinity) || a.createdAt.localeCompare(b.createdAt));
  ordered.push(...unsorted);

  let selected: TestCase[];
  let scopeLabel: string;
  if (scope.kind === "cases") {
    const picked = new Set(scope.caseIds);
    selected = ordered.filter((c) => picked.has(c.id));
    if (selected.length === 0) return { error: "None of the selected cases exists" };
    scopeLabel = `${selected.length} selected case${selected.length === 1 ? "" : "s"}`;
  } else if (scope.kind === "suite") {
    const suite = (await loadSuites(repoRoot, map.id)).suites.find((s) => s.id === scope.suiteId);
    if (!suite) return { error: `Unknown suite "${scope.suiteId}"` };
    const inSuite = new Set(suite.caseIds);
    selected = ordered.filter((c) => c.status === "approved" && inSuite.has(c.id));
    scopeLabel = `suite ${q(suite.name)}, approved cases`;
  } else if (scope.kind === "case") {
    const c = byId.get(scope.caseId);
    if (!c) return { error: `Unknown case "${scope.caseId}"` };
    selected = [c];
    scopeLabel = `case ${q(c.title)}`;
  } else if (scope.kind === "feature") {
    const feature = clean?.features.find((f) => f.id === scope.featureId);
    if (!feature) return { error: `Unknown feature "${scope.featureId}"` };
    selected = ordered.filter((c) => c.status === "approved" && index.get(c.id)?.featureId === feature.id);
    scopeLabel = `feature ${q(feature.title)}, approved cases`;
  } else {
    selected = ordered.filter((c) => c.status === "approved");
    scopeLabel = "whole project, approved cases";
  }

  const plans = planCases(map, users, graph, cases, flags);
  const ctx: ExportContext = { map, origin: resolveOrigin(map), signInAs: users.find((u) => u.kind === "auth" && !!u.credentialsRef)?.label };
  const out: ManualCase[] = [];
  for (const c of selected) {
    const plan = plans.get(c.id)!;
    out.push(...(opts.expandRows ? manualCaseRows(ctx, c, plan, index.get(c.id)) : [manualCase(ctx, c, plan, index.get(c.id))]));
  }
  return { host: map.targetHost, baseUrl: ctx.origin, exportedAt: (opts.now ?? new Date()).toISOString(), scopeLabel, cases: out };
}

// ---- Markdown ----

const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/\r?\n/g, "<br>");

/** One document: feature → use case headings, then each case with its preconditions, start page,
 *  a step table (step + data | expected result) and its data table when it has one. */
export function manualCasesMarkdown(exp: ManualExport): string {
  const lines: string[] = [];
  lines.push(`# Manual test cases — ${exp.host}`, "");
  lines.push(`${exp.cases.length} test case${exp.cases.length === 1 ? "" : "s"} · ${exp.scopeLabel} · exported ${exp.exportedAt.slice(0, 10)} · ${exp.baseUrl}`, "");
  lines.push(`Set up the preconditions, start on the page given, then do each step in order and check its expected result. Values in "quotes" are typed or picked exactly as written.`, "");

  let feature: string | null | undefined;
  let useCase: string | null | undefined;
  for (const c of exp.cases) {
    const f = c.feature?.title ?? null;
    if (f !== feature) {
      lines.push(`## ${f ?? "Not sorted into a feature"}`, "");
      feature = f;
      useCase = undefined;
    }
    const u = c.useCase?.title ?? null;
    if (u !== useCase && u) lines.push(`### ${u}`, "");
    useCase = u;

    lines.push(`#### ${c.title}`, "");
    const meta = [`\`${c.id}\``, c.automated ? "automated" : "not automated yet"];
    if (c.status !== "approved") meta.push(c.status);
    if (c.destructive) meta.push("**changes data on the site** — run it only where that's acceptable");
    lines.push(meta.join(" · "), "");
    if (c.notes) lines.push(`_${c.notes.replace(/\r?\n/g, " ")}_`, "");

    lines.push(`**Preconditions:**${c.preconditions.length ? "" : " none."}`);
    for (const p of c.preconditions) lines.push(`- ${p}`);
    lines.push("");
    if (c.start) lines.push(`**Start on:** ${c.start.page} — ${c.start.url}`, "");

    lines.push("| # | Step | Expected result |", "|---|------|-----------------|");
    c.steps.forEach((s, i) => {
      const step = cell(s.action) + (s.data.length ? `<br>**Data:** ${s.data.map(cell).join("; ")}` : "");
      lines.push(`| ${i + 1} | ${step} | ${s.expected.length ? s.expected.map(cell).join("<br>") : "—"} |`);
    });
    lines.push("");

    if (c.dataset) {
      lines.push(`**Test data** — do the steps once per row; \`{{column}}\` stands for that row's value:`, "");
      lines.push(`| Row | ${c.dataset.columns.map(cell).join(" | ")} |`, `|---|${c.dataset.columns.map(() => "---").join("|")}|`);
      for (const r of c.dataset.rows) lines.push(`| ${cell(r.name)} | ${c.dataset.columns.map((col) => cell(r.values[col] ?? "")).join(" | ")} |`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ---- CSV for test-management tools ----

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;
const csvLine = (values: string[]) => values.map(csvCell).join(",");

function preconditionBlock(c: ManualCase): string {
  return [...c.preconditions, ...(c.start ? [`Start on ${c.start.page} (${c.start.url})`] : [])].join("\n");
}

const folderParts = (c: ManualCase) => (c.feature ? [c.feature.title, ...(c.useCase ? [c.useCase.title] : [])] : ["Unsorted"]);
const stepWithData = (s: ManualStep) => [s.action, ...(s.data.length ? [`Data: ${s.data.join("; ")}`] : [])].join("\n");

/** One row per step, laid out the way each tool's importer reads several steps per test:
 *  - TestRail: "Test cases use multiple rows" — a new case starts where ID has a value.
 *  - Xray: rows with the same Issue Id are one test (Test Type "Manual").
 *  - Zephyr Scale: the test's fields on its first row, its other steps on rows below without a Name.
 *  Each importer still shows a column-mapping step; the headers use its own field names. */
export function manualCasesCsv(exp: ManualExport, flavor: Exclude<ManualFormat, "markdown">): string {
  const rows: string[] = [];
  if (flavor === "testrail") {
    rows.push(csvLine(["ID", "Title", "Section", "Preconditions", "Step", "Expected Result", "References"]));
    for (const c of exp.cases) {
      c.steps.forEach((s, i) => {
        const head = i === 0 ? [c.id, c.title, folderParts(c).join(" > "), preconditionBlock(c)] : ["", "", "", ""];
        rows.push(csvLine([...head, stepWithData(s), s.expected.join("\n"), i === 0 ? `automated test case: ${c.id}` : ""]));
      });
    }
  } else if (flavor === "xray") {
    rows.push(csvLine(["Issue Id", "Summary", "Test Type", "Description", "Test Repository Folder", "Labels", "Action", "Data", "Expected Result"]));
    exp.cases.forEach((c, n) => {
      const description = [preconditionBlock(c) && `Preconditions:\n${preconditionBlock(c)}`, `Automated test case: ${c.id}`].filter(Boolean).join("\n\n");
      c.steps.forEach((s, i) => {
        const head = i === 0 ? [c.title, "Manual", description, folderParts(c).map((p) => p.replace(/\//g, "-")).join("/"), c.destructive ? "destructive" : ""] : ["", "", "", "", ""];
        rows.push(csvLine([String(n + 1), ...head, s.action, s.data.join("\n"), s.expected.join("\n")]));
      });
    });
  } else {
    rows.push(csvLine(["Name", "Objective", "Precondition", "Folder", "Labels", "Test Script (Steps) - Step", "Test Script (Steps) - Expected Result"]));
    for (const c of exp.cases) {
      const objective = [c.useCase ? `Proves "${c.useCase.title}".` : "", `Automated test case: ${c.id}`].filter(Boolean).join(" ");
      c.steps.forEach((s, i) => {
        const head = i === 0 ? [c.title, objective, preconditionBlock(c), folderParts(c).map((p) => p.replace(/\//g, "-")).join("/"), c.destructive ? "destructive" : ""] : ["", "", "", "", ""];
        rows.push(csvLine([...head, stepWithData(s), s.expected.join("\n")]));
      });
    }
  }
  return rows.join("\r\n") + "\r\n";
}

export function renderManualExport(exp: ManualExport, format: ManualFormat): string {
  return format === "markdown" ? manualCasesMarkdown(exp) : manualCasesCsv(exp, format);
}

export function manualExportFileName(projectId: string, scope: ManualScope, format: ManualFormat): string {
  const suffix =
    scope.kind === "feature" ? `-${scope.featureId}` : scope.kind === "case" ? `-${scope.caseId}` : scope.kind === "cases" ? "-selection" : scope.kind === "suite" ? `-suite-${scope.suiteId}` : "";
  return `${projectId}-manual-cases${suffix}${format === "markdown" ? ".md" : `-${format}.csv`}`;
}
