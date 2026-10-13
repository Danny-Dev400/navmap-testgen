import path from "node:path";
import type { Plugin } from "vite";
import { z } from "zod/v4";
import type { NavigationMap } from "../../src/navmap-types";
import { buildGeneratedCode, planCases } from "../../src/navmap-test-generator";
import { loadProjectUsers, storageStatePathFor } from "../../src/navmap-users";
import { loadStateGraph } from "../../src/navmap-states";
import { isDestructive, loadEdgeFlags } from "../../src/navmap-edge-flags";
import { computeUiComponents } from "../../src/navmapUiComponents";
import { computeJourneys, journeyCoverage } from "../../src/navmap-journeys";
import {
  ActionStepSchema,
  baselineCase,
  DatasetSchema,
  GivenSchema,
  CASE_ID_RE,
  CaseStatusSchema,
  deleteCase,
  loadCases,
  newCaseId,
  saveCase,
  uncoveredEdgeIds,
  type TestCase,
} from "../../src/navmap-cases";
import { projectPaths } from "../../src/project-paths";
import { loadSuites, sanitizeSuites, saveSuites } from "../../src/navmap-suites";
import { loadRequirements, saveRequirements } from "../../src/navmap-requirements";
import { assignCases, diffOrganization, findUseCase, loadOrganization, loadProposal, organizationView, sanitizeOrganization, saveOrganization } from "../../src/navmap-features";
import { loadMap, pathExists, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";
import { pomMethodsForTest } from "./generatedCode";
import { regenerateProject } from "./regenerate";

// /api/projects/<id>/cases[/baseline | /status | /<caseId>[/preview]] — everything else falls through.
const CASES_RE = /^\/([a-z0-9-]{1,80})\/cases(?:\/([a-z0-9_-]{1,120}))?(?:\/(preview))?\/?$/;

const CreateBody = z.object({
  title: z.string().trim().min(1).max(300),
  steps: z.array(ActionStepSchema).min(1),
  requires: z.array(z.string().regex(CASE_ID_RE)).default([]),
  dataset: DatasetSchema.optional(),
  given: z.array(GivenSchema).max(10).optional(),
  notes: z.string().max(4000).optional(),
  /** The use case the new case proves (picked in the editor). */
  useCaseId: z.string().optional(),
});
const UpdateBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  status: CaseStatusSchema.optional(),
  steps: z.array(ActionStepSchema).min(1).optional(),
  requires: z.array(z.string().regex(CASE_ID_RE)).optional(),
  /** null removes the data table. */
  dataset: DatasetSchema.nullable().optional(),
  /** null removes the case's own given states. */
  given: z.array(GivenSchema).max(10).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});
const BaselineBody = z.object({ pageId: z.string().optional(), approve: z.boolean().default(false), useCaseId: z.string().optional(), edgeIds: z.array(z.string()).max(300).optional() });
const StatusBody = z.object({ ids: z.array(z.string().regex(CASE_ID_RE)).min(1).max(500), status: CaseStatusSchema });
const DeleteManyBody = z.object({ ids: z.array(z.string().regex(CASE_ID_RE)).min(1).max(500) });

/** What the UI needs to show and compose an action as a case step — never its locators. */
function actionView(map: NavigationMap, edgeId: string, flags: Awaited<ReturnType<typeof loadEdgeFlags>>, componentEdgeIds: Set<string>) {
  const e = map.edges[edgeId];
  return {
    id: e.id,
    fromPageId: e.fromPageId,
    toPageId: e.toPageId,
    semanticIntent: e.semanticIntent,
    intentCategory: e.intentCategory,
    action: e.action,
    target: e.target,
    inputValue: e.inputValue,
    item: e.scope?.hasText,
    formFields: e.formFields?.map((f) => ({ label: f.label, value: f.value })),
    // checkValue: the literal observed while exploring (page text, never a secret) — what a case can override.
    postconditions: e.postconditions.map((p) => ({ description: p.description, assertionType: p.assertionType, checkKind: p.check?.kind, checkValue: p.check?.value })),
    preconditions: e.preconditions,
    external: e.external,
    isLogin: !!e.authFormLocators,
    inComponent: componentEdgeIds.has(e.id),
    destructive: isDestructive(e, flags),
    destructiveSource: edgeId in flags.destructive ? ("user" as const) : e.destructive ? ("agent" as const) : null,
    screenshot: e.screenshot ? `/${e.screenshot}` : undefined,
  };
}

/** Actions a step can use on each page: the page's own, plus shared component actions available
 *  there (run with `on` when they were recorded elsewhere) — the "+ Add step" list. */
