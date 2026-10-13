import { writeFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ActionEdge, NavigationMap, PageNode } from "./navmap-types.js";
import { assertionExpr, locatorExpr, originMatchRegexLiteral, urlMatchRegexLiteral } from "./navmap-playwright-gen.js";
import { computeUiComponents, type UiComponent } from "./navmapUiComponents.js";
import {
  buildComponentClass,
  buildPageClass,
  componentClassName,
  instanceVarName,
  methodName,
  NameAllocator,
  pageClassName,
  type EdgeCallInfo,
  type GeneratedComponentClass,
  type GeneratedPageClass,
} from "./navmap-pom-generator.js";
import { caseHealth, expandRows, isNumericElement, pageAfterStep, requiredSteps, resolveElement, type ActionStep, type CaseHealth, type Given, type TestCase } from "./navmap-cases.js";
import { chooseUserForPage, userCanAccess, type ProjectUser } from "./navmap-users.js";
import type { LinkScope } from "./navmap-links.js";
import { bindingKey, EMPTY_GRAPH, type Binding, type State, type StateGraph } from "./navmap-states.js";
import { buildFixturesFile, buildUserPagesClass, planUserFixtures, type UserFixture } from "./navmap-fixtures-generator.js";
import { isDestructive, type EdgeFlags } from "./navmap-edge-flags.js";
import { caseFeatureIndex, type CaseFeatureInfo, type Organization } from "./navmap-features.js";
import { caseSuiteIndex, type SuitesFile } from "./navmap-suites.js";
import { caseRequirementIndex, type RequirementsFile } from "./navmap-requirements.js";

function jsStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/** All pages in one navmap share a single host/origin by construction (/navmap scopes one run
 *  to one baseUrl's origin) — resolved once from any recorded sampleUrl so url_matches
 *  assertions are anchored against the real scheme, not a hardcoded https guess. */
export function resolveOrigin(map: NavigationMap): string {
  for (const page of Object.values(map.pages)) {
    const sample = page.sampleUrls[0];
    if (!sample) continue;
    try {
      return new URL(sample).origin;
    } catch {
      // malformed sampleUrl — keep looking
    }
  }
  return `https://${map.targetHost}`;
}

/** Only ever used to decide whether anything OTHER than "being logged in" still blocks an edge
 *  whose test runs as an authenticated user (structured signal: the user chosen for its page is
 *  an auth user with credentials, so a real session will exist). This text match can only make
 *  an edge MORE conservative, never less: if the phrasing doesn't match, the precondition stays
 *  listed and the edge stays fixme — it never promotes anything that structured gate didn't
 *  already allow. */
const AUTH_PRECONDITION_RE = /\blog(ged)?[\s-]?in\b/i;

export function remainingPreconditions(edge: ActionEdge, authAvailable: boolean): string[] {
  if (!authAvailable) return edge.preconditions;
  return edge.preconditions.filter((p) => !AUTH_PRECONDITION_RE.test(p));
}

export interface PlannedStep {
  edge: ActionEdge;
  scope: LinkScope;
  /** Page the step runs on: its own page for persistent setup, the page of whatever needs it for
   *  same-page setup (transient state only exists where it was created). */
  location: string;
  /** The list item this setup acts on, when its state takes the consumer's item (sameItem). */
  item?: string;
  /** True when that item comes from the test's own action through an unbroken chain of shared
   *  items — a case that picks another item then carries it into this setup step too. */
  sharesRootItem?: boolean;
  /** The precondition that brought in the state this step produces (consumer edge + text). */
  viaLink?: { edgeId: string; precondition: string; shareItem: boolean };
  /** The state whose flow this step belongs to. */
  stateId?: string;
  /** The flow step itself (input/form overrides). */
  step?: ActionStep;
}

/** A state the test is put in before its own steps, with the flow steps that produce it (none for
 *  states that are already true at the start, or that only pick the user). */
export interface PlannedState {
  state: State;
  /** Transient: the page that needs it (where its flow runs). Persistent: its flow's first page. */
  location: string;
  /** The list item its flow acts on, when it isn't the recorded one (per-item states). */
  item?: string;
  sharesRootItem?: boolean;
  steps: PlannedStep[];
  /** Why it's there: a precondition of an action, the case's own `given`, or another state's `requires`. */
  via: { kind: "precondition"; edgeId: string; precondition: string; sameItem: boolean } | { kind: "given" } | { kind: "requires"; from: string };
}

export interface EdgePlan {
  runnable: boolean;
  /** The user the edge's test runs as (undefined when no configured user can reach its page). */
  user?: ProjectUser;
  /** Runnable and runs as an authenticated user — i.e. needs that user's saved session. */
  authDependent: boolean;
  /** Why it isn't runnable, when it isn't. */
  blockers: string[];
  /** Every setup action, flattened in run order (the states' flow steps). */
  setup: PlannedStep[];
  /** The states the test is put in first, in order — shown in the UI as the "why". */
  given: PlannedState[];
}

const MAX_CHAIN_DEPTH = 5;

interface ChainContext {
  map: NavigationMap;
  bindings: Map<string, Binding>;
  states: Map<string, State>;
  runnerIsAuth: boolean;
}

interface Chain {
  states: PlannedState[];
  blockers: string[];
  /** Users that account states ask the test to run as. */
  accounts: Set<string>;
}

const emptyChain = (): Chain => ({ states: [], blockers: [], accounts: new Set() });
function absorb(into: Chain, from: Chain): void {
  into.states.push(...from.states);
  into.blockers.push(...from.blockers);
  for (const a of from.accounts) into.accounts.add(a);
}

type ItemContext = { item: string | undefined; fromRoot: boolean };

/** The states a consumer action's preconditions point to, expanded recursively (a flow's first
 *  action can have preconditions of its own). Persistent states come before same-page ones:
 *  persistent flows may navigate, and running them later would wipe the transient state. */
function resolveConsumer(ctx: ChainContext, consumer: ActionEdge, location: string, visiting: Set<string>, depth: number, consumerItem: ItemContext): Chain {
  const persistent = emptyChain();
  const transient = emptyChain();
  const blockers: string[] = [];
  for (const precondition of remainingPreconditions(consumer, ctx.runnerIsAuth)) {
    const binding = ctx.bindings.get(bindingKey(consumer.id, precondition));
    if (!binding) {
      blockers.push(`Precondition not linked to a state yet: "${precondition}" — link it in 🧩 States.`);
      continue;
    }
    const state = ctx.states.get(binding.stateId);
    if (!state) {
      blockers.push(`"${precondition}" points to a state that no longer exists — re-link it in 🧩 States.`);
      continue;
    }
    const shared = !!binding.sameItem && consumerItem.item !== undefined;
    const chain = resolveState(ctx, state, location, visiting, depth, shared ? consumerItem : undefined, {
      kind: "precondition",
      edgeId: consumer.id,
      precondition,
      sameItem: !!binding.sameItem,
    });
    absorb(state.kind === "transient" ? transient : persistent, chain);
  }
  const out = emptyChain();
  absorb(out, persistent);
  absorb(out, transient);
  out.blockers.unshift(...blockers);
  return out;
}

/** One state: nothing to do (already true / picks the user), a blocker (no way to reach it yet,
 *  or not automatable), or its flow — after whatever that flow itself needs. */
