import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { NavigationMapSchema, type NavigationMap, type ProjectSummary } from "../../src/navmap-types";
import { MIME_BY_EXT } from "../../scripts/screenshots";
import { planCases } from "../../src/navmap-test-generator";
import { loadCases } from "../../src/navmap-cases";
import { loadEdgeFlags } from "../../src/navmap-edge-flags";
import { loadProjectUsers } from "../../src/navmap-users";
import { loadStateGraph } from "../../src/navmap-states";
import { latestRunSummary } from "./navmapRunsApi";
import { abs, listProjectIds, PROJECT_ID_RE, projectPaths } from "../../src/project-paths";

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function rewriteScreenshotPaths(map: NavigationMap): NavigationMap {
  return {
    ...map,
    edges: Object.fromEntries(
      Object.entries(map.edges).map(([id, edge]) => [
        id,
        {
          ...edge,
          screenshot: edge.screenshot ? `/${edge.screenshot}` : undefined,
          screenshotBefore: edge.screenshotBefore ? `/${edge.screenshotBefore}` : undefined,
        },
      ]),
    ),
  };
}

/** Card health: how many approved test cases are runnable (and how many drafts await review), the newest dashboard test run, and the cumulative
 *  estimated agent cost from agent-usage.jsonl. */
async function projectHealth(repoRoot: string, map: NavigationMap): Promise<ProjectSummary["health"]> {
  const cases = await loadCases(repoRoot, map.id);
  const plans = planCases(map, await loadProjectUsers(repoRoot, map), await loadStateGraph(repoRoot, map.id, map), cases, await loadEdgeFlags(repoRoot, map.id));
  const approved = cases.filter((c) => c.status === "approved");
  const runnable = approved.filter((c) => plans.get(c.id)?.runnable).length;
  const drafts = cases.filter((c) => c.status === "draft").length;
  const latest = await latestRunSummary(repoRoot, map.id);
  const lastRun = latest
    ? {
        finishedAt: latest.finishedAt,
        passed: latest.counts.passed,
        failed: latest.counts.failed,
        flaky: latest.counts.flaky,
        skipped: latest.counts.skipped + latest.counts.fixme,
      }
    : null;
  let quotaUsd = 0;
  const usage = await readFile(abs(repoRoot, projectPaths(map.id).agentUsage), "utf-8").catch(() => "");
  for (const line of usage.split("\n")) {
    try {
      if (line.trim()) quotaUsd += Number(JSON.parse(line).costUsd) || 0;
    } catch {
      // a torn line — ignore
    }
  }
  return { runnable, total: approved.length, drafts, lastRun, quotaUsd: Math.round(quotaUsd * 100) / 100 };
}

export function navmapApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  return {
    name: "navmap-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res) => {
        // Must always answer — returning without a response (or next()) leaves the request hanging
        // forever. Write endpoints live in the coverage/users plugins registered before this one, so
        // any non-GET that reaches here is genuinely unsupported.
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        const id = decodeURIComponent((req.url ?? "/").replace(/^\/+/, ""));

        if (id === "") {
          const summaries: ProjectSummary[] = [];
          for (const projectId of listProjectIds(repoRoot)) {
            const file = projectPaths(projectId).navmap;
            try {
              const raw = await readFile(abs(repoRoot, file), "utf-8");
              const result = NavigationMapSchema.safeParse(JSON.parse(raw));
              if (!result.success) {
                console.warn(`[navmap-api] Skipping invalid navmap file ${file}`);
                continue;
              }
              const map = result.data;
              summaries.push({
                id: map.id,
                targetHost: map.targetHost,
                pageCount: Object.keys(map.pages).length,
                edgeCount: Object.keys(map.edges).length,
                totalRunsMerged: map.totalRunsMerged,
                updatedAt: map.updatedAt,
                health: await projectHealth(repoRoot, map).catch(() => undefined),
              });
            } catch {
              console.warn(`[navmap-api] Skipping unreadable navmap file ${file}`);
            }
          }
          summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          sendJson(res, 200, summaries);
          return;
        }

        if (!PROJECT_ID_RE.test(id)) {
          sendJson(res, 400, { error: "Invalid project id" });
          return;
        }

        try {
          const raw = await readFile(abs(repoRoot, projectPaths(id).navmap), "utf-8");
          const map = NavigationMapSchema.parse(JSON.parse(raw));
          sendJson(res, 200, rewriteScreenshotPaths(map));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            sendJson(res, 404, { error: "Project not found" });
          } else {
            console.error(`[navmap-api] Failed to load project "${id}":`, err);
            sendJson(res, 500, { error: "Failed to load project" });
          }
        }
      });
    },
  };
}

/** Serves projects/<id>/screenshots/** and nothing else under projects/ — a project folder also
 *  holds credentials/ and .auth/ (saved sessions), which must never be reachable over HTTP. Map
 *  screenshot refs are repo-relative ("projects/<id>/screenshots/x.png"), so "/" + ref is the URL. */
export function repoScreenshotsPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  return {
    name: "navmap-screenshots",
    configureServer(server) {
      // This middleware does its own raw node:fs read and writes the response directly — it
      // never goes through Vite's own static/@fs serving machinery, so server.fs.allow is
      // irrelevant here and shouldn't be touched to "fix" anything related to this route.
      server.middlewares.use("/projects", async (req, res, next) => {
        if (req.method !== "GET") return next();

        // Map screenshots, plus test-run screenshots and videos (never traces, which hold network
        // data and typed values — those only open locally via show-trace).
        const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const shot = /^\/([^/]+)\/screenshots\/(.+)$/.exec(url);
        const run = /^\/([^/]+)\/runs\/([0-9]{8}-[0-9]{6}-[a-z0-9]{4})\/artifacts\/(.+)$/.exec(url);
        const projectId = shot?.[1] ?? run?.[1];
        if (!projectId || !PROJECT_ID_RE.test(projectId)) return next();
        const allowedRoot = shot
          ? abs(repoRoot, projectPaths(projectId).screenshots)
          : abs(repoRoot, path.posix.join(projectPaths(projectId).runs, run![2], "artifacts"));
        const requested = path.join(allowedRoot, shot ? shot[2] : run![3]);
        const relative = path.relative(allowedRoot, requested);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return next();

        const ext = path.extname(requested).toLowerCase();
        const mime = run && ext === ".webm" ? "video/webm" : MIME_BY_EXT[ext];
        if (!mime) return next();

        try {
          const bytes = await readFile(requested);
          res.statusCode = 200;
          res.setHeader("Content-Type", mime);
          res.end(bytes);
        } catch {
          next();
        }
      });
    },
  };
}
