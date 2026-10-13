import { structuredPatch } from "diff";
import type { GeneratedFileChange } from "../../src/navmap-test-generator";
import { baselineCaseId } from "../../src/navmap-cases";

export interface RegenerationFileDiff {
  file: string;
  status: "added" | "removed" | "modified";
  /** Unified-diff hunks: each line is prefixed with " ", "+" or "-". */
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
}

export interface RegenerationSummary {
  at: string;
  files: RegenerationFileDiff[];
  tests: { added: string[]; removed: string[]; modified: string[] };
}

// Each generated test block starts at column 0 with test(/test.fixme( and carries its case id as the
// first annotation on that same line (see caseDetails in src/navmap-test-generator.ts).
const CASE_HEAD_RE = /^test(?:\.fixme)?\(.*?annotation: \[\{ type: "case", description: ("(?:[^"\\]|\\.)*")/;
const ROW_RE = /\{ type: "row", description: ("(?:[^"\\]|\\.)*") \}/;
// Before test cases existed every test was one action, annotated with its edge id only.
const LEGACY_EDGE_HEAD_RE = /^test(?:\.fixme)?\(.*?annotation: \{ type: "edge", description: ("(?:[^"\\]|\\.)*")/;

/** caseId -> the test block's source, so a regeneration can say which tests changed, not just which
 *  files did. A pre-cases test counts as its action's baseline case. Relies on the generator's fixed
 *  layout: a block ends at the first column-0 "});". */
export function testBlocksByCase(source: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = CASE_HEAD_RE.exec(lines[i]);
    const legacy = m ? null : LEGACY_EDGE_HEAD_RE.exec(lines[i]);
    if (!m && !legacy) continue;
    const caseId = m ? (JSON.parse(m[1]) as string) : baselineCaseId(JSON.parse(legacy![1]) as string);
    // A case with a data table has one test per row: keyed "<caseId>#<row>".
    const row = ROW_RE.exec(lines[i]);
    const id = row ? `${caseId}#${JSON.parse(row[1]) as string}` : caseId;
    const end = lines.findIndex((l, j) => j > i && l.startsWith("});"));
    blocks.set(id, lines.slice(i, end < 0 ? undefined : end + 1).join("\n"));
  }
  return blocks;
}

export function summarizeRegeneration(changes: GeneratedFileChange[]): RegenerationSummary {
  const files: RegenerationFileDiff[] = changes.map((c) => {
    const patch = structuredPatch(c.file, c.file, c.before ?? "", c.after ?? "", "", "", { context: 3 });
    return {
      file: c.file,
      status: c.before === null ? "added" : c.after === null ? "removed" : "modified",
      hunks: patch.hunks.map((h) => ({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines })),
    };
  });

  const tests = { added: [] as string[], removed: [] as string[], modified: [] as string[] };
  for (const c of changes.filter((c) => c.file.endsWith(".spec.ts"))) {
    const before = testBlocksByCase(c.before ?? "");
    const after = testBlocksByCase(c.after ?? "");
    for (const [caseId, block] of after) {
      if (!before.has(caseId)) tests.added.push(caseId);
      else if (before.get(caseId) !== block) tests.modified.push(caseId);
    }
    for (const caseId of before.keys()) if (!after.has(caseId)) tests.removed.push(caseId);
  }
  return { at: new Date().toISOString(), files, tests };
}

export function regenerationHeadline(s: RegenerationSummary) {
  return {
    at: s.at,
    filesChanged: s.files.length,
    testsChanged: s.tests.added.length + s.tests.removed.length + s.tests.modified.length,
  };
}
