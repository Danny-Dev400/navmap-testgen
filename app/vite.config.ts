import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { navmapApiPlugin, repoScreenshotsPlugin } from "./plugins/navmapDevServer";
import { navmapCoverageApiPlugin } from "./plugins/navmapCoverageApi";
import { navmapCasesApiPlugin } from "./plugins/navmapCasesApi";
import { navmapFeaturesApiPlugin } from "./plugins/navmapFeaturesApi";
import { navmapStatesApiPlugin } from "./plugins/navmapStatesApi";
import { navmapSnapshotsApiPlugin } from "./plugins/navmapSnapshotsApi";
import { navmapOverviewApiPlugin } from "./plugins/navmapOverviewApi";
import { navmapUsersApiPlugin } from "./plugins/navmapUsersApi";
import { navmapLinksApiPlugin } from "./plugins/navmapLinksApi";
import { navmapExploreApiPlugin } from "./plugins/navmapExploreApi";
import { navmapSettingsApiPlugin } from "./plugins/navmapSettingsApi";
import { navmapCodeApiPlugin } from "./plugins/navmapCodeApi";
import { navmapRunsApiPlugin } from "./plugins/navmapRunsApi";
import { navmapExportApiPlugin } from "./plugins/navmapExportApi";
import { navmapSuitesApiPlugin } from "./plugins/navmapSuitesApi";
import { navmapRequirementsApiPlugin } from "./plugins/navmapRequirementsApi";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "..");

export default defineConfig({
  plugins: [
    react(),
    repoScreenshotsPlugin({ repoRoot }),
    // Registered before navmapApiPlugin: these are also mounted at "/api/projects" and call next()
    // for anything that isn't their own sub-path (/coverage, /users, /settings…), falling through to
    // navmapApiPlugin's existing handling of plain /api/projects and /api/projects/:id.
    navmapCoverageApiPlugin({ repoRoot }),
    navmapCasesApiPlugin({ repoRoot }),
    navmapFeaturesApiPlugin({ repoRoot }),
    navmapStatesApiPlugin({ repoRoot }),
    navmapSnapshotsApiPlugin({ repoRoot }),
    navmapOverviewApiPlugin({ repoRoot }),
    navmapUsersApiPlugin({ repoRoot }),
    navmapLinksApiPlugin({ repoRoot }),
    navmapExploreApiPlugin({ repoRoot }),
    navmapSettingsApiPlugin({ repoRoot }),
    navmapCodeApiPlugin({ repoRoot }),
    navmapRunsApiPlugin({ repoRoot }),
    navmapExportApiPlugin({ repoRoot }),
    navmapSuitesApiPlugin({ repoRoot }),
    navmapRequirementsApiPlugin({ repoRoot }),
    navmapApiPlugin({ repoRoot }),
    viteSingleFile(),
  ],
  build: {
    outDir: "dist",
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
});
