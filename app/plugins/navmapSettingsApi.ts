import { existsSync } from "node:fs";
import type { Plugin } from "vite";
import { chromium, firefox, webkit } from "playwright";
import { AGENT_MODELS, DEFAULT_SETTINGS, loadProjectSettings, ProjectSettingsSchema, saveProjectSettings } from "../../src/navmap-settings";
import { loadMap, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";

/** Whether the browser build this Playwright version expects is downloaded — a stale cache from an
 *  older version doesn't count, which is exactly the case worth warning about. */
function installedBrowsers(): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries({ chromium, firefox, webkit }).map(([name, type]) => [name, existsSync(type.executablePath())]),
  );
}

// /api/projects/<id>/settings — everything else falls through.
const SETTINGS_PATH_RE = /^\/([a-z0-9-]{1,80})\/settings\/?$/;

export function navmapSettingsApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  return {
    name: "navmap-settings-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const match = SETTINGS_PATH_RE.exec(req.url ?? "/");
        if (!match) return next();
        const [, projectId] = match;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });

        try {
          if (!(await loadMap(repoRoot, projectId))) return sendJson(res, 404, { error: "Project not found" });

          if (req.method === "GET") {
            // A hand-broken file shouldn't lock the user out of the tab that fixes it: show defaults
            // and say why — saving replaces the file.
            let settings = DEFAULT_SETTINGS;
            let fileError: string | undefined;
            try {
              settings = await loadProjectSettings(repoRoot, projectId);
            } catch (err) {
              fileError = err instanceof Error ? err.message : String(err);
            }
            return sendJson(res, 200, { settings, fileError, defaults: DEFAULT_SETTINGS, models: AGENT_MODELS, browsersInstalled: installedBrowsers() });
          }

          if (req.method === "PUT") {
            const parsed = ProjectSettingsSchema.safeParse(await readJsonBody(req));
            if (!parsed.success) {
              const fieldErrors = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
              return sendJson(res, 400, { error: "Invalid settings", fieldErrors });
            }
            await saveProjectSettings(repoRoot, projectId, parsed.data);
            return sendJson(res, 200, { settings: parsed.data });
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-settings-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "Settings request failed" });
        }
      });
    },
  };
}
