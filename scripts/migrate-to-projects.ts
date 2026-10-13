import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { credentialsPathFor, projectPaths, storageStatePathFor } from "../src/project-paths.js";

// One-off: moves the old per-type layout (navmaps/, screenshots/navmap/, generated-tests/<id>/.auth,
// credentials/) into one folder per project, projects/<id>/, rewriting the paths stored inside the
// data. Reports and generated tests are not moved — they embed old paths; regenerate them after.
//   npm run migrate:projects -- --dry-run
const dryRun = process.argv.includes("--dry-run");
const root = process.cwd();
const actions: string[] = [];
const leftovers: string[] = [];

const p = (rel: string) => path.join(root, rel);
const posix = (rel: string) => rel.split(path.sep).join("/");

function move(fromRel: string, toRel: string) {
  actions.push(`move  ${fromRel} -> ${toRel}`);
  if (dryRun) return;
  mkdirSync(path.dirname(p(toRel)), { recursive: true });
  renameSync(p(fromRel), p(toRel));
}

function writeJson(toRel: string, data: unknown, note: string) {
  actions.push(`write ${toRel} (${note})`);
  if (dryRun) return;
  mkdirSync(path.dirname(p(toRel)), { recursive: true });
  writeFileSync(p(toRel), JSON.stringify(data, null, 2), "utf-8");
}

const readJson = (rel: string) => JSON.parse(readFileSync(p(rel), "utf-8"));

const mapFiles = existsSync(p("navmaps")) ? readdirSync(p("navmaps")).filter((f) => f.endsWith(".json")) : [];
const ids = mapFiles.map((f) => f.replace(/\.json$/, ""));

for (const id of ids) {
  if (existsSync(p(projectPaths(id).navmap))) {
    console.error(`${projectPaths(id).navmap} already exists — refusing to migrate twice. Nothing was changed.`);
    process.exit(1);
  }
}

// Credentials referenced by any project: old path -> new path. Files nobody references stay put.
const credentialMoves = new Map<string, string>();
function newCredentialsRef(id: string, oldRef: string | undefined, userId: string | undefined): string | undefined {
  if (!oldRef || !oldRef.startsWith("credentials/")) return oldRef;
  const already = credentialMoves.get(oldRef);
  if (already) return already;
  const base = path.posix.basename(oldRef, ".json");
  // UI-managed files were credentials/<projectId>-<userId>.json; they become <userId>.json, which is
  // exactly credentialsPathFor() — so the Users tab still recognizes them as managed by the UI.
  const target = userId && base === `${id}-${userId}` ? credentialsPathFor(id, userId) : path.posix.join(projectPaths(id).credentials, `${base}.json`);
  credentialMoves.set(oldRef, target);
  return target;
}

const oldShotPrefix = (id: string) => `screenshots/navmap/${id}/`;
const rewriteShot = (id: string, ref: string | undefined) =>
  ref?.startsWith(oldShotPrefix(id)) ? `${projectPaths(id).screenshots}/${ref.slice(oldShotPrefix(id).length)}` : ref;

for (const id of ids) {
  const paths = projectPaths(id);

  // Map: screenshot refs + credentialsRef.
  const map = readJson(`navmaps/${id}.json`);
  let shots = 0;
  for (const edge of Object.values<any>(map.edges ?? {})) {
    for (const key of ["screenshot", "screenshotBefore"]) {
      const next = rewriteShot(id, edge[key]);
      if (next !== edge[key]) shots++;
      if (next !== undefined) edge[key] = next;
    }
  }
  for (const page of Object.values<any>(map.pages ?? {})) {
    if (page.screenshot) page.screenshot = rewriteShot(id, page.screenshot);
  }
  // The map's credentialsRef is the derived "default" user's — so it maps like a UI file of user "default".
  map.credentialsRef = newCredentialsRef(id, map.credentialsRef, "default");
  writeJson(paths.navmap, map, `${shots} screenshot refs rewritten`);

  // Users (credentialsRef per user).
  if (existsSync(p(`navmaps/users/${id}.json`))) {
    const users = readJson(`navmaps/users/${id}.json`);
    for (const u of users.users ?? []) u.credentialsRef = newCredentialsRef(id, u.credentialsRef, u.id);
    writeJson(paths.users, users, "credentialsRef rewritten");
  }
  for (const [from, to] of [
    [`navmaps/settings/${id}.json`, paths.settings],
    [`navmaps/precondition-links/${id}.json`, paths.links],
  ]) {
    if (existsSync(p(from))) move(from, to);
  }

  // Screenshots.
  const shotDir = `screenshots/navmap/${id}`;
  if (existsSync(p(shotDir))) {
    const files = readdirSync(p(shotDir));
    actions.push(`move  ${shotDir}/* (${files.length} files) -> ${paths.screenshots}/`);
    if (!dryRun) {
      mkdirSync(p(paths.screenshots), { recursive: true });
      for (const f of files) renameSync(p(`${shotDir}/${f}`), p(`${paths.screenshots}/${f}`));
    }
  }

  // Saved sessions.
  const authDir = `generated-tests/${id}/.auth`;
  if (existsSync(p(authDir))) {
    for (const f of readdirSync(p(authDir))) move(`${authDir}/${f}`, storageStatePathFor(id, f.replace(/\.json$/, "")));
  }
}

for (const [from, to] of credentialMoves) {
  if (existsSync(p(from))) move(from, to);
  else leftovers.push(`referenced credentials file missing: ${from} (ref rewritten to ${to})`);
}

// The old map/users files go last, once their rewritten copies are written (take a backup first).
for (const id of ids) {
  for (const old of [`navmaps/${id}.json`, `navmaps/users/${id}.json`]) {
    if (!existsSync(p(old))) continue;
    actions.push(`remove ${old} (rewritten copy written above)`);
    if (!dryRun) rmSync(p(old));
  }
}

console.log(`${dryRun ? "[dry run] " : ""}${ids.length} project(s): ${ids.join(", ")}`);
for (const a of actions) console.log(`  ${a}`);

// Report (never delete) whatever is left in the old locations.
if (!dryRun) {
  const removeIfEmpty = (rel: string) => {
    if (!existsSync(p(rel))) return;
    for (const child of readdirSync(p(rel), { withFileTypes: true })) {
      if (child.isDirectory()) removeIfEmpty(posix(path.join(rel, child.name)));
    }
    if (readdirSync(p(rel)).length === 0) rmdirSync(p(rel));
    else leftovers.push(`${rel}/ still has: ${readdirSync(p(rel)).join(", ")}`);
  };
  for (const dir of ["navmaps", "screenshots", "credentials", "results"]) removeIfEmpty(dir);
}
if (leftovers.length > 0) {
  console.log("\nLeft in place (not deleted):");
  for (const l of leftovers) console.log(`  - ${l}`);
}
console.log(`\nNext: regenerate reports and tests — reports/ and generated-tests/ still hold the old copies.`);