function availableByPage(map: NavigationMap) {
  const out: Record<string, { edgeId: string; on?: string }[]> = {};
  for (const page of Object.values(map.pages)) out[page.id] = [];
  for (const edge of Object.values(map.edges)) out[edge.fromPageId]?.push({ edgeId: edge.id });
  for (const component of computeUiComponents(map).values()) {
    for (const element of component.elements) {
      for (const pageId of component.pageIds) {
        if (element.memberEdges.some((e) => e.fromPageId === pageId)) continue; // already its own action there
        const representative = element.memberEdges[0];
        if (representative) out[pageId]?.push({ edgeId: representative.id, on: pageId });
      }
    }
  }
  return out;
}

/** Everything the Test cases tab shows — returned by GET and after every mutation (cases and
 *  organization alike), so one response refreshes the whole tab. */
export async function casesResponse(repoRoot: string, map: NavigationMap) {
    const [users, graph, flags, cases, org, proposal, suitesFile, requirementsFile] = await Promise.all([
      loadProjectUsers(repoRoot, map),
      loadStateGraph(repoRoot, map.id, map),
      loadEdgeFlags(repoRoot, map.id),
      loadCases(repoRoot, map.id),
      loadOrganization(repoRoot, map.id),
      loadProposal(repoRoot, map.id),
      loadSuites(repoRoot, map.id),
      loadRequirements(repoRoot, map.id),
    ]);
    const plans = planCases(map, users, graph, cases, flags);
    const componentEdgeIds = new Set([...computeUiComponents(map).values()].flatMap((c) => c.elements.flatMap((el) => el.memberEdges.map((e) => e.id))));
    const pageTitle = (id: string) => map.pages[id]?.title ?? id;

    // Same order as the generated specs: the map's action order, then newer cases.
    const edgeOrder = new Map(Object.keys(map.edges).map((id, i) => [id, i]));
    const ordered = [...cases].sort(
      (a, b) =>
        (edgeOrder.get(a.steps[0].edgeId) ?? Infinity) - (edgeOrder.get(b.steps[0].edgeId) ?? Infinity) ||
        Number(a.origin !== "baseline") - Number(b.origin !== "baseline") ||
        a.createdAt.localeCompare(b.createdAt),
    );
    const caseViews = ordered.map((c) => {
      const plan = plans.get(c.id)!;
      return {
        ...c,
        health: plan.health.health,
        reasons: plan.health.reasons,
        runnable: plan.runnable,
        blockers: plan.blockers,
        runAs: plan.user?.label ?? null,
        destructive: plan.destructive,
        firstPageId: plan.firstPageId ?? null,
        setup: plan.setup.map((s) => ({
          edgeId: s.edge.id,
          semanticIntent: s.edge.semanticIntent,
          action: s.edge.action,
          target: s.edge.target,
          pageTitle: pageTitle(s.location),
          scope: s.scope,
          item: s.item ?? s.edge.scope?.hasText ?? null,
        })),
        // The states the test is put in first, why, and the flow steps that produce them.
        givenChain: plan.given.map((g) => ({
          stateId: g.state.id,
          title: g.state.title,
          kind: g.state.kind,
          item: g.item ?? null,
          via:
            g.via.kind === "precondition"
              ? { kind: "precondition" as const, edgeId: g.via.edgeId, precondition: g.via.precondition, sameItem: g.via.sameItem, action: map.edges[g.via.edgeId]?.semanticIntent ?? g.via.edgeId }
              : g.via.kind === "requires"
                ? { kind: "requires" as const, from: graph.states.find((x) => x.id === (g.via as { from: string }).from)?.title ?? g.via.from }
                : { kind: "given" as const },
          // "Same item" is offered when both the consumer action and a flow step pick a list item.
          canShareItem: g.via.kind === "precondition" && !!map.edges[g.via.edgeId]?.scope && g.steps.some((st) => !!st.edge.scope),
          steps: g.steps.map((st) => ({
            edgeId: st.edge.id,
            semanticIntent: st.edge.semanticIntent,
            action: st.edge.action,
            pageTitle: pageTitle(st.location),
            item: st.item ?? st.edge.scope?.hasText ?? null,
          })),
        })),
        requiredSteps: plan.steps.filter((s) => s.origin.kind === "required").length,
      };
    });

    // Users whose approved, runnable cases need a saved session that doesn't exist yet.
    const authRunners = new Map<string, string>();
    for (const c of cases) {
      const plan = plans.get(c.id)!;
      if (c.status === "approved" && plan.authDependent && plan.user) authRunners.set(plan.user.id, plan.user.label);
    }
    const usersNeedingSession: { id: string; label: string }[] = [];
    for (const [id, label] of authRunners) {
      if (!(await pathExists(path.join(repoRoot, storageStatePathFor(map, id))))) usersNeedingSession.push({ id, label });
    }

    const uncovered = uncoveredEdgeIds(map, cases);
    // End-to-end journeys of the map and which approved cases walk them (no AI).
    const coverage = journeyCoverage(
      map,
      computeJourneys(map),
      cases.filter((c) => c.status === "approved").map((c) => ({ caseId: c.id, plan: plans.get(c.id)! })),
    );
    return {
      cases: caseViews,
      uncovered,
      journeys: coverage.journeys,
      edgeCoverage: coverage.edgeCoverage,
      pages: Object.values(map.pages).map((p) => ({ id: p.id, title: p.title, urlPattern: p.urlPattern })),
      actions: Object.fromEntries(Object.keys(map.edges).map((id) => [id, actionView(map, id, flags, componentEdgeIds)])),
      available: availableByPage(map),
      elements: Object.fromEntries(
        Object.values(map.pages).flatMap((p) =>
          (p.elements ?? []).map((el) => [`${p.id}#${el.id}`, { ref: `${p.id}#${el.id}`, label: el.label, valueKind: el.valueKind, perItem: el.scope?.hasText ?? null }]),
        ),
      ),
      states: graph.states.map((st) => ({ id: st.id, title: st.title, kind: st.kind, perItem: !!st.perItem })),
      auth: { hasAuthUsers: users.some((u) => u.kind === "auth"), usersNeedingSession },
      organization: organizationView(org, map, cases, plans),
      // caseId -> the acceptance criteria it proves ("SHOP-12 › The total adds up").
      requirementsByCase: Object.fromEntries(
        cases.map((c) => [
          c.id,
          requirementsFile.requirements.flatMap((r) =>
            r.criteria.filter((cr) => cr.caseIds.includes(c.id)).map((cr) => ({ requirementId: r.id, key: r.key ?? null, title: r.title, criterionId: cr.id, criterion: cr.text })),
          ),
        ]).filter(([, list]) => (list as unknown[]).length > 0),
      ),
      // Requirements as design scopes ("design cases for SHOP-12's uncovered criteria").
      requirementList: requirementsFile.requirements.map((r) => ({
        id: r.id,
        label: [r.key, r.title].filter(Boolean).join(" "),
        uncovered: r.criteria.filter((cr) => !cr.caseIds.some((id) => cases.some((c) => c.id === id && c.status !== "rejected"))).length,
      })),
      // Saved selections (suites.json), ids of deleted cases dropped.
      suites: {
        updatedAt: suitesFile.updatedAt || null,
        list: sanitizeSuites(suitesFile, cases.map((c) => c.id)).suites.map((st) => ({
          id: st.id,
          name: st.name,
          description: st.description ?? null,
          caseIds: st.caseIds,
          approved: st.caseIds.filter((id) => cases.find((c) => c.id === id)?.status === "approved").length,
        })),
      },
      proposal: proposal
        ? {
            createdAt: proposal.createdAt,
            rationale: proposal.rationale ?? null,
            request: proposal.request ?? null,
            features: proposal.organization.features,
            diff: diffOrganization(org ? sanitizeOrganization(org, map, cases).org : null, sanitizeOrganization(proposal.organization, map, cases).org),
          }
        : null,
    };
}

