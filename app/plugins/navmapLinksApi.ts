import type { Plugin } from "vite";
import { z } from "zod/v4";
import { loadLinks } from "../../src/navmap-links";
import { saveStateGraph, validateStateGraph } from "../../src/navmap-states";
import { loadProjectUsers } from "../../src/navmap-users";
import { loadPersistedGraph } from "./navmapStatesApi";
import { loadProjectSettings } from "../../src/navmap-settings";
import { projectPaths } from "../../src/project-paths";
import { loadMap, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";
import { cancelAgentJob, getJob, publicJob, runningJobForProject, shellCommands, startAgentJob } from "./agentJobs";
import { regenerateProject } from "./regenerate";

// /api/projects/<id>/links, /links/run, /links/job, /links/job/cancel — everything else falls through.
const LINKS_PATH_RE = /^\/([a-z0-9-]{1,80})\/links(?:\/(run|job|share-item))?(?:\/(cancel))?\/?$/;

const ShareItemBody = z.object({ edgeId: z.string().min(1), precondition: z.string().min(1), shareItem: z.boolean() });

const RunBody = z.object({ verify: z.boolean().default(false) });

// Model and budget come from the project's settings (projects/<id>/settings.json, Settings tab) —
// always an explicit model rather than the user's CLI default, which can change silently. The
// defaults and the eval behind them live in src/navmap-settings.ts.

/** Least privilege: the state linker's helper scripts (context, validated save, questions for the
 *  human, run ids), writes confined to this project's staging folder (verified empirically:
 *  Edit(<dir>/**) allows Write there and denies it elsewhere), and — only when asked to verify —
 *  regenerating and running tests against the live site. */
function allowedTools(projectId: string, verify: boolean): string[] {
  const commands = ["npm run navmap:state-candidates:*", "npm run navmap:save-states:*", "npm run navmap:ask:*", "npm run navmap:run-id:*"];
  if (verify) commands.push("npm run navmap:generate-tests:*", "npx playwright test:*");
  return ["Read", "Glob", "Grep", `Edit(${projectPaths(projectId).staging}/**)`, ...shellCommands(commands)];
}

export function navmapLinksApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  return {
    name: "navmap-links-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const match = LINKS_PATH_RE.exec(req.url ?? "/");
        if (!match) return next();
        const [, projectId, sub, action] = match;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });

        try {
          if (!(await loadMap(repoRoot, projectId))) return sendJson(res, 404, { error: "Project not found" });
          const job = getJob("link", projectId);

          if (!sub && req.method === "GET") return sendJson(res, 200, { links: await loadLinks(repoRoot, projectId) });

          if (sub === "run" && !action && req.method === "POST") {
            const busy = runningJobForProject(projectId);
            if (busy) {
              return sendJson(res, 409, {
                error: busy.kind === "link" ? "A linking run is already in progress" : "This project's map is being explored right now",
                job: publicJob(job),
              });
            }
            const parsed = RunBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid body" });
            const { verify } = parsed.data;
            const { linker } = (await loadProjectSettings(repoRoot, projectId)).agents;
            const started = startAgentJob({
              kind: "link",
              projectId,
              label: `linker${verify ? " (with live verification)" : ""}`,
              meta: { verify },
              cwd: repoRoot,
              // Nothing user-supplied except a regex-validated project id and a boolean.
              prompt: `/navmap-link-preconditions ${projectId}${verify ? " verify=true" : ""}`,
              model: linker.model,
              budgetUsd: linker.budgetUsd,
              allowedTools: allowedTools(projectId, verify),
              // Links change which tests can run as chains — whatever the outcome, a run may have saved some.
              onExit: () => regenerateProject(repoRoot, projectId).then(() => undefined),
            });
            return sendJson(res, 202, { job: publicJob(started) });
          }

          // The user's explicit say on one precondition: does the state's flow act on the action's
          // own list item? Lives on the state graph's binding (it replaced precondition links).
          if (sub === "share-item" && !action && req.method === "PUT") {
            const parsed = ShareItemBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid body" });
            const map = (await loadMap(repoRoot, projectId))!;
            const graph = await loadPersistedGraph(repoRoot, map);
            const binding = graph.bindings.find((b) => b.edgeId === parsed.data.edgeId && b.precondition === parsed.data.precondition);
            if (!binding) return sendJson(res, 404, { error: "That precondition isn't linked to a state" });
            const next = {
              states: graph.states,
              bindings: graph.bindings.map((b) => (b === binding ? { edgeId: b.edgeId, precondition: b.precondition, stateId: b.stateId, ...(parsed.data.shareItem ? { sameItem: true } : {}) } : b)),
            };
            const errors = validateStateGraph(next, map, await loadProjectUsers(repoRoot, map));
            if (errors.length) return sendJson(res, 400, { error: errors[0] });
            await saveStateGraph(repoRoot, projectId, next);
            const regenerated = await regenerateProject(repoRoot, projectId);
            return sendJson(res, 200, { binding: { ...binding, sameItem: parsed.data.shareItem }, regeneration: regenerated?.regeneration ?? null });
          }

          if (sub === "job" && !action && req.method === "GET") return sendJson(res, 200, { job: publicJob(job) });

          if (sub === "job" && action === "cancel" && req.method === "POST") {
            if (!job || job.state !== "running") return sendJson(res, 409, { error: "No linking run in progress" });
            cancelAgentJob(job);
            return sendJson(res, 202, { job: publicJob(job) });
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-links-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Links request failed" });
        }
      });
    },
  };
}
