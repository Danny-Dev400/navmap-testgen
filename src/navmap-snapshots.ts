import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { abs, projectPaths } from "./project-paths.js";
import { scrub } from "./navmap-secrets.js";

/** Accessibility snapshots: one per page, beside the map (projects/<id>/snapshots/<pageId>.yml),
 *  in the YAML format Playwright's browser_snapshot / ariaSnapshot() produce. They list every
 *  element with its role, name and text, so a later agent can find something the map never
 *  recorded (a price, a total, an error message) without opening a browser. Observations, not map
 *  facts: gitignored, overwritten on every capture, "captured at" = the file's mtime. */

const PAGE_ID_RE = /^[a-z0-9_-]{1,200}$/;

export function snapshotPathFor(projectId: string, pageId: string): string {
  if (!PAGE_ID_RE.test(pageId)) throw new Error(`Invalid page id "${pageId}"`);
  return path.posix.join(projectPaths(projectId).snapshots, `${pageId}.yml`);
}

/** Strips what only means something inside a live browser session — element refs, cursor and
 *  focus markers — so the stored text is stable and cheaper to put in a prompt. */
export function normalizeSnapshot(text: string): string {
  return text
    .replace(/ \[ref=[a-z0-9]+\]/gi, "")
    .replace(/ \[cursor=pointer\]/g, "")
    .replace(/ \[active\]/g, "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

export async function readPageSnapshot(rootDir: string, projectId: string, pageId: string): Promise<{ text: string; capturedAt: string } | null> {
  const file = abs(rootDir, snapshotPathFor(projectId, pageId));
  try {
    const [raw, info] = await Promise.all([readFile(file, "utf-8"), stat(file)]);
    return { text: normalizeSnapshot(raw), capturedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** pageId -> capturedAt, for every page with a snapshot. */
export async function listPageSnapshots(rootDir: string, projectId: string): Promise<Record<string, string>> {
  const dir = abs(rootDir, projectPaths(projectId).snapshots);
  const out: Record<string, string> = {};
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".yml")) continue;
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (info) out[name.slice(0, -4)] = info.mtime.toISOString();
  }
  return out;
}

/** Defense in depth: an aria snapshot shows a textbox's current value, so one taken after typing a
 *  password would contain it. Rewrites only files that actually contained a secret (keeps mtimes). */
export async function scrubSnapshots(rootDir: string, projectId: string, secrets: string[]): Promise<number> {
  if (secrets.length === 0) return 0;
  const dir = abs(rootDir, projectPaths(projectId).snapshots);
  let scrubbed = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".yml")) continue;
    const file = path.join(dir, name);
    const raw = await readFile(file, "utf-8").catch(() => null);
    if (raw === null) continue;
    const clean = scrub(raw, secrets);
    if (clean !== raw) {
      await writeFile(file, clean, "utf-8");
      scrubbed++;
    }
  }
  return scrubbed;
}
