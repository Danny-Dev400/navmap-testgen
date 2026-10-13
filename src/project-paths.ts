import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** Everything a project produces lives under projects/<id>/ — delete that folder and the project
 *  is gone (map, users, settings, links, screenshots, reports, tests, sessions, credentials).
 *  The id is the host slug (`www-saucedemo-com`), the same id the dashboard URLs and API use. */
export const PROJECTS_DIR = "projects";

export const PROJECT_ID_RE = /^[a-z0-9-]{1,80}$/;

/** Repo-relative POSIX paths: these get stored inside data (screenshot refs, credentialsRef), so
 *  they must not depend on the OS or on where the repo is checked out. */
export function projectPaths(id: string) {
  const dir = path.posix.join(PROJECTS_DIR, id);
  const reports = path.posix.join(dir, "reports");
  return {
    dir,
    /** Committed — the persistent map. */
    navmap: path.posix.join(dir, "navmap.json"),
    /** Committed — test users (paths into credentials/, never secrets). */
    users: path.posix.join(dir, "users.json"),
    /** Committed — execution + agent settings. */
    settings: path.posix.join(dir, "settings.json"),
    /** Committed — precondition links. */
    links: path.posix.join(dir, "precondition-links.json"),
    /** Committed — named states, their reusable flows, and which preconditions point to them (navmap-states.ts). */
    states: path.posix.join(dir, "states.json"),
    /** Committed — questions agents asked the human, and the answers (navmap-questions.ts). */
    questions: path.posix.join(dir, "questions.json"),
    /** Committed — test cases, one JSON file per case (the test-design layer). */
    cases: path.posix.join(dir, "cases"),
    /** Committed — features → use cases → cases (how cases are organized; see navmap-features.ts). */
    features: path.posix.join(dir, "features.json"),
    /** The organizer agent's pending proposal, until the user accepts or discards it. */
    featuresProposal: path.posix.join(dir, "features.proposed.json"),
    /** Committed — named sets of cases run together ("Smoke"), tagged @suite-<id> (navmap-suites.ts). */
    suites: path.posix.join(dir, "suites.json"),
    /** Committed — requirements → acceptance criteria → the cases proving them (navmap-requirements.ts). */
    requirements: path.posix.join(dir, "requirements.json"),
    /** The analyst agent's pending proposals, one per requirement, until the user accepts or discards them. */
    requirementsProposal: path.posix.join(dir, "requirements.proposed.json"),
    screenshots: path.posix.join(dir, "screenshots"),
    /** Accessibility snapshot per page (<pageId>.yml) — gitignored observations, see navmap-snapshots.ts. */
    snapshots: path.posix.join(dir, "snapshots"),
    reports,
    navmapReport: path.posix.join(reports, "navmap.html"),
    coverageReport: path.posix.join(reports, "coverage.html"),
    /** Generated Playwright code — fully disposable, wiped on every regeneration. */
    tests: path.posix.join(dir, "tests"),
    testResults: path.posix.join(dir, "test-results"),
    /** Saved sessions (storageState) — bearer secrets, gitignored, denied to agents. */
    auth: path.posix.join(dir, ".auth"),
    /** Credential files — gitignored, denied to agents. */
    credentials: path.posix.join(dir, "credentials"),
    /** Agent scratch (run batches, link judgments, per-run credential copies). */
    staging: path.posix.join(dir, ".staging"),
    /** /explore run traces and their screenshots. */
    explore: path.posix.join(dir, "explore"),
    /** Committed — the user's per-edge overrides (e.g. destructive). */
    edgeFlags: path.posix.join(dir, "edge-flags.json"),
    /** Triage verdicts and fix proposals for failed tests (local, gitignored). */
    triage: path.posix.join(dir, "triage"),
    /** Test runs started from the dashboard: one folder per run (summary + artifacts). */
    runs: path.posix.join(dir, "runs"),
    /** Local accounting of agent runs' estimated cost (no prompts, no output). */
    agentUsage: path.posix.join(dir, "agent-usage.jsonl"),
    /** What the last test regeneration changed (unified diffs). */
    lastRegeneration: path.posix.join(reports, "last-regeneration.json"),
  };
}

export function abs(rootDir: string, repoRelative: string): string {
  return path.join(rootDir, repoRelative);
}

export function credentialsPathFor(projectId: string, userId: string): string {
  return path.posix.join(projectPaths(projectId).credentials, `${userId}.json`);
}

export function storageStatePathFor(projectId: string, userId: string): string {
  return path.posix.join(projectPaths(projectId).auth, `${userId}.json`);
}

/** Folders under projects/ that hold a map — a folder without navmap.json isn't a project. */
export function listProjectIds(rootDir: string): string[] {
  const root = path.join(rootDir, PROJECTS_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && PROJECT_ID_RE.test(d.name) && existsSync(path.join(root, d.name, "navmap.json")))
    .map((d) => d.name)
    .sort();
}

/** CLI scripts accept either a project id (`www-saucedemo-com`) or a path to a map JSON. */
export function resolveMapArg(arg: string): string {
  return arg.endsWith(".json") ? arg : projectPaths(arg).navmap;
}
