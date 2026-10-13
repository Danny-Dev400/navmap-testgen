import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { z } from "zod/v4";
import { loadEdgeFlags, saveEdgeFlags } from "../../src/navmap-edge-flags";
import { abs, projectPaths } from "../../src/project-paths";
import { loadMap, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";
import { locateTest, pomMethodsForTest } from "./generatedCode";
import { regenerateProject } from "./regenerate";

// /api/projects/<id>/code/case/<caseId>, /code/file?path=…, /edge-flags — everything else falls through.
const CODE_RE = /^\/([a-z0-9-]{1,80})\/(?:code\/(case|file)(?:\/([a-z0-9_-]{1,120}))?|(edge-flags))\/?$/;

const FlagBody = z.object({ edgeId: z.string().regex(/^[a-z0-9_-]{1,300}$/), destructive: z.boolean().nullable() });

export function navmapCodeApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  return {
    name: "navmap-code-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const [pathname, query = ""] = (req.url ?? "/").split("?");
        const m = CODE_RE.exec(pathname);
        if (!m) return next();
        const [, projectId, codeKind, caseId, flagsRoute] = m;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });

        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });

          if (codeKind === "case" && caseId && req.method === "GET") {
            const test = await locateTest(repoRoot, projectId, caseId);
            if (!test) return sendJson(res, 404, { error: "No generated test for this case — approve it first" });
            return sendJson(res, 200, { spec: test, methods: await pomMethodsForTest(repoRoot, projectId, test.code) });
          }

          if (codeKind === "file" && !caseId && req.method === "GET") {
            // Only files inside this project's generated tests — never credentials, sessions or anything else.
            const requested = new URLSearchParams(query).get("path") ?? "";
            const testsRoot = abs(repoRoot, projectPaths(projectId).tests);
            const resolved = path.resolve(repoRoot, requested);
            const relative = path.relative(testsRoot, resolved);
            if (!requested || relative.startsWith("..") || path.isAbsolute(relative) || !resolved.endsWith(".ts")) {
              return sendJson(res, 400, { error: "Only generated test files of this project can be viewed" });
            }
            try {
              return sendJson(res, 200, { file: requested, code: await readFile(resolved, "utf-8") });
            } catch {
              return sendJson(res, 404, { error: "File not found" });
            }
          }

          if (flagsRoute && req.method === "GET") return sendJson(res, 200, await loadEdgeFlags(repoRoot, projectId));

          if (flagsRoute && req.method === "PUT") {
            const parsed = FlagBody.safeParse(await readJsonBody(req));
            if (!parsed.success || !map.edges[parsed.data.edgeId]) return sendJson(res, 400, { error: "Invalid edge flag" });
            const flags = await loadEdgeFlags(repoRoot, projectId);
            // null clears the override, falling back to the agent's own tag.
            if (parsed.data.destructive === null) delete flags.destructive[parsed.data.edgeId];
            else flags.destructive[parsed.data.edgeId] = parsed.data.destructive;
            await saveEdgeFlags(repoRoot, projectId, flags);
            // The @destructive tag lives in the generated code.
            const regenerated = await regenerateProject(repoRoot, projectId);
            return sendJson(res, 200, { flags, regeneration: regenerated?.regeneration ?? null });
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-code-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Code request failed" });
        }
      });
    },
  };
}