export function navmapCasesApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {

  /** Every referenced action must exist and a step may only run elsewhere when it's a shared
   *  component action — checked here so a bad request can't write a case the generator rejects. */
  function validateSteps(map: NavigationMap, steps: z.infer<typeof ActionStepSchema>[], requires: string[], cases: TestCase[], selfId?: string): string | null {
    for (const s of steps) {
      if (!map.edges[s.edgeId]) return `Unknown action "${s.edgeId}"`;
      if (s.on && !map.pages[s.on]) return `Unknown page "${s.on}"`;
    }
    const ids = new Set(cases.map((c) => c.id));
    for (const r of requires) {
      if (!ids.has(r)) return `Unknown required case "${r}"`;
      if (r === selfId) return "A case can't require itself";
    }
    return null;
  }

  /** A case may only ask for states that exist. */
  async function unknownGiven(map: NavigationMap, given: { state: string }[] | undefined): Promise<string | null> {
    if (!given?.length) return null;
    const ids = new Set((await loadStateGraph(repoRoot, map.id, map)).states.map((s) => s.id));
    const missing = given.find((g) => !ids.has(g.state));
    return missing ? `Unknown state "${missing.state}"` : null;
  }

  /** A deleted case leaves its use case and its suites on disk too — so a later case that gets the
   *  same id (same title) doesn't silently land there. */
  async function forgetCases(projectId: string, ids: Set<string>) {
    const org = await loadOrganization(repoRoot, projectId);
    if (org && org.features.some((f) => f.useCases.some((u) => u.cases.some((id) => ids.has(id))))) {
      await saveOrganization(repoRoot, projectId, {
        ...org,
        features: org.features.map((f) => ({ ...f, useCases: f.useCases.map((u) => ({ ...u, cases: u.cases.filter((id) => !ids.has(id)) })) })),
      });
    }
    const suites = await loadSuites(repoRoot, projectId);
    if (suites.suites.some((st) => st.caseIds.some((id) => ids.has(id)))) {
      await saveSuites(repoRoot, projectId, suites.suites.map((st) => ({ ...st, caseIds: st.caseIds.filter((id) => !ids.has(id)) })));
    }
    const reqs = await loadRequirements(repoRoot, projectId);
    if (reqs.requirements.some((r) => r.criteria.some((c) => c.caseIds.some((id) => ids.has(id))))) {
      await saveRequirements(
        repoRoot,
        projectId,
        reqs.requirements.map((r) => ({ ...r, criteria: r.criteria.map((c) => ({ ...c, caseIds: c.caseIds.filter((id) => !ids.has(id)) })) })),
      );
    }
  }

  async function respondAfterChange(res: Parameters<typeof sendJson>[0], map: NavigationMap, status = 200, extra: Record<string, unknown> = {}) {
    const regenerated = await regenerateProject(repoRoot, map.id);
    return sendJson(res, status, { ...(await casesResponse(repoRoot, map)), regeneration: regenerated?.regeneration ?? null, ...extra });
  }

  return {
    name: "navmap-cases-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const match = CASES_RE.exec((req.url ?? "/").split("?")[0]);
        if (!match) return next();
        const [, projectId, sub, action] = match;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });

        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });

          if (!sub && req.method === "GET") return sendJson(res, 200, await casesResponse(repoRoot, map));

          if (!sub && req.method === "POST") {
            const parsed = CreateBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid test case", details: z.prettifyError(parsed.error) });
            const cases = await loadCases(repoRoot, projectId);
            const invalid = validateSteps(map, parsed.data.steps, parsed.data.requires, cases) ?? (await unknownGiven(map, parsed.data.given));
            if (invalid) return sendJson(res, 400, { error: invalid });
            const now = new Date().toISOString();
            const created: TestCase = {
              id: newCaseId(parsed.data.title, cases.map((c) => c.id)),
              title: parsed.data.title,
              status: "draft",
              origin: "manual",
              requires: parsed.data.requires,
              ...(parsed.data.given?.length ? { given: parsed.data.given } : {}),
              steps: parsed.data.steps,
              ...(parsed.data.dataset ? { dataset: parsed.data.dataset } : {}),
              ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
              createdAt: now,
              updatedAt: now,
            };
            const org = parsed.data.useCaseId ? await loadOrganization(repoRoot, projectId) : null;
            if (parsed.data.useCaseId && !(org && findUseCase(org, parsed.data.useCaseId))) return sendJson(res, 400, { error: "Unknown use case" });
            await saveCase(repoRoot, projectId, created);
            if (org && parsed.data.useCaseId) await saveOrganization(repoRoot, projectId, assignCases(org, [created.id], parsed.data.useCaseId));
            return respondAfterChange(res, map, 201, { createdId: created.id });
          }

          if (sub === "baseline" && !action && req.method === "POST") {
            const parsed = BaselineBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid request" });
            const cases = await loadCases(repoRoot, projectId);
            const org = parsed.data.useCaseId ? await loadOrganization(repoRoot, projectId) : null;
            const target = org && parsed.data.useCaseId ? findUseCase(org, parsed.data.useCaseId) : undefined;
            if (parsed.data.useCaseId && !target) return sendJson(res, 404, { error: "Unknown use case" });
            const only = parsed.data.edgeIds ?? target?.useCase.actions;
            const edgeIds = uncoveredEdgeIds(map, cases).filter((id) => (!parsed.data.pageId || map.edges[id].fromPageId === parsed.data.pageId) && (!only || only.includes(id)));
            const now = new Date().toISOString();
            // Ids are deterministic: a rejected baseline still exists, so it's never recreated here.
            const existing = new Set(cases.map((c) => c.id));
            const createdIds: string[] = [];
            for (const id of edgeIds) {
              const c = baselineCase(map.edges[id], parsed.data.approve ? "approved" : "draft", now);
              if (existing.has(c.id)) continue;
              await saveCase(repoRoot, projectId, c);
              createdIds.push(c.id);
            }
            const created = createdIds.length;
            // Created from a use case: they belong to it (an explicit choice, made by clicking there).
            if (org && target && created) await saveOrganization(repoRoot, projectId, assignCases(org, createdIds, target.useCase.id));
            return respondAfterChange(res, map, 200, { created });
          }

          if (sub === "status" && !action && req.method === "POST") {
            const parsed = StatusBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid request" });
            const wanted = new Set(parsed.data.ids);
            const now = new Date().toISOString();
            for (const c of await loadCases(repoRoot, projectId)) {
              if (wanted.has(c.id) && c.status !== parsed.data.status) await saveCase(repoRoot, projectId, { ...c, status: parsed.data.status, updatedAt: now });
            }
            return respondAfterChange(res, map);
          }

          if (sub === "delete" && !action && req.method === "POST") {
            // Several at once (the list's selection). Features and suites drop the ids when read.
            const parsed = DeleteManyBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid request" });
            const all = await loadCases(repoRoot, projectId);
            const wanted = new Set(parsed.data.ids);
            const dependents = all.filter((c) => !wanted.has(c.id) && c.requires.some((r) => wanted.has(r)));
            if (dependents.length > 0) {
              return sendJson(res, 409, { error: `Required by ${dependents.map((c) => `"${c.title}"`).join(", ")} — remove it from those first, or select them too` });
            }
            for (const c of all) if (wanted.has(c.id)) await deleteCase(repoRoot, projectId, c.id);
            await forgetCases(projectId, wanted);
            return respondAfterChange(res, map);
          }

          if (!sub || !CASE_ID_RE.test(sub)) return sendJson(res, 404, { error: "Not found" });
          const cases = await loadCases(repoRoot, projectId);
          const existing = cases.find((c) => c.id === sub);
          if (!existing) return sendJson(res, 404, { error: "Test case not found" });

          if (action === "preview" && req.method === "GET") {
            // The draft's test exactly as it would be generated once approved — built in memory, never written.
            const [users, links, flags] = await Promise.all([loadProjectUsers(repoRoot, map), loadStateGraph(repoRoot, map.id, map), loadEdgeFlags(repoRoot, map.id)]);
            const asApproved = cases.map((c) => (c.id === existing.id ? { ...c, status: "approved" as const } : c));
            const code = buildGeneratedCode(map, users, links, asApproved, projectPaths(projectId).navmap, flags, await loadOrganization(repoRoot, projectId));
            const block = code.blocks.get(existing.id);
            if (!block) return sendJson(res, 404, { error: "No preview for this case" });
            return sendJson(res, 200, { spec: { file: null, line: null, code: block }, methods: await pomMethodsForTest(repoRoot, projectId, block), preview: true });
          }

          if (!action && req.method === "PUT") {
            const parsed = UpdateBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid update", details: z.prettifyError(parsed.error) });
            const u = parsed.data;
            const steps = u.steps ?? existing.steps;
            const requires = u.requires ?? existing.requires;
            const invalid = validateSteps(map, steps, requires, cases, existing.id) ?? (await unknownGiven(map, u.given ?? undefined));
            if (invalid) return sendJson(res, 400, { error: invalid });
            const updated: TestCase = {
              ...existing,
              ...(u.title !== undefined ? { title: u.title } : {}),
              ...(u.status !== undefined ? { status: u.status } : {}),
              steps,
              requires,
              updatedAt: new Date().toISOString(),
            };
            if (u.given === null) delete updated.given;
            else if (u.given !== undefined) updated.given = u.given;
            if (u.dataset === null) delete updated.dataset;
            else if (u.dataset !== undefined) updated.dataset = u.dataset;
            if (u.notes === null) delete updated.notes;
            else if (u.notes !== undefined) updated.notes = u.notes;
            await saveCase(repoRoot, projectId, updated);
            return respondAfterChange(res, map);
          }

          if (!action && req.method === "DELETE") {
            const dependents = cases.filter((c) => c.requires.includes(existing.id));
            if (dependents.length > 0) {
              return sendJson(res, 409, { error: `Required by ${dependents.map((c) => `"${c.title}"`).join(", ")} — remove it from those first` });
            }
            await deleteCase(repoRoot, projectId, existing.id);
            await forgetCases(projectId, new Set([existing.id]));
            return respondAfterChange(res, map);
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-cases-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Cases request failed" });
        }
      });
    },
  };
}
