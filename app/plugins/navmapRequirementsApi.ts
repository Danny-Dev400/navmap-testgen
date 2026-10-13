import type { Plugin } from "vite";
import { z } from "zod/v4";
import type { NavigationMap } from "../../src/navmap-types";
import { CASE_ID_RE, loadCases } from "../../src/navmap-cases";
import { findUseCase, loadOrganization, ORG_ID_RE } from "../../src/navmap-features";
import {
  CRITERION_ID_RE,
  criterionStatus,
  loadAnalyses,
  loadRequirements,
  nextCriterionId,
  parseRequirementsCsv,
  parseRequirementsMarkdown,
  sanitizeRequirements,
  saveAnalyses,
  saveRequirements,
  toRequirements,
  worstStatus,
  type CaseFacts,
  type Requirement,
} from "../../src/navmap-requirements";
import { loadProjectSettings } from "../../src/navmap-settings";
import { projectPaths } from "../../src/project-paths";
import { loadMap, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";
import { cancelAgentJob, getJob, publicJob, runningJobForProject, shellCommands, startAgentJob } from "./agentJobs";
import { casesResponse } from "./navmapCasesApi";
import { latestStatus, listSummaries } from "./navmapRunsApi";
import { regenerateProject } from "./regenerate";

// /api/projects/<id>/requirements[/import | /matrix | /job[/cancel] | /<reqId>[/analyze | /proposal/(accept|discard)]]
// Requirements → acceptance criteria → the cases proving them (src/navmap-requirements.ts), and the
// analyst agent that proposes criteria + links for one requirement (text only, like the organizer).
const REQ_RE = /^\/([a-z0-9-]{1,80})\/requirements(?:\/([a-z0-9][a-z0-9-]{0,59}))?(?:\/(analyze|proposal))?(?:\/(accept|discard|cancel))?\/?$/;
const RESERVED = new Set(["import", "matrix", "job"]);

const CreateBody = z.object({ text: z.string().min(1).max(100_000), title: z.string().trim().max(200).optional() });
const ImportBody = z.object({ text: z.string().min(1).max(1_000_000), format: z.enum(["markdown", "csv"]), dryRun: z.boolean().default(false) });
const UpdateBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  key: z.string().trim().max(40).nullable().optional(),
  text: z.string().max(20000).optional(),
  useCaseId: z.string().regex(ORG_ID_RE).nullable().optional(),
  /** Replaces the criteria; those without an id are new. */
  criteria: z
    .array(z.object({ id: z.string().regex(CRITERION_ID_RE).optional(), text: z.string().trim().min(1).max(1000), caseIds: z.array(z.string().regex(CASE_ID_RE)).max(100).default([]) }))
    .max(50)
    .optional(),
  baseUpdatedAt: z.string().nullable().optional(),
});
const AnalyzeBody = z.object({ request: z.string().max(1000).optional() });

/** The analyst reads one compact context and saves a proposal — text only: no browser, no MCP,
 *  writes confined to the project's staging folder. */
const ANALYZE_COMMANDS = ["npm run navmap:requirements-context:*", "npm run navmap:save-requirement-analysis:*", "npm run navmap:ask:*", "npm run navmap:run-id:*"];