function resolveState(ctx: ChainContext, state: State, consumerLocation: string, visiting: Set<string>, depth: number, itemCtx: ItemContext | undefined, via: PlannedState["via"]): Chain {
  const out = emptyChain();
  if (state.notAutomatable) {
    out.blockers.push(`Can't be automated: "${state.title}" — ${state.notAutomatable.reason}`);
    return out;
  }
  if (state.kind === "initial") {
    out.states.push({ state, location: consumerLocation, steps: [], via });
    return out;
  }
  if (state.kind === "account") {
    if (state.userId) out.accounts.add(state.userId);
    out.states.push({ state, location: consumerLocation, steps: [], via });
    return out;
  }
  if (!state.flow?.length) {
    out.blockers.push(`No one knows how to reach "${state.title}" yet — answer it in 🧩 States.`);
    return out;
  }
  if (visiting.has(state.id)) {
    out.blockers.push(`Circular setup chain through "${state.title}".`);
    return out;
  }
  if (depth >= MAX_CHAIN_DEPTH) {
    out.blockers.push(`Setup chain is deeper than ${MAX_CHAIN_DEPTH} levels (at "${state.title}").`);
    return out;
  }
  const next = new Set([...visiting, state.id]);
  const transient = state.kind === "transient";
  for (const requiredId of state.requires ?? []) {
    const required = ctx.states.get(requiredId);
    if (!required) out.blockers.push(`"${state.title}" requires a state that no longer exists ("${requiredId}").`);
    else absorb(out, resolveState(ctx, required, consumerLocation, next, depth + 1, undefined, { kind: "requires", from: state.id }));
  }
  const steps: PlannedStep[] = [];
  let item: string | undefined;
  let sharesRootItem: boolean | undefined;
  for (const [i, flowStep] of state.flow.entries()) {
    const edge = ctx.map.edges[flowStep.edgeId];
    if (!edge) {
      out.blockers.push(`The flow of "${state.title}" uses an action that's no longer in the map ("${flowStep.edgeId}") — fix it in 🧩 States.`);
      continue;
    }
    const stepLocation = transient ? consumerLocation : (flowStep.on ?? edge.fromPageId);
    const shared = !!state.perItem && !!edge.scope && !flowStep.item && itemCtx?.item !== undefined;
    const stepItem = shared ? itemCtx!.item : (flowStep.item ?? edge.scope?.hasText);
    if (shared) {
      item = itemCtx!.item;
      sharesRootItem = itemCtx!.fromRoot;
    }
    // Like a case: only the flow's first action's preconditions need setup — the later ones rely
    // on the earlier steps of the same flow.
    if (i === 0) absorb(out, resolveConsumer(ctx, edge, stepLocation, next, depth + 1, { item: stepItem, fromRoot: shared && !!itemCtx?.fromRoot }));
    steps.push({
      edge,
      scope: transient ? "same-page" : "persistent",
      location: stepLocation,
      stateId: state.id,
      step: flowStep,
      ...(via.kind === "precondition" ? { viaLink: { edgeId: via.edgeId, precondition: via.precondition, shareItem: via.sameItem } } : {}),
      ...(shared ? { item: stepItem, sharesRootItem: itemCtx!.fromRoot } : flowStep.item ? { item: flowStep.item } : {}),
    });
  }
  out.states.push({ state, location: steps[0]?.location ?? consumerLocation, steps, via, ...(item !== undefined ? { item, sharesRootItem } : {}) });
  return out;
}

/** A state needed twice (two preconditions, a case's given and its first action) runs once —
 *  opening a menu twice would close it again. */
function dedupeStates(states: PlannedState[]): PlannedState[] {
  const seen = new Set<string>();
  return states.filter((s) => {
    const key = `${s.state.id}@${s.location}#${s.item ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function componentMembership(map: NavigationMap): Map<string, UiComponent> {
  const edgeIdToComponent = new Map<string, UiComponent>();
  for (const component of computeUiComponents(map).values()) {
    for (const element of component.elements) {
      for (const edge of element.memberEdges) edgeIdToComponent.set(edge.id, component);
    }
  }
  return edgeIdToComponent;
}

interface SetupContext {
  map: NavigationMap;
  users: ProjectUser[];
  graph: StateGraph;
  bindings: Map<string, Binding>;
  states: Map<string, State>;
  edgeIdToComponent: Map<string, UiComponent>;
  loginUser: ProjectUser | undefined;
}

function setupContext(map: NavigationMap, users: ProjectUser[], graph: StateGraph): SetupContext {
  return {
    map,
    users,
    graph,
    bindings: new Map(graph.bindings.map((b) => [bindingKey(b.edgeId, b.precondition), b])),
    states: new Map(graph.states.map((s) => [s.id, s])),
    edgeIdToComponent: componentMembership(map),
    loginUser: users.find((u) => u.kind === "auth" && !!u.credentialsRef),
  };
}

/** Who runs a test that starts with `edge` on `location`, which states it's put in first (the
 *  case's own `given`, then what the action's preconditions point to) and whether that setup can
 *  actually run. Shared by single actions and cases, so they can never disagree. */
function planSetup(sc: SetupContext, edge: ActionEdge, location: string, given: Given[], rootItem: string | undefined): Omit<EdgePlan, "runnable" | "authDependent"> {
  const { map, users } = sc;
  const pageTitle = (id: string) => map.pages[id]?.title ?? id;
  const page = map.pages[location];
  let user = page ? chooseUserForPage(page, users) : undefined;
  if (!user) return { blockers: [`No configured user can access "${pageTitle(location)}" — grant access in the Users tab.`], setup: [], given: [] };

  const solve = (runner: ProjectUser): Chain => {
    const ctx: ChainContext = { map, bindings: sc.bindings, states: sc.states, runnerIsAuth: runner.kind === "auth" };
    const chain = emptyChain();
    for (const g of given) {
      const state = sc.states.get(g.state);
      if (!state) chain.blockers.push(`Given state "${g.state}" doesn't exist anymore — pick another in the case.`);
      else absorb(chain, resolveState(ctx, state, location, new Set(), 0, g.item ? { item: g.item, fromRoot: false } : undefined, { kind: "given" }));
    }
    // The login action itself needs no setup: its test starts logged out.
    if (!edge.authFormLocators) absorb(chain, resolveConsumer(ctx, edge, location, new Set(), 0, { item: rootItem ?? edge.scope?.hasText, fromRoot: true }));
    return chain;
  };

  let chain = solve(user);
  const blockers: string[] = [];
  // An account state picks the user the test runs as.
  if (chain.accounts.size > 1) {
    blockers.push(`Needs two different users at once (${[...chain.accounts].join(", ")}) — a test runs as one user.`);
  } else if (chain.accounts.size === 1) {
    const wanted = users.find((u) => u.id === [...chain.accounts][0]);
    if (!wanted) blockers.push(`Needs user "${[...chain.accounts][0]}", who isn't configured — add them in the Users tab.`);
    else if (!page || !userCanAccess(wanted, page)) blockers.push(`Needs ${wanted.label}, who can't access "${pageTitle(location)}".`);
    else if (wanted.id !== user.id) {
      user = wanted;
      chain = solve(user);
    }
  }
  if (edge.authFormLocators && !sc.loginUser) blockers.push("No auth user with credentials to log in with — add one in the Users tab.");

  const states = dedupeStates(chain.states);
  const setup = states.flatMap((s) => s.steps);
  blockers.push(...chain.blockers);
  for (const step of setup) {
    const where = map.pages[step.location];
    if (!where || !userCanAccess(user, where)) {
      blockers.push(`${user.label} can't access "${pageTitle(step.location)}", where setup "${step.edge.semanticIntent}" runs.`);
    }
    // Running it elsewhere needs a shared UI component that the map saw on THAT page too.
    const component = sc.edgeIdToComponent.get(step.edge.id);
    if (step.location !== step.edge.fromPageId && !component?.pageIds.includes(step.location)) {
      blockers.push(
        component
          ? `Setup "${step.edge.semanticIntent}" belongs to the ${component.regionName}, which the map hasn't seen on "${pageTitle(step.location)}" — explore that page to record it.`
          : `Setup "${step.edge.semanticIntent}" was recorded on "${pageTitle(step.edge.fromPageId)}" and isn't part of a shared UI component, so it can't be performed on "${pageTitle(step.location)}".`,
      );
    }
    if (step.scope === "same-page" && step.edge.toPageId !== step.edge.fromPageId && !step.edge.external) {
      blockers.push(`Same-page setup "${step.edge.semanticIntent}" navigates away, which would undo the state it's meant to create.`);
    }
  }
  return { user, blockers: [...new Set(blockers)], setup, given: states };
}

