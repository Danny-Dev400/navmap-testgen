import type { Plugin } from "vite";
import { z } from "zod/v4";
import type { NavigationMap } from "../../src/navmap-types";
import { CASE_ID_RE, loadCases } from "../../src/navmap-cases";
import { ORG_ID_RE } from "../../src/navmap-features";
import { loadSuites, sanitizeSuites, saveSuites, suiteIdFor, type Suite } from "../../src/navmap-suites";
import { loadMap, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";
import { casesResponse } from "./navmapCasesApi";
import { regenerateProject } from "./regenerate";

// /api/projects/<id>/suites[/<suiteId>] — named selections of test cases (src/navmap-suites.ts).
// GET lists; POST creates; PUT /<id> renames / replaces / adds / removes cases; DELETE /<id>.
// Every change regenerates the code (suite tags) and answers with the whole Test cases response.
const SUITES_RE = /^\/([a-z0-9-]{1,80})\/suites(?:\/([a-z0-9][a-z0-9-]{0,59}))?\/?$/;

const CaseIds = z.array(z.string().regex(CASE_ID_RE)).max(500);
const CreateBody = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).optional(), caseIds: CaseIds.min(1) });
const UpdateBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  /** Replaces the suite's cases ("Update with the current selection"). */
  caseIds: CaseIds.optional(),
  addCaseIds: CaseIds.optional(),
  removeCaseIds: CaseIds.optional(),
  /** The suites updatedAt the client saw — a stale one is refused (409). */
  baseUpdatedAt: z.string().nullable().optional(),
});

export function navmapSuitesApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  async function respondAfterChange(res: Parameters<typeof sendJson>[0], map: NavigationMap, extra: Record<string, unknown> = {}) {
    const regenerated = await regenerateProject(repoRoot, map.id);
    return sendJson(res, 200, { ...(await casesResponse(repoRoot, map)), regeneration: regenerated?.regeneration ?? null, ...extra });
  }

  return {
    name: "navmap-suites-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const match = SUITES_RE.exec((req.url ?? "/").split("?")[0]);
        if (!match) return next();
        const [, projectId, suiteId] = match;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });

        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });
          const cases = await loadCases(repoRoot, projectId);
          const caseIds = new Set(cases.map((c) => c.id));
          const file = sanitizeSuites(await loadSuites(repoRoot, projectId), caseIds);
          const unknown = (ids: string[] | undefined) => (ids ?? []).find((id) => !caseIds.has(id));

          if (!suiteId && req.method === "GET") return sendJson(res, 200, file);

          if (!suiteId && req.method === "POST") {
            const parsed = CreateBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "A suite needs a name and at least one case" });
            const bad = unknown(parsed.data.caseIds);
            if (bad) return sendJson(res, 400, { error: `Unknown test case "${bad}"` });
            if (file.suites.some((s) => s.name.toLowerCase() === parsed.data.name.toLowerCase())) return sendJson(res, 409, { error: `There's already a suite called "${parsed.data.name}"` });
            const now = new Date().toISOString();
            const suite: Suite = {
              id: suiteIdFor(parsed.data.name, file.suites.map((s) => s.id)),
              name: parsed.data.name,
              ...(parsed.data.description ? { description: parsed.data.description } : {}),
              caseIds: [...new Set(parsed.data.caseIds)],
              createdAt: now,
              updatedAt: now,
            };
            await saveSuites(repoRoot, projectId, [...file.suites, suite]);
            return respondAfterChange(res, map, { createdSuiteId: suite.id });
          }

          if (!suiteId || !ORG_ID_RE.test(suiteId)) return sendJson(res, 404, { error: "Not found" });
          const existing = file.suites.find((s) => s.id === suiteId);
          if (!existing) return sendJson(res, 404, { error: "Suite not found" });

          if (req.method === "PUT") {
            const parsed = UpdateBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid request" });
            const u = parsed.data;
            if (u.baseUpdatedAt !== undefined && (u.baseUpdatedAt ?? "") !== file.updatedAt) {
              return sendJson(res, 409, { error: "Suites changed since you loaded them — reload and try again" });
            }
            const bad = unknown(u.caseIds) ?? unknown(u.addCaseIds);
            if (bad) return sendJson(res, 400, { error: `Unknown test case "${bad}"` });
            if (u.name && file.suites.some((s) => s.id !== suiteId && s.name.toLowerCase() === u.name!.toLowerCase())) {
              return sendJson(res, 409, { error: `There's already a suite called "${u.name}"` });
            }
            let ids = u.caseIds ?? existing.caseIds;
            if (u.addCaseIds) ids = [...ids, ...u.addCaseIds.filter((id) => !ids.includes(id))];
            if (u.removeCaseIds) ids = ids.filter((id) => !u.removeCaseIds!.includes(id));
            const updated: Suite = { ...existing, ...(u.name ? { name: u.name } : {}), caseIds: [...new Set(ids)], updatedAt: new Date().toISOString() };
            if (u.description === null) delete updated.description;
            else if (u.description !== undefined) updated.description = u.description;
            await saveSuites(repoRoot, projectId, file.suites.map((s) => (s.id === suiteId ? updated : s)));
            return respondAfterChange(res, map);
          }

          if (req.method === "DELETE") {
            await saveSuites(repoRoot, projectId, file.suites.filter((s) => s.id !== suiteId));
            return respondAfterChange(res, map);
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-suites-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Suites request failed" });
        }
      });
    },
  };
}
