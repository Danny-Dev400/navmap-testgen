import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { abs, projectPaths } from "../../src/project-paths";
import { testBlocksByCase } from "./regenerationDiff";

export interface LocatedTest {
  /** Repo-relative POSIX path of the spec file. */
  file: string;
  /** 1-based line of the test's opening line — what `playwright test file:line` expects. */
  line: number;
  code: string;
}

/** Finds the generated test for a case via its annotation (see caseDetails in
 *  src/navmap-test-generator.ts). undefined when the case has no generated test (not approved yet). */
export async function locateTest(repoRoot: string, projectId: string, caseId: string): Promise<LocatedTest | undefined> {
  const all = await locateTests(repoRoot, projectId, caseId);
  if (all.length <= 1) return all[0];
  // A data-table case: one test per row — show them all, run them all (see locateTests).
  return { file: all[0].file, line: all[0].line, code: all.map((t) => t.code).join("\n\n") };
}

/** Every generated test of a case — one, or one per data row ("<caseId>#<row>"). */
export async function locateTests(repoRoot: string, projectId: string, caseId: string): Promise<LocatedTest[]> {
  const testsDir = projectPaths(projectId).tests;
  const specs = (await readdir(abs(repoRoot, testsDir)).catch(() => [] as string[])).filter((f) => f.endsWith(".spec.ts"));
  for (const spec of specs) {
    const file = path.posix.join(testsDir, spec);
    const source = await readFile(abs(repoRoot, file), "utf-8");
    const found = [...testBlocksByCase(source)].filter(([key]) => key === caseId || key.startsWith(`${caseId}#`));
    if (found.length === 0) continue;
    return found.map(([, code]) => ({ file, line: source.slice(0, source.indexOf(code)).split("\n").length, code }));
  }
  return [];
}

export interface PomMethod {
  file: string;
  className: string;
  name: string;
  code: string;
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A class member's source, from its declaration line to its closing "  }" — the generator's fixed
 *  two-space layout (src/navmap-pom-generator.ts). */
function extractMember(source: string, name: string): string | undefined {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^  (async )?${name}\\(`).test(l));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && l === "  }");
  return lines.slice(start, end < 0 ? undefined : end + 1).join("\n");
}

/** The page-object/component methods a test block calls, in call order, deduped:
 *  `await somePage.method(` and `await somePage.component.method(`. Page variables follow the
 *  generator's naming (instance var = class name with a lower-case first letter). */
export async function pomMethodsForTest(repoRoot: string, projectId: string, block: string): Promise<PomMethod[]> {
  const testsDir = projectPaths(projectId).tests;
  const read = (rel: string) => readFile(abs(repoRoot, path.posix.join(testsDir, rel)), "utf-8").catch(() => undefined);
  const out: PomMethod[] = [];
  const seen = new Set<string>();
  for (const m of block.matchAll(/await (\w+)\.(?:(\w+)\.)?(\w+)\(/g)) {
    const [, pageVar, componentField, method] = m;
    if (method === "goto" && !componentField) continue; // every test has one; not informative
    const pageClass = upperFirst(pageVar);
    const pageSource = await read(`pages/${pageClass}.ts`);
    if (!pageSource) continue;
    let className = pageClass;
    let file = `pages/${pageClass}.ts`;
    let source = pageSource;
    if (componentField) {
      const decl = new RegExp(`readonly ${componentField}: (\\w+);`).exec(pageSource);
      if (!decl) continue;
      className = decl[1];
      file = `components/${className}.ts`;
      const componentSource = await read(file);
      if (!componentSource) continue;
      source = componentSource;
    }
    const key = `${className}.${method}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const code = extractMember(source, method);
    if (code) out.push({ file: path.posix.join(testsDir, file), className, name: method, code });
  }
  return out;
}