/** Single source of truth for "which user runs this edge's test, what setup it needs, and can it
 *  run at all" — used by both the spec generator and the coverage API, so the UI's runnable/fixme
 *  badges can never disagree with the code that was actually generated. */
export function planEdges(map: NavigationMap, users: ProjectUser[], graph: StateGraph = EMPTY_GRAPH): Map<string, EdgePlan> {
  const sc = setupContext(map, users, graph);
  const plans = new Map<string, EdgePlan>();
  for (const edge of Object.values(map.edges)) {
    const planned = planSetup(sc, edge, edge.fromPageId, [], undefined);
    const runnable = planned.blockers.length === 0 && !!planned.user;
    plans.set(edge.id, {
      ...planned,
      runnable,
      authDependent: runnable && planned.user!.kind === "auth" && !edge.authFormLocators,
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------------------------
// Test cases → plans. A case's steps reference map actions; planning decides who runs it, what
// precondition-link setup its first step needs, and whether it can run at all.

export type StepOrigin = { kind: "required"; caseTitle: string } | { kind: "own"; index: number };

export interface CaseRunStep {
  edge: ActionEdge;
  step: ActionStep;
  /** Page the step runs on (step.on for a shared component action, else where it was recorded). */
  location: string;
  origin: StepOrigin;
}

export interface CasePlan {
  testCase: TestCase;
  health: CaseHealth;
  runnable: boolean;
  user?: ProjectUser;
  authDependent: boolean;
  blockers: string[];
  /** Setup of the first step that runs, flattened (the given states' flow steps). */
  setup: PlannedStep[];
  /** The states the test is put in before its steps: the case's own `given`, then what its first action's preconditions point to. */
  given: PlannedState[];
  /** What the test performs after setup: the required cases' steps, then the case's own. */
  steps: CaseRunStep[];
  /** Page of the case's own first step — the spec file the test lands in. */
  firstPageId: string | undefined;
  destructive: boolean;
  /** The data row this plan is for (cases with a data table generate one test per row). */
  row?: string;
}

interface CasePlanContext {
  map: NavigationMap;
  users: ProjectUser[];
  setup: SetupContext;
  casesById: Map<string, TestCase>;
  edgeIdToComponent: Map<string, UiComponent>;
  loginUser: ProjectUser | undefined;
  flags: EdgeFlags | undefined;
}

function planCase(testCase: TestCase, ctx: CasePlanContext): CasePlan {
  const { map } = ctx;
  const health = caseHealth(testCase, map, ctx.casesById);
  const ownFirst = map.edges[testCase.steps[0].edgeId];
  const firstPageId = testCase.steps[0].on ?? ownFirst?.fromPageId;
  const empty = { testCase, health, setup: [], given: [], steps: [], firstPageId, authDependent: false, destructive: false };
  if (health.health === "needs_review") return { ...empty, runnable: false, blockers: health.reasons };

  const ordered: { step: ActionStep; origin: StepOrigin }[] = [
    ...requiredSteps(testCase, ctx.casesById).map((r) => ({ step: r.step, origin: { kind: "required", caseTitle: r.fromCase.title } as StepOrigin })),
    ...testCase.steps.map((step, index) => ({ step, origin: { kind: "own", index } as StepOrigin })),
  ];
  const steps: CaseRunStep[] = ordered.map(({ step, origin }) => {
    const edge = map.edges[step.edgeId];
    return { edge, step, location: step.on ?? edge.fromPageId, origin };
  });

  // The first step that runs decides the user and its setup (the case's given states, then what
  // its preconditions point to) — exactly what a single-action test gets. Later steps'
  // preconditions don't block: whoever composed the case put the earlier steps there to satisfy them.
  const firstPlan = planSetup(ctx.setup, steps[0].edge, steps[0].location, testCase.given ?? [], steps[0].step.item);
  const user = firstPlan.user;
  const blockers = [...firstPlan.blockers];
  const pageTitle = (id: string) => map.pages[id]?.title ?? id;

  steps.forEach((s, i) => {
    const label = steps.length > 1 ? `Step ${i + 1} ("${s.edge.semanticIntent}")` : `"${s.edge.semanticIntent}"`;
    const inComponent = ctx.edgeIdToComponent.has(s.edge.id);
    if (s.location !== s.edge.fromPageId && !inComponent) {
      blockers.push(`${label} was recorded on "${pageTitle(s.edge.fromPageId)}" and isn't part of a shared UI component, so it can't run on "${pageTitle(s.location)}".`);
    }
    if (s.step.item && inComponent) blockers.push(`${label} is a shared component action — choosing a list item isn't supported for it.`);
    if (i === 0) return;
    if (s.edge.authFormLocators && !ctx.loginUser) blockers.push(`${label} logs in, but no auth user has credentials — add one in the Users tab.`);
    const where = map.pages[s.location];
    if (user && (!where || !userCanAccess(user, where))) {
      blockers.push(`${label} runs on "${pageTitle(s.location)}", which ${user.label} can't access — start the case as a user who can.`);
    }
  });

  const destructive = [...firstPlan.setup.map((s) => s.edge), ...steps.map((s) => s.edge)].some((e) => isDestructive(e, ctx.flags));
  const runnable = blockers.length === 0 && !!user;
  return {
    testCase,
    health,
    runnable,
    user,
    authDependent: runnable && user!.kind === "auth" && !steps[0].edge.authFormLocators,
    blockers: [...new Set(blockers)],
    setup: firstPlan.setup,
    given: firstPlan.given,
    steps,
    firstPageId,
    destructive,
  };
}

/** Single source of truth for every case's runnable/fixme status — used by the generator and the
 *  cases API alike, so the UI can never disagree with the code that was generated. */
export function planCases(
  map: NavigationMap,
  users: ProjectUser[],
  graph: StateGraph,
  cases: TestCase[],
  flags?: EdgeFlags,
): Map<string, CasePlan> {
  const ctx = planContext(map, users, graph, cases, flags);
  return new Map(cases.map((c) => [c.id, planCase(c, ctx)]));
}

function planContext(map: NavigationMap, users: ProjectUser[], graph: StateGraph, cases: TestCase[], flags?: EdgeFlags): CasePlanContext {
  const setup = setupContext(map, users, graph);
  return {
    map,
    users,
    setup,
    casesById: new Map(cases.map((c) => [c.id, c])),
    edgeIdToComponent: setup.edgeIdToComponent,
    loginUser: setup.loginUser,
    flags,
  };
}

/** One plan per test the case generates: one per data row (title "<title> — <row>", values
 *  substituted, a row whose expected value isn't filled in stays fixme), or just the case's own. */
function planCaseRows(testCase: TestCase, ctx: CasePlanContext): CasePlan[] {
  return expandRows(testCase).map((r) => {
    const concrete = r.row ? { ...testCase, title: `${testCase.title} — ${r.row.name}`, steps: r.steps } : testCase;
    const plan = planCase(concrete, ctx);
    if (r.row) plan.row = r.row.name;
    if (r.blocker) {
      plan.runnable = false;
      plan.authDependent = false;
      plan.blockers = [...plan.blockers, r.blocker];
    }
    return plan;
  });
}

// ---------------------------------------------------------------------------------------------
// Plans → code.

interface SpecContext {
  map: NavigationMap;
  origin: string;
  /** Every page's generated class — steps can run on any page. */
  generatedPages: Map<string, GeneratedPageClass>;
  fixtures: UserFixture[];
  loginUser: ProjectUser | undefined;
  /** caseId -> its feature/use case (tests get a feature tag + a use case annotation). */
  organization: Map<string, CaseFeatureInfo>;
  /** caseId -> the suites it's in (tests get one @suite-<id> tag each). */
  suites: Map<string, string[]>;
  /** caseId -> the requirements it proves (tests get one @req-<id> tag each). */
  requirements: Map<string, string[]>;
  /** stateId -> its generated function in flows.ts (persistent states with a flow). */
  flows: Map<string, FlowFunction>;
}

interface FlowFunction {
  name: string;
  /** Set when the flow takes a list item: the item it acts on by default. */
  defaultItem?: string;
  /** The page the flow leaves the browser on. */
  endPage: string;
}

/** flows.ts: one reusable function per persistent state with a flow ("Cart has items"), built from
 *  the same page-object methods the tests call. A function takes any user's page wrapper that has
 *  the pages it needs (structural type), so guest and logged-in tests share it. Transient states
 *  (an open menu) aren't here: they must run on the test's own page, so their steps stay inline. */
function buildFlowsFile(graph: StateGraph, map: NavigationMap, generatedPages: Map<string, GeneratedPageClass>): { source: string | null; flows: Map<string, FlowFunction> } {
  const flows = new Map<string, FlowFunction>();
  const names = new NameAllocator();
  const blocks: string[] = [];
  const imports = new Set<string>();
  for (const state of graph.states) {
    if (state.kind !== "persistent" || !state.flow?.length || state.notAutomatable) continue;
    const lines: string[] = [];
    const params = new Map<string, string>(); // page var -> class
    let current: string | undefined;
    let defaultItem: string | undefined;
    let ok = true;
    for (const step of state.flow) {
      const edge = map.edges[step.edgeId];
      const location = step.on ?? edge?.fromPageId;
      const generated = location ? generatedPages.get(location) : undefined;
      const info = edge ? generated?.edgeCallInfo.get(edge.id) : undefined;
      if (!edge || !generated || !info || info.argStyle === "login") {
        ok = false;
        break;
      }
      const v = instanceVarName(generated.className);
      params.set(v, generated.className);
      if (current !== location) lines.push(`await user.${v}.goto();`);
      const usesItem = !!state.perItem && !!info.item && !step.item;
      if (usesItem) defaultItem ??= edge.scope?.hasText ?? info.item!.recorded;
      lines.push(`await user.${v}.${info.methodPath}(${callArgs(info, edge, step, usesItem ? "item" : undefined)});`);
      current = edge.toPageId !== edge.fromPageId && !edge.external ? edge.toPageId : location;
    }
    if (!ok || !current) continue;
    const name = names.take(methodName(state.title));
    for (const cls of params.values()) imports.add(cls);
    const userType = `{ ${[...params].map(([v, cls]) => `${v}: ${cls}`).join("; ")} }`;
    const itemParam = defaultItem !== undefined ? `, item = ${jsStringLiteral(defaultItem)}` : "";
    const steps = state.flow.map((st) => map.edges[st.edgeId]!.semanticIntent).join(" → ");
    blocks.push(`/** ${state.title.replace(/\*\//g, "* /")} — ${steps.replace(/\*\//g, "* /")}. */
export async function ${name}(user: ${userType}${itemParam}): Promise<void> {
${lines.map((l) => `  ${l}`).join("\n")}
}`);
    flows.set(state.id, { name, ...(defaultItem !== undefined ? { defaultItem } : {}), endPage: current });
  }
  if (blocks.length === 0) return { source: null, flows };
  const source = `// Generated reusable setup flows — one per state a test can be put in (projects/<id>/states.json). Do not hand-edit, regenerate instead.
${[...imports].sort().map((cls) => `import type { ${cls} } from "./pages/${cls}";`).join("\n")}

${blocks.join("\n\n")}
`;
  return { source, flows };
}

function urlRegexFor(edge: ActionEdge, ctx: SpecContext): string | undefined {
  const destPage = ctx.map.pages[edge.toPageId];
  return destPage ? urlMatchRegexLiteral(ctx.origin, destPage.urlPattern) : undefined;
}

/** The step's checked postconditions, then page identity: a navigating edge also proves it arrived
 *  (URL when no postcondition checks it already, plus the destination's recorded landmark), and an
 *  external edge asserts the off-origin URL instead of anything on a map page. A check recorded on
 *  another list item than the one this step acts on becomes a TODO rather than a wrong assertion. */
function assertionsFor(edge: ActionEdge, step: ActionStep, clickedExpr: string, ctx: SpecContext): string[] {
  // A case may set the expected literal of a has_text/count check; the locator stays the map's.
  const posts = (step.assert ? edge.postconditions.filter((p) => step.assert!.includes(p.description)) : edge.postconditions).map((p) => {
    const value = step.expect?.[p.description];
    if (value === undefined || (p.check?.kind !== "has_text" && p.check?.kind !== "count")) return p;
    return { ...p, check: { ...p.check, value: p.check.kind === "count" ? Number(value) : String(value) } };
  });
  if (edge.external) {
    const regex = originMatchRegexLiteral(edge.external.url);
    const subject = edge.external.opensNewTab ? "popup" : "page";
    return [
      regex
        ? `await expect(${subject}).toHaveURL(${regex}); // external: ${edge.external.url}`
        : `// TODO: assert the external destination (unparseable url ${JSON.stringify(edge.external.url)})`,
      ...posts.map((p) => `// external page, not asserted: ${p.description}`),
    ];
  }
  const navigates = edge.fromPageId !== edge.toPageId;
  const urlRegex = urlRegexFor(edge, ctx);
  const recordedItem = edge.scope?.hasText;
  const otherItem = step.item && recordedItem && step.item !== recordedItem ? step.item : undefined;
  const lines = posts.map((post) =>
    otherItem && JSON.stringify(post.check ?? {}).includes(recordedItem!)
      ? `// TODO: assert ${JSON.stringify(post.description)} (recorded for "${recordedItem}", this step uses "${otherItem}")`
      : assertionExpr(clickedExpr, post, !navigates, urlRegex),
  );
  if (navigates) {
    const dest = ctx.map.pages[edge.toPageId];
    if (urlRegex && !lines.some((l) => l.includes("toHaveURL("))) {
      lines.push(`await expect(page).toHaveURL(${urlRegex}); // arrived on ${dest?.title ?? edge.toPageId}`);
    }
    if (dest?.anchor) {
      const anchor = `await expect(${locatorExpr(dest.anchor)}).toBeVisible(); // "${dest.title}" landmark`;
      if (!lines.some((l) => l.startsWith(anchor.split(";")[0]))) lines.push(anchor);
    }
  }
  return lines;
}

/** Arguments for a POM action call, positional as the generator declares them: (value | key)?,
 *  form?, item? — only what the step overrides, `undefined` where a later one needs the slot. */
function callArgs(info: EdgeCallInfo, edge: ActionEdge, step: Partial<ActionStep>, itemExpr?: string): string {
  const args: (string | undefined)[] = [];
  if (info.argStyle === "value") args.push(jsStringLiteral(step.input ?? edge.inputValue ?? ""));
  else if (info.argStyle === "key") args.push(step.input !== undefined ? jsStringLiteral(step.input) : undefined);
  if (info.formKeys?.length) {
    const overrides = step.form ?? {};
    const changed = info.formKeys.some((k) => k.label in overrides && overrides[k.label] !== k.value);
    args.push(changed ? `{ ${info.formKeys.map((k) => `${k.key}: ${jsStringLiteral(overrides[k.label] ?? k.value)}`).join(", ")} }` : undefined);
  }
  if (info.item) args.push(itemExpr ?? (step.item && step.item !== info.item.recorded ? jsStringLiteral(step.item) : undefined));
  while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
  return args.map((a) => a ?? "undefined").join(", ");
}

function clickedExprFor(pageVar: string, info: EdgeCallInfo, step: Partial<ActionStep>): string {
  if (info.item && step.item && step.item !== info.item.recorded) return `${pageVar}.${info.item.getterPath}(${jsStringLiteral(step.item)})`;
  return `${pageVar}.${info.locatorPath}`;
}

function testBlock(title: string, details: string, fixtureName: string, lines: string[]): string {
  // `page` is only bound when a line uses it (URL assertions, check locators, popups), so the
  // generated file has no unused locals. Page-object variables end in "Page." so they don't match.
  const needsPage = lines.some((l) => /(^|[^\w.])page[.)]/.test(l) || l.includes("expect(page"));
  const body = [...(needsPage ? [`const { page } = ${fixtureName};`] : []), ...lines].map((l) => `  ${l}`).join("\n");
  return `test(${title}, ${details}, async ({ ${fixtureName} }) => {
${body}
});`;
}

/** Every test (fixme stubs included) carries its case id — the stable link from a test back to its
 *  case, used to run a single test (file:line), map results onto cases, and find a test's code —
 *  plus the edge of its last step, which the map's result heatmap colors. A test whose setup or any
 *  step is destructive is tagged @destructive, which dashboard runs exclude unless asked. A case
 *  sorted into a use case is tagged @feature-<featureId> (stable across renames) and annotated
 *  with "Feature › Use case"; an unsorted case's test is unchanged. */
function caseDetails(plan: CasePlan, org: Map<string, CaseFeatureInfo>, suites: Map<string, string[]>, requirements: Map<string, string[]>): string {
  const c = plan.testCase;
  const lastEdgeId = c.steps[c.steps.length - 1].edgeId;
  const feature = org.get(c.id);
  const tags = [
    ...(feature ? [`@feature-${feature.featureId}`] : []),
    ...(suites.get(c.id) ?? []).map((id) => `@suite-${id}`),
    ...(requirements.get(c.id) ?? []).map((id) => `@req-${id}`),
    ...(plan.destructive ? ["@destructive"] : []),
  ];
  const tag = tags.length ? `, tag: [${tags.map(jsStringLiteral).join(", ")}]` : "";
  const row = plan.row !== undefined ? `, { type: "row", description: ${jsStringLiteral(plan.row)} }` : "";
  const useCase = feature ? `, { type: "use case", description: ${jsStringLiteral(`${feature.featureTitle} › ${feature.useCaseTitle}`)} }` : "";
  return `{ annotation: [{ type: "case", description: ${jsStringLiteral(c.id)} }, { type: "edge", description: ${jsStringLiteral(lastEdgeId)} }${row}${useCase}]${tag} }`;
}

function generatorError(title: string, details: string, what: string): string {
  return `test.fixme(${title}, ${details}, async () => {
  // Generator error: ${what} — regenerate or report a bug.
});`;
}

const RESERVED_NAMES = new Set(["page", "popup", "popupPromise", "username", "password", "expect", "test"]);

/** Captured values become locals; a name that could clash with a page variable, a fixture or a
 *  generated local gets a "Value" suffix. */
function valueVar(name: string): string {
  return RESERVED_NAMES.has(name) || /(Page|User)$/.test(name) ? `${name}Value` : name;
}

/** The capture/verify lines a step adds after its own checks — reading PageNode.elements through
 *  the page object of the page the step left the browser on (caseHealth guarantees that page).
 *  Numbers are compared with toBeCloseTo, so 29.99 + 9.99 matches "$39.98". Returns an error
 *  message instead when something can't be generated. */
function buildValueLines(
  step: ActionStep,
  ctx: SpecContext,
  declare: (pageId: string) => string | undefined,
  varKinds: Map<string, boolean>,
): string[] | string {
  const lines: string[] = [];
  const elementExpr = (ref: string, item: string | undefined): { expr: string; numeric: boolean; label: string } | string => {
    const found = resolveElement(ctx.map, ref);
    if (!found) return `element "${ref}" is not in the map`;
    const v = declare(found.pageId);
    const info = ctx.generatedPages.get(found.pageId)?.elementInfo.get(found.element.id);
    if (!v || !info) return `element "${ref}" has no page object`;
    const expr = info.getter
      ? `${v}.${info.getter}(${item && item !== info.recordedItem ? jsStringLiteral(item) : ""})`
      : `${v}.${info.field}`;
    const label = item ? `${found.element.label} (${item})` : found.element.label;
    return { expr, numeric: isNumericElement(found.element), label };
  };

  for (const c of step.capture ?? []) {
    const el = elementExpr(c.element, c.item);
    if (typeof el === "string") return el;
    const name = valueVar(c.as);
    lines.push(`const ${name} = await ${el.numeric ? "readAmount" : "readText"}(${el.expr}); // capture: ${el.label}`);
    varKinds.set(c.as, el.numeric);
  }

  for (const check of step.verify ?? []) {
    const el = elementExpr(check.element, check.item);
    if (typeof el === "string") return el;
    const msg = jsStringLiteral(el.label);
    if (check.op === "visible" || check.op === "hidden") {
      lines.push(`await expect(${el.expr}, ${msg}).${check.op === "visible" ? "toBeVisible" : "toBeHidden"}();`);
      continue;
    }
    if (check.equalsSumOf) {
      const sum = check.equalsSumOf.map(valueVar).join(" + ");
      lines.push(`expect(await readAmount(${el.expr}), ${jsStringLiteral(`${el.label} = ${check.equalsSumOf.join(" + ")}`)}).toBeCloseTo(${sum}, 2);`);
      continue;
    }
    if (check.equalsVar) {
      const name = valueVar(check.equalsVar);
      const numericVar = varKinds.get(check.equalsVar) ?? false;
      if (check.op === "contains") lines.push(`await expect(${el.expr}, ${msg}).toContainText(String(${name}));`);
      else if (el.numeric && numericVar) lines.push(`expect(await readAmount(${el.expr}), ${jsStringLiteral(`${el.label} = ${check.equalsVar}`)}).toBeCloseTo(${name}, 2);`);
      else lines.push(`await expect(${el.expr}, ${msg}).toHaveText(String(${name}));`);
      continue;
    }
    const value = check.value!;
    if (check.op === "contains") {
      lines.push(`await expect(${el.expr}, ${msg}).toContainText(${jsStringLiteral(String(value))});`);
    } else if (el.numeric && !Number.isNaN(Number(value))) {
      lines.push(`expect(await readAmount(${el.expr}), ${msg}).toBeCloseTo(${Number(value)}, 2);`);
    } else {
      lines.push(`await expect(${el.expr}, ${msg}).toHaveText(${jsStringLiteral(String(value))});`);
    }
  }
  return lines;
}

export function buildCaseBlock(plan: CasePlan, ctx: SpecContext): string {
  const c = plan.testCase;
  const title = jsStringLiteral(c.title);
  const details = caseDetails(plan, ctx.organization, ctx.suites, ctx.requirements);
  const fixture = plan.user ? ctx.fixtures.find((f) => f.user.id === plan.user!.id) : undefined;
  const fixtureName = fixture?.fixtureName;

  if (!plan.runnable || !fixture || !fixtureName) {
    const ownFirst = c.steps[0];
    const edge = ctx.map.edges[ownFirst.edgeId];
    const location = ownFirst.on ?? edge?.fromPageId;
    const generated = location ? ctx.generatedPages.get(location) : undefined;
    const info = edge ? generated?.edgeCallInfo.get(edge.id) : undefined;
    const pageVar = generated ? instanceVarName(generated.className) : undefined;
    const blockerLines = plan.blockers.map((b) => `  //   - ${b}`).join("\n");
    const example =
      fixtureName && info && pageVar && edge
        ? `
  // Arrange the above manually, then remove .fixme and fill in the body, e.g.:
  // test(${title}, async ({ ${fixtureName} }) => {
  //   const ${pageVar} = ${fixtureName}.${pageVar};
  //   await ${pageVar}.goto();
  //   await ${pageVar}.${info.methodPath}(${info.argStyle === "login" ? "username, password" : callArgs(info, edge, ownFirst)});
  // });`
        : "";
    return `test.fixme(${title}, ${details}, async () => {
  // Not auto-generated — blocked by:
${blockerLines}${example}
});`;
  }

  // A test with setup or several steps is split into test.step() blocks — one per setup action and
  // per step — so the steps read as steps in the code, the HTML report and the trace, and a failure
  // names its step. Page objects and credentials are then declared once at the top. A single action
  // without setup stays a flat test.
  const stepped = plan.setup.length > 0 || plan.steps.length > 1;
  const header: string[] = [];
  const segments: { title: string; lines: string[]; returns: string[] }[] = [];
  const flat: string[] = [];
  let out = flat; // where the current statements go

  // Tracks which page the browser is on so goto() only happens on a real page change — a stray
  // goto() between "open the menu" and "click the menu item" would close it.
  const declared = new Set<string>();
  let currentPage: string | undefined;
  let credentialsLoaded = false;
  const declare = (pageId: string): string | undefined => {
    const v = fixture.pageGetters.get(pageId);
    if (v && !declared.has(v)) {
      (stepped ? header : out).push(`const ${v} = ${fixtureName}.${v};`);
      declared.add(v);
    }
    return v;
  };
  const arriveOn = (pageId: string, v: string) => {
    if (currentPage !== pageId) {
      out.push(`await ${v}.goto();`);
      currentPage = pageId;
    }
  };
  const afterAction = (edge: ActionEdge) => {
    if (edge.toPageId !== edge.fromPageId && !edge.external) currentPage = edge.toPageId;
  };
  const startSegment = (segmentTitle: string) => {
    const segment = { title: segmentTitle, lines: [] as string[], returns: [] as string[] };
    segments.push(segment);
    out = segment.lines;
    return segment;
  };

  // Given: the states the test is put in first, one step each. A persistent state calls its
  // reusable flow (flows.ts); a transient one (an open menu) runs inline on this test's page.
  for (const g of plan.given) {
    if (g.steps.length === 0) continue; // already true at the start / only picks the user
    const shownItem = g.item ?? (g.state.perItem ? g.steps.find((st) => st.edge.scope)?.edge.scope?.hasText : undefined);
    if (stepped) startSegment(`Given — ${g.state.title}${shownItem ? ` (${shownItem})` : ""}`);
    const flow = g.state.kind === "persistent" ? ctx.flows.get(g.state.id) : undefined;
    if (flow) {
      const itemArg = flow.defaultItem !== undefined && g.item !== undefined && g.item !== flow.defaultItem ? `, ${jsStringLiteral(g.item)}` : "";
      out.push(`await flows.${flow.name}(${fixtureName}${itemArg});`);
      currentPage = flow.endPage;
      continue;
    }
    for (const s of g.steps) {
      const v = declare(s.location);
      const info = ctx.generatedPages.get(s.location)?.edgeCallInfo.get(s.edge.id);
      if (!v || !info) return generatorError(title, details, `setup step "${s.edge.semanticIntent}" has no call info on page "${s.location}"`);
      arriveOn(s.location, v);
      out.push(`await ${v}.${info.methodPath}(${callArgs(info, s.edge, { ...(s.step ?? {}), ...(s.item ? { item: s.item } : {}) })});`);
      afterAction(s.edge);
    }
  }

  const commented = plan.steps.length > 1 && !stepped;
  const varKinds = new Map<string, boolean>(); // captured value name -> numeric
  for (const s of plan.steps) {
    const segment = stepped
      ? startSegment(
          s.origin.kind === "required"
            ? `From "${s.origin.caseTitle}": ${s.edge.semanticIntent}`
            : `${s.origin.index + 1}. ${s.edge.semanticIntent}${(s.step.item ?? s.edge.scope?.hasText) ? ` — ${s.step.item ?? s.edge.scope?.hasText}` : ""}`,
        )
      : undefined;
    const v = declare(s.location);
    const info = ctx.generatedPages.get(s.location)?.edgeCallInfo.get(s.edge.id);
    if (!v || !info) return generatorError(title, details, `"${s.edge.semanticIntent}" has no call info on page "${s.location}"`);
    const comment = !commented
      ? ""
      : s.origin.kind === "required"
        ? ` // from "${s.origin.caseTitle}": ${s.edge.semanticIntent}`
        : ` // step ${s.origin.index + 1}: ${s.edge.semanticIntent}`;

    let call: string;
    if (info.argStyle === "login") {
      if (!ctx.loginUser) return generatorError(title, details, "login step without an auth user");
      if (!credentialsLoaded) {
        (stepped ? header : out).push(`const { username, password } = loadCredentials(${jsStringLiteral(ctx.loginUser.id)}); // read at run time, never stored here`);
        credentialsLoaded = true;
      }
      arriveOn(s.location, v);
      call = `await ${v}.${info.methodPath}(username, password);${comment}`;
    } else {
      arriveOn(s.location, v);
      call = `await ${v}.${info.methodPath}(${callArgs(info, s.edge, s.step)});${comment}`;
    }
    // An external link may open a new tab: start waiting before the click so the popup isn't missed.
    if (s.edge.external?.opensNewTab) out.push(`const popupPromise = page.waitForEvent("popup");`, call, `const popup = await popupPromise;`);
    else out.push(call);
    out.push(...assertionsFor(s.edge, s.step, clickedExprFor(v, info, s.step), ctx));
    afterAction(s.edge);
    const valueLines = buildValueLines(s.step, ctx, declare, varKinds);
    if (typeof valueLines === "string") return generatorError(title, details, valueLines);
    out.push(...valueLines);
    // Values captured inside a step are returned from it, so later steps can compare against them.
    if (segment) segment.returns.push(...(s.step.capture ?? []).map((c) => valueVar(c.as)));
  }
  return stepped ? steppedTestBlock(title, details, fixtureName, header, segments) : testBlock(title, details, fixtureName, flat);
}

function steppedTestBlock(title: string, details: string, fixtureName: string, header: string[], segments: { title: string; lines: string[]; returns: string[] }[]): string {
  const all = [...header, ...segments.flatMap((s) => s.lines)];
  const needsPage = all.some((l) => /(^|[^\w.])page[.)]/.test(l) || l.includes("expect(page"));
  const body: string[] = [...(needsPage ? [`const { page } = ${fixtureName};`] : []), ...header];
  for (const s of segments) {
    const open = `await test.step(${jsStringLiteral(s.title)}, async () => {`;
    body.push(s.returns.length ? `const { ${s.returns.join(", ")} } = ${open}` : open);
    body.push(...s.lines.map((l) => `  ${l}`));
    if (s.returns.length) body.push(`  return { ${s.returns.join(", ")} };`);
    body.push("});");
  }
  return `test(${title}, ${details}, async ({ ${fixtureName} }) => {
${body.map((l) => `  ${l}`).join("\n")}
});`;
}

function buildPageSpec(page: PageNode, blocks: string[], runAs: string, sourceLabel: string, mapUpdatedAt: string): string {
  const usesLoadCredentials = blocks.some((b) => b.includes("loadCredentials("));
  const extra = [usesLoadCredentials && "loadCredentials", blocks.some((b) => b.includes("readAmount(")) && "readAmount", blocks.some((b) => b.includes("readText(")) && "readText"].filter(Boolean);
  const usesFlows = blocks.some((b) => b.includes("await flows."));
  return `// Generated from ${sourceLabel} (map updated ${mapUpdatedAt}) — do not hand-edit, regenerate instead.
// Page: ${page.title} (${page.urlPattern}) — runs as ${runAs}
import { test, expect${extra.map((e) => `, ${e}`).join("")} } from "./fixtures";${usesFlows ? `\nimport * as flows from "./flows";` : ""}

${blocks.join("\n\n")}
`;
}

export interface GeneratedFileChange {
  /** Relative to outputDir, POSIX separators. */
  file: string;
  before: string | null;
  after: string | null;
}

export interface GenerateNavmapTestsResult {
  /** Files whose content differs from the previous generation (added, removed or edited). */
  changes: GeneratedFileChange[];
  fileCount: number;
  testCount: number;
  fixmeCount: number;
  authDependentCount: number;
}

export interface GeneratedCode {
  /** outputDir-relative POSIX path → content. */
  files: Map<string, string>;
  plans: Map<string, CasePlan>;
  /** Test block of every non-rejected case — approved ones are also in the specs; drafts are
   *  previews only. */
  blocks: Map<string, string>;
  stats: Omit<GenerateNavmapTestsResult, "changes">;
}

/** Pure: builds every generated file in memory. Page objects, components, user wrappers and
 *  fixtures come from the whole map (every discovered action is a reusable method); specs come
 *  only from approved cases — one .spec.ts per page of each case's first own step. */
export function buildGeneratedCode(
  map: NavigationMap,
  users: ProjectUser[],
  graph: StateGraph,
  cases: TestCase[],
  sourceLabel: string,
  flags?: EdgeFlags,
  organization?: Pick<Organization, "features"> | null,
  suites?: Pick<SuitesFile, "suites"> | null,
  requirements?: Pick<RequirementsFile, "requirements"> | null,
): GeneratedCode {
  const files = new Map<string, string>();
  const edgesByFromPage = new Map<string, ActionEdge[]>();
  for (const edge of Object.values(map.edges)) {
    const bucket = edgesByFromPage.get(edge.fromPageId) ?? [];
    bucket.push(edge);
    edgesByFromPage.set(edge.fromPageId, bucket);
  }
  const live = cases.filter((c) => c.status !== "rejected");
  // A page with no recorded actions still needs a class when a case runs a shared component action on it.
  // ...or reads one of its elements.
  const stepPages = new Set(
    live.flatMap((c) =>
      c.steps.flatMap((s) => [s.on, ...[...(s.capture ?? []), ...(s.verify ?? [])].map((v) => v.element.split("#")[0])]).filter((p): p is string => !!p && !!map.pages[p]),
    ),
  );
  const pagesWithClasses = Object.values(map.pages).filter((p) => (edgesByFromPage.get(p.id) ?? []).length > 0 || stepPages.has(p.id));

  // Allocated centrally so two pages with the same title can't map to the same class/file name.
  const classNames = new NameAllocator();
  const pageClassNames = new Map<string, string>();
  for (const page of pagesWithClasses) pageClassNames.set(page.id, classNames.take(pageClassName(page)));

  const uiComponents = computeUiComponents(map);
  const edgeIdToComponent = componentMembership(map);
  const plans = planCases(map, users, graph, cases, flags);

  // A setup step or case step recorded on another page (e.g. opening the header menu) runs through
  // a component field, so the page it runs on must compose that component even if none of its own
  // edges touch it. Setup comes from every edge's plan (map-derived, so page objects don't depend
  // on which cases happen to be approved).
  const extraComponents = new Map<string, Map<string, UiComponent>>();
  const needComponent = (location: string, edge: ActionEdge) => {
    const component = edgeIdToComponent.get(edge.id);
    // Only on pages the map saw the component on — elsewhere the step is blocked, not generated.
    if (!component || location === edge.fromPageId || !component.pageIds.includes(location)) return;
    const forPage = extraComponents.get(location) ?? new Map<string, UiComponent>();
    forPage.set(component.id, component);
    extraComponents.set(location, forPage);
  };
  for (const plan of planEdges(map, users, graph).values()) for (const step of plan.setup) needComponent(step.location, step.edge);
  for (const plan of plans.values()) for (const step of plan.steps) needComponent(step.location, step.edge);

  const generatedComponents = new Map<string, GeneratedComponentClass>();
  for (const component of uiComponents.values()) {
    const generated = buildComponentClass(component);
    generatedComponents.set(component.id, generated);
    files.set(`components/${generated.fileName}`, generated.source);
  }

  const origin = resolveOrigin(map);
  const generatedPages = new Map<string, GeneratedPageClass>();
  for (const page of pagesWithClasses) {
    const generated = buildPageClass(
      page,
      pageClassNames.get(page.id)!,
      edgesByFromPage.get(page.id) ?? [],
      page.sampleUrls[0] ?? `${origin}${page.urlPattern}`,
      edgeIdToComponent,
      generatedComponents,
      (component) => `../components/${componentClassName(component.regionName)}`,
      [...(extraComponents.get(page.id)?.values() ?? [])],
    );
    generatedPages.set(page.id, generated);
    files.set(`pages/${generated.fileName}`, generated.source);
  }

  const fixtures = planUserFixtures(users, map, pageClassNames);
  for (const fixture of fixtures) files.set(`users/${fixture.wrapperClassName}.ts`, buildUserPagesClass(fixture, pageClassNames));
  files.set("fixtures.ts", buildFixturesFile(fixtures, map));
  const flowsFile = buildFlowsFile(graph, map, generatedPages);
  if (flowsFile.source) files.set("flows.ts", flowsFile.source);

  const ctx: SpecContext = {
    map,
    origin,
    generatedPages,
    fixtures,
    loginUser: users.find((u) => u.kind === "auth" && !!u.credentialsRef),
    organization: caseFeatureIndex(organization),
    suites: caseSuiteIndex(suites),
    requirements: caseRequirementIndex(requirements),
    flows: flowsFile.flows,
  };
  const planCtx = planContext(map, users, graph, cases, flags);
  const rowPlans = new Map(live.map((c) => [c.id, planCaseRows(c, planCtx)]));
  const blocks = new Map<string, string>();
  for (const c of live) blocks.set(c.id, rowPlans.get(c.id)!.map((p) => buildCaseBlock(p, ctx)).join("\n\n"));

  // Tests keep the map's action order (so baseline cases come out exactly as one-test-per-action
  // did), then cases not anchored to an earlier action, oldest first.
  const edgeOrder = new Map(Object.keys(map.edges).map((id, i) => [id, i]));
  const approved = live
    .filter((c) => c.status === "approved")
    .sort(
      (a, b) =>
        (edgeOrder.get(a.steps[0].edgeId) ?? Infinity) - (edgeOrder.get(b.steps[0].edgeId) ?? Infinity) ||
        Number(a.origin !== "baseline") - Number(b.origin !== "baseline") ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );

  const stats = { fileCount: 0, testCount: 0, fixmeCount: 0, authDependentCount: 0 };
  for (const page of Object.values(map.pages)) {
    const onPage = approved.filter((c) => plans.get(c.id)!.firstPageId === page.id);
    if (onPage.length === 0) continue;
    const pageUser = chooseUserForPage(page, users);
    const pageFixture = pageUser ? fixtures.find((f) => f.user.id === pageUser.id) : undefined;
    const runAs = pageFixture ? `${pageFixture.user.label} (${pageFixture.fixtureName})` : "no configured user";
    files.set(`${page.id}.spec.ts`, buildPageSpec(page, onPage.map((c) => blocks.get(c.id)!), runAs, sourceLabel, map.updatedAt));
    stats.fileCount++;
    for (const plan of onPage.flatMap((c) => rowPlans.get(c.id)!)) {
      if (plan.runnable) {
        stats.testCount++;
        if (plan.authDependent) stats.authDependentCount++;
      } else {
        stats.fixmeCount++;
      }
    }
  }

  return { files, plans, blocks, stats };
}

/** Removes everything a previous generation wrote (specs, page objects, components, user
 *  wrappers, fixtures) so renamed pages or deleted users can't leave stale files behind. Selective
 *  rather than wiping the folder, since outputDir can be any path a CLI caller passes. Saved
 *  sessions live outside it (projects/<id>/.auth/), so nothing expensive is ever lost here. */
async function cleanGeneratedCode(outputDir: string): Promise<void> {
  for (const dir of ["pages", "components", "users"]) {
    await rm(path.join(outputDir, dir), { recursive: true, force: true });
  }
  const entries = await readdir(outputDir).catch(() => [] as string[]);
  for (const name of entries) {
    if (name.endsWith(".spec.ts") || name === "fixtures.ts" || name === "flows.ts") await rm(path.join(outputDir, name), { force: true });
  }
}

/** Contents of every file a generation owns (same set cleanGeneratedCode removes), keyed by
 *  outputDir-relative POSIX path — compared before/after to report what a regeneration changed. */
async function snapshotGeneratedCode(outputDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const read = async (rel: string) => files.set(rel, await readFile(path.join(outputDir, rel), "utf-8"));
  for (const name of await readdir(outputDir).catch(() => [] as string[])) {
    if (name.endsWith(".spec.ts") || name === "fixtures.ts" || name === "flows.ts") await read(name);
  }
  for (const dir of ["pages", "components", "users"]) {
    for (const name of await readdir(path.join(outputDir, dir)).catch(() => [] as string[])) await read(`${dir}/${name}`);
  }
  return files;
}

/** Writes buildGeneratedCode's files into outputDir (page objects in pages/, components in
 *  components/, one wrapper per user in users/, fixtures.ts, and the approved cases' specs) and
 *  reports what changed against the previous generation. */
export async function generateNavmapTestFiles(
  map: NavigationMap,
  users: ProjectUser[],
  graph: StateGraph,
  cases: TestCase[],
  outputDir: string,
  sourceLabel: string,
  flags?: EdgeFlags,
  organization?: Pick<Organization, "features"> | null,
  suites?: Pick<SuitesFile, "suites"> | null,
  requirements?: Pick<RequirementsFile, "requirements"> | null,
): Promise<GenerateNavmapTestsResult> {
  const code = buildGeneratedCode(map, users, graph, cases, sourceLabel, flags, organization, suites, requirements);

  await mkdir(outputDir, { recursive: true });
  const before = await snapshotGeneratedCode(outputDir);
  await cleanGeneratedCode(outputDir);
  for (const dir of ["pages", "components", "users"]) await mkdir(path.join(outputDir, dir), { recursive: true });
  for (const [rel, content] of code.files) await writeFile(path.join(outputDir, rel), content, "utf-8");

  const after = await snapshotGeneratedCode(outputDir);
  const changes: GeneratedFileChange[] = [];
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(file) ?? null;
    const a = after.get(file) ?? null;
    if (b !== a) changes.push({ file, before: b, after: a });
  }
  changes.sort((x, y) => x.file.localeCompare(y.file));

  return { changes, ...code.stats };
}
