import type { Plugin } from "vite";
import { z } from "zod/v4";
import type { NavigationMap } from "../../src/navmap-types";
import { CASE_ID_RE, loadCases } from "../../src/navmap-cases";
import {
  assignCases,
  assignIds,
  deleteProposal,
  findUseCase,
  loadOrganization,
  loadProposal,
  OrganizationInputSchema,
  sanitizeOrganization,
  saveOrganization,
  saveProposal,
  validateOrganization,
  EMPTY_ORGANIZATION,
} from "../../src/navmap-features";
import { loadProjectSettings } from "../../src/navmap-settings";
import { projectPaths } from "../../src/project-paths";
import { loadMap, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";
import { cancelAgentJob, getJob, publicJob, runningJobForProject, shellCommands, startAgentJob } from "./agentJobs";
import { casesResponse } from "./navmapCasesApi";
import { regenerateProject } from "./regenerate";

// /api/projects/<id>/features[/assign | /proposal/(accept|discard) | /organize | /job[/cancel]]
const FEATURES_RE = /^\/([a-z0-9-]{1,80})\/features(?:\/(assign|proposal|organize|job))?(?:\/(accept|discard|cancel))?\/?$/;

const PutBody = z.object({
  organization: OrganizationInputSchema,
  /** The updatedAt the editor started from (null when there was none) — a stale one is refused. */
  baseUpdatedAt: z.string().nullable(),
});
const AssignBody = z.object({ caseIds: z.array(z.string().regex(CASE_ID_RE)).min(1).max(500), useCaseId: z.string().nullable() });
const OrganizeBody = z.object({ request: z.string().max(1000).optional() });

/** The organizer reads a compact context and saves a proposal — text only: no browser, no MCP,
 *  writes confined to the project's staging folder. */
const ORGANIZE_COMMANDS = ["npm run navmap:organize-context:*", "npm run navmap:save-features:*", "npm run navmap:run-id:*"];

export function navmapFeaturesApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  /** After any organization change: tags in the generated code follow, then the tab refreshes. */
  async function respondAfterChange(res: Parameters<typeof sendJson>[0], map: NavigationMap) {
    const regenerated = await regenerateProject(repoRoot, map.id);
    return sendJson(res, 200, { ...(await casesResponse(repoRoot, map)), regeneration: regenerated?.regeneration ?? null });
  }

  return {
    name: "navmap-features-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const match = FEATURES_RE.exec((req.url ?? "/").split("?")[0]);
        if (!match) return next();
        const [, projectId, sub, action] = match;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });

        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });
          const job = getJob("organize", projectId);

          if (!sub && !action && req.method === "GET") {
            const cases = await loadCases(repoRoot, projectId);
            const org = await loadOrganization(repoRoot, projectId);
            return sendJson(res, 200, {
              organization: org ? sanitizeOrganization(org, map, cases).org : null,
              proposal: await loadProposal(repoRoot, projectId),
              job: publicJob(job),
            });
          }

          // The whole organization as edited in the UI (features, use cases, their actions and cases).
          if (!sub && !action && req.method === "PUT") {
            const parsed = PutBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid organization", details: z.prettifyError(parsed.error) });
            const current = await loadOrganization(repoRoot, projectId);
            if ((current?.updatedAt ?? null) !== parsed.data.baseUpdatedAt) {
              return sendJson(res, 409, { error: "The organization changed meanwhile (another tab or the organizer) — reload and try again" });
            }
            const cases = await loadCases(repoRoot, projectId);
            // A case deleted meanwhile is simply dropped; real conflicts (a case twice, duplicate ids) are refused.
            const next = sanitizeOrganization(assignIds(parsed.data.organization), map, cases).org;
            const errors = validateOrganization(next, map, cases);
            if (errors.length) return sendJson(res, 400, { error: errors[0], details: errors.join("\n") });
            await saveOrganization(repoRoot, projectId, { ...next, updatedAt: "" });
            return respondAfterChange(res, map);
          }

          // Move cases into a use case (or back to Unsorted with null) — the case modal's picker and
          // "Sort as suggested".
          if (sub === "assign" && !action && req.method === "POST") {
            const parsed = AssignBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid request" });
            const cases = await loadCases(repoRoot, projectId);
            const known = new Set(cases.map((c) => c.id));
            const unknown = parsed.data.caseIds.find((id) => !known.has(id));
            if (unknown) return sendJson(res, 400, { error: `Unknown test case "${unknown}"` });
            const current = await loadOrganization(repoRoot, projectId);
            if (parsed.data.useCaseId && !(current && findUseCase(current, parsed.data.useCaseId))) return sendJson(res, 404, { error: "Unknown use case" });
            const clean = sanitizeOrganization(current ?? EMPTY_ORGANIZATION, map, cases).org;
            await saveOrganization(repoRoot, projectId, assignCases(clean, parsed.data.caseIds, parsed.data.useCaseId));
            return respondAfterChange(res, map);
          }

          if (sub === "proposal" && (action === "accept" || action === "discard") && req.method === "POST") {
            const proposal = await loadProposal(repoRoot, projectId);
            if (!proposal) return sendJson(res, 404, { error: "No proposal to review" });
            if (action === "accept") {
              const cases = await loadCases(repoRoot, projectId);
              // Cases or actions may have changed since it was proposed: stale references are dropped.
              await saveOrganization(repoRoot, projectId, sanitizeOrganization(proposal.organization, map, cases).org);
            }
            await deleteProposal(repoRoot, projectId);
            return respondAfterChange(res, map);
          }

          if (sub === "organize" && !action && req.method === "POST") {
            const busy = runningJobForProject(projectId);
            if (busy) return sendJson(res, 409, { error: `Another agent is running on this project (${busy.label}) — one at a time`, job: publicJob(job) });
            const parsed = OrganizeBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid body" });
            // The request is the user's free text: one quoted argument, no quotes/newlines inside.
            const request = parsed.data.request?.replace(/["\r\n]+/g, " ").trim() || undefined;
            const { organizer } = (await loadProjectSettings(repoRoot, projectId)).agents;
            const existing = await loadOrganization(repoRoot, projectId);
            const startedAt = new Date().toISOString();
            const started = startAgentJob({
              kind: "organize",
              projectId,
              label: existing ? "organizer (update)" : "organizer",
              meta: { request: request ?? null },
              cwd: repoRoot,
              prompt: `/navmap-organize ${projectId}${request ? ` request="${request}"` : ""}`,
              model: organizer.model,
              budgetUsd: organizer.budgetUsd,
              allowedTools: ["Read", "Glob", "Grep", `Edit(${projectPaths(projectId).staging}/**)`, ...shellCommands(ORGANIZE_COMMANDS)],
              onExit: async (finished) => {
                // Stamp the user's request on the proposal this run saved, so the review shows what was asked.
                const proposal = await loadProposal(repoRoot, projectId);
                if (proposal && proposal.createdAt >= startedAt && request) await saveProposal(repoRoot, projectId, { ...proposal, request });
                finished.meta.proposal = !!proposal && proposal.createdAt >= startedAt;
              },
            });
            return sendJson(res, 202, { job: publicJob(started) });
          }

          if (sub === "job" && !action && req.method === "GET") return sendJson(res, 200, { job: publicJob(job) });

          if (sub === "job" && action === "cancel" && req.method === "POST") {
            if (!job || job.state !== "running") return sendJson(res, 409, { error: "No organizer run in progress" });
            cancelAgentJob(job);
            return sendJson(res, 202, { job: publicJob(job) });
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-features-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Features request failed" });
        }
      });
    },
  };
}
