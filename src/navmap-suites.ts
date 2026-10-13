import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { CASE_ID_RE } from "./navmap-cases.js";
import { ORG_ID_RE } from "./navmap-features.js";
import { abs, projectPaths } from "./project-paths.js";

/** Suites: named sets of test cases picked by hand and run together ("Smoke", "Checkout
 *  regression"), across features and pages. A case can be in several suites; its generated test
 *  gets one `@suite-<id>` tag per suite (so `--grep @suite-smoke` works outside the dashboard).
 *  A suite lists cases of any status — only its approved ones have tests to run. */

export const SuiteSchema = z.object({
  id: z.string().regex(ORG_ID_RE),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  caseIds: z.array(z.string().regex(CASE_ID_RE)).max(500),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Suite = z.infer<typeof SuiteSchema>;

export const SuitesFileSchema = z.object({ suites: z.array(SuiteSchema).max(100), updatedAt: z.string() });
export type SuitesFile = z.infer<typeof SuitesFileSchema>;

export const EMPTY_SUITES: SuitesFile = { suites: [], updatedAt: "" };

export async function loadSuites(rootDir: string, projectId: string): Promise<SuitesFile> {
  let raw: string;
  try {
    raw = await readFile(abs(rootDir, projectPaths(projectId).suites), "utf-8");
  } catch {
    return EMPTY_SUITES;
  }
  try {
    return SuitesFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.warn(`[navmap-suites] Ignoring invalid suites.json: ${(err as Error).message}`);
    return EMPTY_SUITES;
  }
}

export async function saveSuites(rootDir: string, projectId: string, suites: Suite[]): Promise<SuitesFile> {
  const saved = SuitesFileSchema.parse({ suites, updatedAt: new Date().toISOString() });
  const file = abs(rootDir, projectPaths(projectId).suites);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(saved, null, 2) + "\n", "utf-8");
  return saved;
}

/** Drops case ids that no longer exist (deleted cases) and repeats, keeping each suite's order. */
export function sanitizeSuites(file: SuitesFile, caseIds: Iterable<string>): SuitesFile {
  const known = new Set(caseIds);
  return { ...file, suites: file.suites.map((s) => ({ ...s, caseIds: [...new Set(s.caseIds)].filter((id) => known.has(id)) })) };
}

/** caseId -> the ids of the suites it's in (in suite order) — the generator's @suite tags. */
export function caseSuiteIndex(file: Pick<SuitesFile, "suites"> | null | undefined): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const s of file?.suites ?? []) {
    for (const id of s.caseIds) index.set(id, [...(index.get(id) ?? []), s.id]);
  }
  return index;
}

/** A new suite's id from its name ("Checkout regression" -> "checkout-regression"), unique. */
export function suiteIdFor(name: string, taken: Iterable<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "") || "suite";
  const used = new Set(taken);
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}
