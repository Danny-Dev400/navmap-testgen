// Project deep links: #/project/<id>/<tab>?case=<caseId>&run=<runId>&filter=<filter>
// Tabs live in the URL so the back button works and the inbox / "next step" can open a specific
// case or run from anywhere.

export type Tab = "home" | "map" | "cases" | "requirements" | "states" | "runs" | "users" | "settings";
export const TAB_IDS: Tab[] = ["home", "map", "cases", "requirements", "states", "runs", "users", "settings"];

export interface ProjectRoute {
  id: string;
  tab: Tab;
  params: Record<string, string>;
}

export function parseProjectRoute(hash: string): ProjectRoute | null {
  const m = /^#\/project\/([^/?]+)(?:\/([a-z]+))?\/?(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const tab = TAB_IDS.includes(m[2] as Tab) ? (m[2] as Tab) : "home";
  return { id: decodeURIComponent(m[1]), tab, params: Object.fromEntries(new URLSearchParams(m[3] ?? "")) };
}

export function projectHref(id: string, tab: Tab, params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return `#/project/${encodeURIComponent(id)}/${tab}${q ? `?${q}` : ""}`;
}

export function navigate(id: string, tab: Tab, params: Record<string, string | undefined> = {}) {
  window.location.hash = projectHref(id, tab, params);
}

/** Drops a one-shot param (e.g. ?case= after its modal opened) without adding a history entry. */
export function clearParams(id: string, tab: Tab) {
  history.replaceState(null, "", projectHref(id, tab));
}
