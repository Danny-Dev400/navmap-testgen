import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";
import { loadMap, PROJECT_ID_RE, sendJson } from "./apiHelpers";
import { abs, projectPaths } from "../../src/project-paths";
import { regenerateProject } from "./regenerate";

// /api/projects/<id>/coverage/regeneration (what the last regeneration changed) and
// /coverage/generate (a manual regeneration — normally it happens on its own after every change).
// Test cases and their status live in navmapCasesApi.ts.
const COVERAGE_PATH_RE = /^\/([a-z0-9-]{1,80})\/coverage\/(regeneration|generate)\/?$/;

export function navmapCoverageApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  return {
    name: "navmap-coverage-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const match = COVERAGE_PATH_RE.exec(req.url ?? "/");
        if (!match) return next();
        const [, id, action] = match;
        if (!PROJECT_ID_RE.test(id)) return sendJson(res, 400, { error: "Invalid project id" });

        try {
          if (!(await loadMap(repoRoot, id))) return sendJson(res, 404, { error: "Project not found" });

          if (req.method === "GET" && action === "regeneration") {
            try {
              return sendJson(res, 200, JSON.parse(await readFile(abs(repoRoot, projectPaths(id).lastRegeneration), "utf-8")));
            } catch {
              return sendJson(res, 404, { error: "No regeneration recorded yet" });
            }
          }

          if (req.method === "POST" && action === "generate") {
            const result = await regenerateProject(repoRoot, id);
            return sendJson(res, 200, { regeneration: result?.regeneration ?? null });
          }
        } catch (err) {
          console.error(`[navmap-coverage-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Coverage request failed" });
        }

        next();
      });
    },
  };
}
