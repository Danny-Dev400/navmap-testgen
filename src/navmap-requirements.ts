import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { CASE_ID_RE } from "./navmap-cases.js";
import { ORG_ID_RE } from "./navmap-features.js";
import { abs, projectPaths } from "./project-paths.js";

/** Requirements: business stories ("As a shopper I want the cart total to add up…") split into
 *  acceptance criteria, each linked to the test cases that prove it — the traceability layer
 *  (requirement → criterion → cases → last result). The story text is kept as the user gave it; an
 *  agent may only *propose* criteria and links (requirements.proposed.json), which the user accepts.
 *  Tests of linked cases get one `@req-<id>` tag per requirement. */

export const CRITERION_ID_RE = /^ac-[0-9]{1,3}$/;

export const CriterionSchema = z.object({
  id: z.string().regex(CRITERION_ID_RE),
  text: z.string().trim().min(1).max(1000),
  /** The cases that prove it (any status — the matrix shows drafts as such). */
  caseIds: z.array(z.string().regex(CASE_ID_RE)).max(100),
});
export type Criterion = z.infer<typeof CriterionSchema>;

export const RequirementSchema = z.object({
  id: z.string().regex(ORG_ID_RE),
  /** An external id from where it came from ("SHOP-42"), shown before the title. */
  key: z.string().trim().min(1).max(40).optional(),
  title: z.string().trim().min(1).max(200),
  /** The story as the user pasted / imported it — never rewritten. */
  text: z.string().max(20000),
  /** The use case it's about (features → use cases), if any. */
  useCaseId: z.string().regex(ORG_ID_RE).optional(),
  criteria: z.array(CriterionSchema).max(50),
  source: z.enum(["pasted", "imported"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const RequirementsFileSchema = z.object({ requirements: z.array(RequirementSchema).max(300), updatedAt: z.string() });
export type RequirementsFile = z.infer<typeof RequirementsFileSchema>;
export const EMPTY_REQUIREMENTS: RequirementsFile = { requirements: [], updatedAt: "" };

/** What the analyst agent proposes for one requirement — the user accepts or discards it. */
export const AnalysisSchema = z.object({
  requirementId: z.string().regex(ORG_ID_RE),
  createdAt: z.string(),
  /** One or two sentences for the user: how it read the story. */
  summary: z.string().trim().max(1000).optional(),
  useCaseId: z.string().regex(ORG_ID_RE).optional(),
  criteria: z
    .array(
      z.object({
        /** An existing criterion it refines / links, or absent for a new one. */
        id: z.string().regex(CRITERION_ID_RE).optional(),
        text: z.string().trim().min(1).max(1000),
        caseIds: z.array(z.string().regex(CASE_ID_RE)).max(100).default([]),
        /** Why these cases prove it (or why none does). */
        why: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
export const AnalysesFileSchema = z.object({ analyses: z.array(AnalysisSchema).max(300) });

// ---- files ----

async function readJson<T>(file: string, schema: z.ZodType<T>, label: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return null;
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch (err) {
    console.warn(`[navmap-requirements] Ignoring invalid ${label}: ${(err as Error).message}`);
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

export async function loadRequirements(rootDir: string, projectId: string): Promise<RequirementsFile> {
  return (await readJson(abs(rootDir, projectPaths(projectId).requirements), RequirementsFileSchema, "requirements.json")) ?? EMPTY_REQUIREMENTS;
}

export async function saveRequirements(rootDir: string, projectId: string, requirements: Requirement[]): Promise<RequirementsFile> {
  const saved = RequirementsFileSchema.parse({ requirements, updatedAt: new Date().toISOString() });
  await writeJson(abs(rootDir, projectPaths(projectId).requirements), saved);
  return saved;
}

export async function loadAnalyses(rootDir: string, projectId: string): Promise<Analysis[]> {
  return (await readJson(abs(rootDir, projectPaths(projectId).requirementsProposal), AnalysesFileSchema, "requirements.proposed.json"))?.analyses ?? [];
}

export async function saveAnalyses(rootDir: string, projectId: string, analyses: Analysis[]): Promise<void> {
  await writeJson(abs(rootDir, projectPaths(projectId).requirementsProposal), AnalysesFileSchema.parse({ analyses }));
}

/** Drops links to cases that no longer exist. */
export function sanitizeRequirements(file: RequirementsFile, caseIds: Iterable<string>): RequirementsFile {
  const known = new Set(caseIds);
  return {
    ...file,
    requirements: file.requirements.map((r) => ({ ...r, criteria: r.criteria.map((c) => ({ ...c, caseIds: [...new Set(c.caseIds)].filter((id) => known.has(id)) })) })),
  };
}

/** caseId -> the requirements it proves (in order) — the generator's @req tags. */
export function caseRequirementIndex(file: Pick<RequirementsFile, "requirements"> | null | undefined): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const r of file?.requirements ?? []) {
    for (const id of new Set(r.criteria.flatMap((c) => c.caseIds))) index.set(id, [...(index.get(id) ?? []), r.id]);
  }
  return index;
}

export function requirementIdFor(title: string, key: string | undefined, taken: Iterable<string>): string {
  const base =
    (key ?? title)
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "") || "requirement";
  const used = new Set(taken);
  let id = /^[a-z0-9]/.test(base) ? base : `r-${base}`;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** ac-1, ac-2… — the next free criterion id. */
export function nextCriterionId(criteria: { id?: string }[]): string {
  const n = Math.max(0, ...criteria.map((c) => Number(/^ac-(\d+)$/.exec(c.id ?? "")?.[1] ?? 0)));
  return `ac-${n + 1}`;
}

// ---- parsing pasted / imported text (deterministic — no AI) ----

export interface ParsedRequirement {
  key?: string;
  title: string;
  text: string;
  criteria: string[];
}

const KEY_RE = /^\[?([A-Z][A-Z0-9]{1,15}-\d{1,7})\]?\s*[:\-–—]?\s*/;
const AC_HEADING_RE = /^(#{1,6}\s*)?(\*\*)?\s*(acceptance criteria|criterios de aceptaci[oó]n|criteria|ac)\s*:?\s*(\*\*)?\s*:?$/i;
const BULLET_RE = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/;
const SCENARIO_RE = /^\s*(?:Scenario(?: Outline)?|Escenario):\s*(.*)$/i;
const GHERKIN_STEP_RE = /^\s*(Given|When|Then|And|But|Dado|Cuando|Entonces|Y|Pero)\b/i;

function splitKey(title: string): { key?: string; title: string } {
  const m = KEY_RE.exec(title.trim());
  return m && m[0].length < title.trim().length ? { key: m[1], title: title.trim().slice(m[0].length).trim() } : { title: title.trim() };
}

/** One requirement per #/##/### heading (or the whole text when there's none). Criteria: the
 *  bullets / numbered lines after an "Acceptance criteria" line — or every bullet, numbered line and
 *  Gherkin scenario when there's no such line. Everything else is the story. */
export function parseRequirementsMarkdown(input: string): ParsedRequirement[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const sections: { heading: string | null; lines: string[] }[] = [];
  for (const line of lines) {
    const h = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h && !AC_HEADING_RE.test(line.trim())) sections.push({ heading: h[1], lines: [] });
    else if (sections.length === 0) sections.push({ heading: null, lines: [line] });
    else sections[sections.length - 1].lines.push(line);
  }
  const out: ParsedRequirement[] = [];
  for (const s of sections) {
    const body = s.lines;
    const acIndex = body.findIndex((l) => AC_HEADING_RE.test(l.trim()));
    const story: string[] = [];
    const criteria: string[] = [];
    let scenario: string[] | null = null;
    const flush = () => {
      if (scenario) criteria.push(scenario.join("\n").trim());
      scenario = null;
    };
    body.forEach((line, i) => {
      if (i === acIndex) return flush();
      const inCriteria = acIndex < 0 || i > acIndex;
      const sc = SCENARIO_RE.exec(line);
      if (inCriteria && sc) {
        flush();
        scenario = [sc[1].trim() || "Scenario"];
        return;
      }
      if (scenario && GHERKIN_STEP_RE.test(line)) return scenario.push(line.trim());
      flush();
      const b = BULLET_RE.exec(line);
      if (inCriteria && b && b[1].trim()) criteria.push(b[1].trim());
      else if (line.trim()) story.push(line.trim());
    });
    flush();
    let heading = s.heading;
    if (!heading) {
      const first = story.shift() ?? criteria[0];
      if (!first) continue;
      heading = first.replace(/^#+\s*/, "");
    }
    const { key, title } = splitKey(heading);
    out.push({ ...(key ? { key } : {}), title: title.slice(0, 200), text: story.join("\n"), criteria: criteria.map((c) => c.slice(0, 1000)).slice(0, 50) });
  }
  return out.filter((r) => r.title);
}

/** RFC 4180 rows (quoted fields, "" escapes, line breaks inside quotes); , or ; separated. */
function parseCsvRows(text: string): string[][] {
  const sep = (text.split("\n")[0].match(/;/g)?.length ?? 0) > (text.split("\n")[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Columns (any order, header names case-insensitive): key/id/issue key, title/summary/name,
 *  story/description/text, criteria/acceptance criteria/ac (one criterion per line). */
export function parseRequirementsCsv(input: string): ParsedRequirement[] | { error: string } {
  const rows = parseCsvRows(input.replace(/^\uFEFF/, ""));
  if (rows.length < 2) return { error: "The CSV needs a header row and at least one requirement" };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iKey = col("key", "id", "issue key", "issue id");
  const iTitle = col("title", "summary", "name", "requirement");
  const iStory = col("story", "description", "text", "user story");
  const iCriteria = col("criteria", "acceptance criteria", "ac", "acceptance");
  if (iTitle < 0) return { error: 'The CSV needs a "title" (or "summary") column' };
  const out: ParsedRequirement[] = [];
  for (const r of rows.slice(1)) {
    const title = (r[iTitle] ?? "").trim();
    if (!title) continue;
    const criteria = (iCriteria >= 0 ? (r[iCriteria] ?? "") : "")
      .split("\n")
      .map((l) => (BULLET_RE.exec(l)?.[1] ?? l).trim())
      .filter(Boolean);
    const key = iKey >= 0 ? (r[iKey] ?? "").trim() : "";
    out.push({ ...(key ? { key: key.slice(0, 40) } : {}), title: title.slice(0, 200), text: iStory >= 0 ? (r[iStory] ?? "").trim() : "", criteria: criteria.slice(0, 50) });
  }
  return out.length ? out : { error: "No rows with a title" };
}

/** New requirements from parsed ones, with ids that don't clash with `existing`. */
export function toRequirements(parsed: ParsedRequirement[], existing: Requirement[], source: Requirement["source"], now = new Date().toISOString()): Requirement[] {
  const taken = existing.map((r) => r.id);
  return parsed.map((p) => {
    const id = requirementIdFor(p.title, p.key, taken);
    taken.push(id);
    return {
      id,
      ...(p.key ? { key: p.key } : {}),
      title: p.title,
      text: p.text,
      criteria: p.criteria.map((text, i) => ({ id: `ac-${i + 1}`, text, caseIds: [] })),
      source,
      createdAt: now,
      updatedAt: now,
    };
  });
}

// ---- coverage ----

export type CriterionStatus = "uncovered" | "draft" | "fixme" | "not_run" | "failing" | "passing";
/** Worst first — a requirement shows its worst criterion. */
export const STATUS_ORDER: CriterionStatus[] = ["failing", "uncovered", "draft", "fixme", "not_run", "passing"];

export interface CaseFacts {
  status: "draft" | "approved" | "rejected";
  runnable: boolean;
  /** Last run result, when it ran. */
  last?: string;
}

/** Where a criterion stands from its linked cases: failing if any approved one failed; passing when
 *  the approved, runnable ones all passed; otherwise not run / fixme / only drafts / nothing. */
export function criterionStatus(caseIds: string[], facts: (id: string) => CaseFacts | undefined): CriterionStatus {
  const linked = caseIds.map(facts).filter((f): f is CaseFacts => !!f && f.status !== "rejected");
  if (linked.length === 0) return "uncovered";
  const approved = linked.filter((f) => f.status === "approved");
  if (approved.length === 0) return "draft";
  if (approved.some((f) => f.last === "failed" || f.last === "flaky")) return "failing";
  const runnable = approved.filter((f) => f.runnable);
  if (runnable.length === 0) return "fixme";
  return runnable.every((f) => f.last === "passed") ? "passing" : "not_run";
}

export function worstStatus(statuses: CriterionStatus[]): CriterionStatus {
  for (const s of STATUS_ORDER) if (statuses.includes(s)) return s;
  return "uncovered";
}
