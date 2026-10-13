import { spawn } from "node:child_process";
import path from "node:path";
import type { Plugin } from "vite";
import { listPageSnapshots, readPageSnapshot } from "../../src/navmap-snapshots";
import { loadMap, PROJECT_ID_RE, sendJson } from "./apiHelpers";
import { runningJobForProject } from "./agentJobs";

// /api/projects/<id>/snapshots[/refresh | /<pageId>] — everything else falls through.
const SNAPSHOTS_RE = /^\/([a-z0-9-]{1,80})\/snapshots(?:\/([a-z0-9_-]{1,200}))?\/?$/;

// projectId -> a refresh in progress (one at a time per project).
const refreshing = new Set<string>();

export function navmapSnapshotsApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  /** Runs scripts/navmap-snapshots.ts (no agent, no quota: page loads only) and returns its summary. */
  function refresh(projectId: string): Promise<{ ok: boolean; summary: unknown; output: string }> {
    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    // Arguments are a regex-validated project id; no shell involved.
    const child = spawn(process.execPath, [tsxCli, "scripts/navmap-snapshots.ts", projectId], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c) => (output += c.toString()));
    child.stderr.on("data", (c) => (output += c.toString()));
    return new Promise((resolve) => {
      child.on("close", (code) => {
        const line = output.split(/\r?\n/).find((l) => l.startsWith("SNAPSHOTS_JSON "));
        let summary: unknown = null;
        try {
          summary = line ? JSON.parse(line.slice("SNAPSHOTS_JSON ".length)) : null;
        } catch {
          // no summary — the output tail explains why
        }
        // The script scrubs credentials itself and prints only page titles and reasons.
        resolve({ ok: code === 0 && !!summary, summary, output: output.replace(/^SNAPSHOTS_JSON .*$/m, "").slice(-2000) });
      });
      child.on("error", (err) => resolve({ ok: false, summary: null, output: err.message }));
    });
  }

  return {
    name: "navmap-snapshots-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const m = SNAPSHOTS_RE.exec((req.url ?? "/").split("?")[0]);
        if (!m) return next();
        const [, projectId, sub] = m;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });
        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });

          if (!sub && req.method === "GET") return sendJson(res, 200, { snapshots: await listPageSnapshots(repoRoot, projectId) });

          if (sub === "refresh" && req.method === "POST") {
            if (runningJobForProject(projectId)?.kind === "explore") return sendJson(res, 409, { error: "An exploration is running — it captures snapshots itself" });
            if (refreshing.has(projectId)) return sendJson(res, 409, { error: "A snapshot refresh is already running" });
            refreshing.add(projectId);
            try {
              const result = await refresh(projectId);
              return sendJson(res, result.ok ? 200 : 500, { ...result, snapshots: await listPageSnapshots(repoRoot, projectId) });
            } finally {
              refreshing.delete(projectId);
            }
          }

          if (sub && sub !== "refresh" && req.method === "GET") {
            if (!map.pages[sub]) return sendJson(res, 404, { error: "Unknown page" });
            const snapshot = await readPageSnapshot(repoRoot, projectId, sub);
            return snapshot ? sendJson(res, 200, snapshot) : sendJson(res, 404, { error: "Not captured yet" });
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-snapshots-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Snapshots request failed" });
        }
      });
    },
  };
}
