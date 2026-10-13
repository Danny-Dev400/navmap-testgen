import type { Plugin } from "vite";
import { CASE_ID_RE } from "../../src/navmap-cases";
import { loadManualExport, manualExportFileName, MANUAL_FORMATS, renderManualExport, type ManualFormat, type ManualScope } from "../../src/navmap-manual-cases";
import { loadMap, PROJECT_ID_RE, sendJson } from "./apiHelpers";

// GET /api/projects/<id>/export/manual?format=markdown|testrail|xray|zephyr[&feature=<id> | &case=<id> | &cases=<id>,<id>… | &suite=<id>][&download=1]
// The project's test cases as manual test cases (src/navmap-manual-cases.ts). Read-only; built from
// the map and the cases, never from credentials. download=1 adds Content-Disposition so the browser
// saves it; without it the text comes back for the preview. X-Manual-Count = how many cases it holds.
const EXPORT_RE = /^\/([a-z0-9-]{1,80})\/export\/manual\/?$/;
const FEATURE_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export function navmapExportApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  return {
    name: "navmap-export-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const [pathname, query = ""] = (req.url ?? "/").split("?");
        const match = EXPORT_RE.exec(pathname);
        if (!match) return next();
        if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
        const projectId = match[1];
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });

        const params = new URLSearchParams(query);
        const format = (params.get("format") ?? "markdown") as ManualFormat;
        if (!MANUAL_FORMATS.includes(format)) return sendJson(res, 400, { error: `Unknown format "${format}"` });
        const feature = params.get("feature");
        const caseId = params.get("case");
        const caseIds = params.get("cases")?.split(",").filter(Boolean);
        const suite = params.get("suite");
        if (feature && !FEATURE_ID_RE.test(feature)) return sendJson(res, 400, { error: "Invalid feature id" });
        if (suite && !FEATURE_ID_RE.test(suite)) return sendJson(res, 400, { error: "Invalid suite id" });
        if (caseId && !CASE_ID_RE.test(caseId)) return sendJson(res, 400, { error: "Invalid case id" });
        if (caseIds && (caseIds.length > 500 || caseIds.some((id) => !CASE_ID_RE.test(id)))) return sendJson(res, 400, { error: "Invalid case ids" });
        const scope: ManualScope = caseId
          ? { kind: "case", caseId }
          : caseIds?.length
            ? { kind: "cases", caseIds }
            : suite
              ? { kind: "suite", suiteId: suite }
              : feature
                ? { kind: "feature", featureId: feature }
                : { kind: "project" };

        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });
          // In a test-management tool each data row is its own test; the Markdown keeps one table.
          const exp = await loadManualExport(repoRoot, map, scope, { expandRows: format !== "markdown" });
          if ("error" in exp) return sendJson(res, 404, { error: exp.error });
          const body = renderManualExport(exp, format);
          res.statusCode = 200;
          res.setHeader("Content-Type", format === "markdown" ? "text/markdown; charset=utf-8" : "text/csv; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Manual-Count", String(exp.cases.length));
          if (params.get("download") === "1") res.setHeader("Content-Disposition", `attachment; filename="${manualExportFileName(projectId, scope, format)}"`);
          res.end(body);
        } catch (err) {
          sendJson(res, 500, { error: String(err) });
        }
      });
    },
  };
}