export function navmapRequirementsApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  /** Everything the Requirements tab shows: each criterion's status from its linked cases. */
  async function requirementsResponse(map: NavigationMap) {
    const [file, analyses, cases, org, summaries] = await Promise.all([
      loadRequirements(repoRoot, map.id),
      loadAnalyses(repoRoot, map.id),
      casesResponse(repoRoot, map),
      loadOrganization(repoRoot, map.id),
      listSummaries(repoRoot, map.id),
    ]);
    const latest = latestStatus(summaries, await loadCases(repoRoot, map.id)).cases;
    const byId = new Map(cases.cases.map((c) => [c.id, c]));
    const facts = (id: string): CaseFacts | undefined => {
      const c = byId.get(id);
      return c && { status: c.status, runnable: c.runnable, last: latest[id]?.status };
    };
    const clean = sanitizeRequirements(file, byId.keys());
    const requirements = clean.requirements.map((r) => {
      const criteria = r.criteria.map((c) => ({
        ...c,
        status: criterionStatus(c.caseIds, facts),
        cases: c.caseIds.map((id) => {
          const cv = byId.get(id)!;
          return { id, title: cv.title, status: cv.status, runnable: cv.runnable, last: latest[id] ?? null };
        }),
      }));
      return { ...r, status: worstStatus(criteria.map((c) => c.status)), criteria, analysis: analyses.find((a) => a.requirementId === r.id) ?? null };
    });
    const all = requirements.flatMap((r) => r.criteria);
    const job = getJob("analyze", map.id);
    return {
      updatedAt: file.updatedAt || null,
      requirements,
      summary: {
        requirements: requirements.length,
        criteria: all.length,
        covered: all.filter((c) => c.status !== "uncovered").length,
        failing: all.filter((c) => c.status === "failing").length,
        passing: all.filter((c) => c.status === "passing").length,
      },
      useCases: (org?.features ?? []).flatMap((f) => f.useCases.map((u) => ({ id: u.id, title: u.title, feature: f.title }))),
      cases: cases.cases.filter((c) => c.status !== "rejected").map((c) => ({ id: c.id, title: c.title, status: c.status })),
      job: publicJob(job),
    };
  }

  async function respondAfterChange(res: Parameters<typeof sendJson>[0], map: NavigationMap, extra: Record<string, unknown> = {}) {
    await regenerateProject(repoRoot, map.id); // @req tags follow the links
    return sendJson(res, 200, { ...(await requirementsResponse(map)), ...extra });
  }

  /** Links to unknown cases / a use case that doesn't exist make an edit invalid. */
  async function invalidRefs(projectId: string, criteria: { caseIds: string[] }[] | undefined, useCaseId: string | null | undefined): Promise<string | null> {
    const caseIds = new Set((await loadCases(repoRoot, projectId)).map((c) => c.id));
    const bad = (criteria ?? []).flatMap((c) => c.caseIds).find((id) => !caseIds.has(id));
    if (bad) return `Unknown test case "${bad}"`;
    if (useCaseId) {
      const org = await loadOrganization(repoRoot, projectId);
      if (!org || !findUseCase(org, useCaseId)) return `Unknown use case "${useCaseId}"`;
    }
    return null;
  }

  function matrix(view: Awaited<ReturnType<typeof requirementsResponse>>, format: "markdown" | "csv"): string {
    const rows: string[][] = [];
    for (const r of view.requirements) {
      for (const c of r.criteria) {
        const label = [r.key, r.title].filter(Boolean).join(" ");
        if (c.cases.length === 0) rows.push([label, `${c.id}: ${c.text}`, c.status, "", "", "", ""]);
        for (const tc of c.cases) {
          rows.push([label, `${c.id}: ${c.text}`, c.status, tc.title, tc.status, tc.last?.status ?? (tc.status === "approved" ? "never run" : ""), tc.last?.at.slice(0, 16).replace("T", " ") ?? ""]);
        }
      }
    }
    const header = ["Requirement", "Criterion", "Criterion status", "Test case", "Case status", "Last result", "Last run"];
    if (format === "csv") {
      const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
      return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
    }
    const md = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
    const s = view.summary;
    return [
      `# Traceability matrix`,
      "",
      `${s.requirements} requirement${s.requirements === 1 ? "" : "s"} · ${s.covered}/${s.criteria} criteria covered · ${s.passing} passing · ${s.failing} failing · exported ${new Date().toISOString().slice(0, 10)}`,
      "",
      `| ${header.join(" | ")} |`,
      `|${header.map(() => "---").join("|")}|`,
      ...rows.map((r) => `| ${r.map(md).join(" | ")} |`),
      "",
    ].join("\n");
  }

  return {
    name: "navmap-requirements-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const [pathname, query = ""] = (req.url ?? "/").split("?");
        const match = REQ_RE.exec(pathname);
        if (!match) return next();
        const [, projectId, sub, part, action] = match;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });

        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });
          const job = getJob("analyze", projectId);

          if (!sub && req.method === "GET") return sendJson(res, 200, await requirementsResponse(map));

          if (!sub && req.method === "POST") {
            const parsed = CreateBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Paste the requirement's text" });
            const found = parseRequirementsMarkdown(parsed.data.text);
            if (found.length === 0) return sendJson(res, 400, { error: "No requirement found in the text" });
            if (found.length === 1 && parsed.data.title) found[0] = { ...found[0], title: parsed.data.title };
            const file = await loadRequirements(repoRoot, projectId);
            const created = toRequirements(found, file.requirements, "pasted");
            await saveRequirements(repoRoot, projectId, [...file.requirements, ...created]);
            return sendJson(res, 200, { ...(await requirementsResponse(map)), createdIds: created.map((r) => r.id) });
          }

          if (sub === "import" && !part && req.method === "POST") {
            const parsed = ImportBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid import" });
            const found = parsed.data.format === "csv" ? parseRequirementsCsv(parsed.data.text) : parseRequirementsMarkdown(parsed.data.text);
            if ("error" in found) return sendJson(res, 400, { error: found.error });
            if (found.length === 0) return sendJson(res, 400, { error: "No requirement found in the file" });
            if (found.length > 300) return sendJson(res, 400, { error: "At most 300 requirements per import" });
            if (parsed.data.dryRun) return sendJson(res, 200, { preview: found });
            const file = await loadRequirements(repoRoot, projectId);
            const created = toRequirements(found, file.requirements, "imported");
            await saveRequirements(repoRoot, projectId, [...file.requirements, ...created]);
            return sendJson(res, 200, { ...(await requirementsResponse(map)), createdIds: created.map((r) => r.id) });
          }

          if (sub === "matrix" && !part && req.method === "GET") {
            const params = new URLSearchParams(query);
            const format = params.get("format") === "csv" ? "csv" : "markdown";
            const body = matrix(await requirementsResponse(map), format);
            res.statusCode = 200;
            res.setHeader("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            if (params.get("download") === "1") res.setHeader("Content-Disposition", `attachment; filename="${projectId}-traceability.${format === "csv" ? "csv" : "md"}"`);
            return res.end(body);
          }

          if (sub === "job" && !part) {
            if (!action && req.method === "GET") return sendJson(res, 200, { job: publicJob(job) });
            if (action === "cancel" && req.method === "POST") {
              if (!job || job.state !== "running") return sendJson(res, 409, { error: "No analysis in progress" });
              cancelAgentJob(job);
              return sendJson(res, 202, { job: publicJob(job) });
            }
          }

          if (!sub || RESERVED.has(sub)) return sendJson(res, 405, { error: "Method not allowed" });
          const file = await loadRequirements(repoRoot, projectId);
          const existing = file.requirements.find((r) => r.id === sub);
          if (!existing) return sendJson(res, 404, { error: "Requirement not found" });

          if (!part && req.method === "PUT") {
            const parsed = UpdateBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid requirement" });
            const u = parsed.data;
            if (u.baseUpdatedAt !== undefined && (u.baseUpdatedAt ?? "") !== file.updatedAt) {
              return sendJson(res, 409, { error: "Requirements changed since you loaded them — reload and try again" });
            }
            const bad = await invalidRefs(projectId, u.criteria, u.useCaseId);
            if (bad) return sendJson(res, 400, { error: bad });
            const updated: Requirement = { ...existing, updatedAt: new Date().toISOString() };
            if (u.title) updated.title = u.title;
            if (u.text !== undefined) updated.text = u.text;
            if (u.key === null || u.key === "") delete updated.key;
            else if (u.key !== undefined) updated.key = u.key;
            if (u.useCaseId === null) delete updated.useCaseId;
            else if (u.useCaseId !== undefined) updated.useCaseId = u.useCaseId;
            if (u.criteria) {
              const out: Requirement["criteria"] = [];
              for (const c of u.criteria) out.push({ id: c.id && !out.some((o) => o.id === c.id) ? c.id : nextCriterionId([...existing.criteria, ...out]), text: c.text, caseIds: [...new Set(c.caseIds)] });
              updated.criteria = out;
            }
            await saveRequirements(repoRoot, projectId, file.requirements.map((r) => (r.id === sub ? updated : r)));
            return respondAfterChange(res, map);
          }

          if (!part && req.method === "DELETE") {
            await saveRequirements(repoRoot, projectId, file.requirements.filter((r) => r.id !== sub));
            await saveAnalyses(repoRoot, projectId, (await loadAnalyses(repoRoot, projectId)).filter((a) => a.requirementId !== sub));
            return respondAfterChange(res, map);
          }

          if (part === "analyze" && !action && req.method === "POST") {
            const busy = runningJobForProject(projectId);
            if (busy) return sendJson(res, 409, { error: `Another agent is running on this project (${busy.label}) — one at a time`, job: publicJob(job) });
            const parsed = AnalyzeBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid body" });
            // The user's free text: one quoted argument, no quotes/newlines inside.
            const request = parsed.data.request?.replace(/["\r\n]+/g, " ").trim() || undefined;
            const { analyst } = (await loadProjectSettings(repoRoot, projectId)).agents;
            const started = startAgentJob({
              kind: "analyze",
              projectId,
              label: `analyst (${existing.key ?? existing.title})`.slice(0, 80),
              meta: { requirementId: existing.id, request: request ?? null },
              cwd: repoRoot,
              prompt: `/navmap-requirements ${projectId} requirement=${existing.id}${request ? ` request="${request}"` : ""}`,
              model: analyst.model,
              budgetUsd: analyst.budgetUsd,
              allowedTools: ["Read", "Glob", "Grep", `Edit(${projectPaths(projectId).staging}/**)`, ...shellCommands(ANALYZE_COMMANDS)],
              onExit: async (finished) => {
                finished.meta.proposal = (await loadAnalyses(repoRoot, projectId)).some((a) => a.requirementId === existing.id && a.createdAt >= finished.startedAt);
              },
            });
            return sendJson(res, 202, { job: publicJob(started) });
          }

          if (part === "proposal" && (action === "accept" || action === "discard") && req.method === "POST") {
            const analyses = await loadAnalyses(repoRoot, projectId);
            const analysis = analyses.find((a) => a.requirementId === sub);
            if (!analysis) return sendJson(res, 404, { error: "No analysis to review" });
            if (action === "accept") {
              // Proposed criteria that name an existing one refine it (links added, the user's kept);
              // new ones are appended; criteria it doesn't mention stay as they were.
              const known = new Set((await loadCases(repoRoot, projectId)).map((c) => c.id));
              const criteria = existing.criteria.map((c) => ({ ...c }));
              for (const p of analysis.criteria) {
                const ids = p.caseIds.filter((id) => known.has(id));
                const same = p.id ? criteria.find((c) => c.id === p.id) : undefined;
                if (same) {
                  same.text = p.text;
                  same.caseIds = [...new Set([...same.caseIds, ...ids])];
                } else criteria.push({ id: nextCriterionId(criteria), text: p.text, caseIds: [...new Set(ids)] });
              }
              const org = analysis.useCaseId && !existing.useCaseId ? await loadOrganization(repoRoot, projectId) : null;
              const useCaseId = existing.useCaseId ?? (org && analysis.useCaseId && findUseCase(org, analysis.useCaseId) ? analysis.useCaseId : undefined);
              const updated: Requirement = { ...existing, criteria: criteria.slice(0, 50), ...(useCaseId ? { useCaseId } : {}), updatedAt: new Date().toISOString() };
              await saveRequirements(repoRoot, projectId, file.requirements.map((r) => (r.id === sub ? updated : r)));
            }
            await saveAnalyses(repoRoot, projectId, analyses.filter((a) => a.requirementId !== sub));
            return respondAfterChange(res, map);
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-requirements-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Requirements request failed" });
        }
      });
    },
  };
}
