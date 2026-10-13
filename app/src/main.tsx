import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { NavMapApp } from "./NavMapApp";
import { DashboardApp } from "./DashboardApp";
import type { ExplorationRun } from "../../src/types";
import type { NavigationMap } from "../../src/navmap-types";
import "./ui/tokens.css";
import "./styles.css";
import "./ui/kit.css";
import "./ui/screens.css";
import "./ui/map.css";
import { initTheme } from "./ui/theme";

initTheme();

type AppData = { kind: "explorationRun"; run: ExplorationRun } | { kind: "navigationMap"; map: NavigationMap };

function loadAppData(): AppData | null {
  const el = document.getElementById("app-data");
  const raw = el?.textContent ?? "";
  try {
    return JSON.parse(raw) as AppData;
  } catch {
    return null;
  }
}

const data = loadAppData();

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    {data === null ? (
      <DashboardApp />
    ) : data.kind === "navigationMap" ? (
      <NavMapApp map={data.map} />
    ) : (
      <App run={data.run} />
    )}
  </StrictMode>,
);
