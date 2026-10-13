import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod/v4";
import { ActionStepSchema, STATE_ID_RE } from "./navmap-cases.js";
import { abs, projectPaths } from "./project-paths.js";

/** Questions for the human. Agents ask instead of guessing ("I need an account with an existing
 *  order"), and the planner's own open questions (a state nobody knows how to reach) are derived
 *  from the state graph, not stored. An answer is given once and reused by every test that needs
 *  it: it becomes part of the state graph (a flow, "already true", a user…) or, for free
 *  questions, project knowledge the agents read. Agents never answer. */

export const AnswerSchema = z.discriminatedUnion("kind", [
  /** Already true in a fresh session — no setup. */
  z.object({ kind: z.literal("initial") }),
  /** Reached by these map actions (a reusable flow). */
  z.object({
    kind: z.literal("flow"),
    steps: z.array(ActionStepSchema).min(1).max(20),
    stateKind: z.enum(["transient", "persistent"]).optional(),
    perItem: z.boolean().optional(),
  }),
  /** The same state as another one (merge them). */
  z.object({ kind: z.literal("sameAs"), stateId: z.string().regex(STATE_ID_RE), sameItem: z.boolean().optional() }),
  /** Run the test as this user. */
  z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
  /** Can't be automated — tests needing it stay fixme with this reason. */
  z.object({ kind: z.literal("notAutomatable"), reason: z.string().trim().min(1).max(500) }),
  /** A free-text answer (free questions only) — given to the agents as project knowledge. */
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(2000) }),
  /** Leave it as it is (the tests stay fixme) and stop asking. */
  z.object({ kind: z.literal("dismiss") }),
]);
export type Answer = z.infer<typeof AnswerSchema>;

export const QuestionAboutSchema = z.discriminatedUnion("kind", [
  /** issue: no_flow = nobody knows how to reach it; cant_run_here = its flow can't run on a page that needs it. */
  z.object({ kind: z.literal("state"), stateId: z.string().regex(STATE_ID_RE), issue: z.enum(["no_flow", "cant_run_here"]).optional() }),
  z.object({ kind: z.literal("free") }),
]);
export type QuestionAbout = z.infer<typeof QuestionAboutSchema>;

export const QuestionSchema = z.object({
  id: z.string().regex(/^q-[a-z0-9-]{1,80}$/),
  createdAt: z.string(),
  askedBy: z.enum(["linker", "designer", "planner", "analyst"]),
  about: QuestionAboutSchema,
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(2000).optional(),
  /** The agent's best guesses, offered as one-click answers. */
  suggestions: z.array(z.object({ label: z.string().trim().min(1).max(120), answer: AnswerSchema })).max(4).optional(),
  status: z.enum(["open", "answered", "dismissed"]),
  answer: AnswerSchema.optional(),
  answeredAt: z.string().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

const QuestionsFileSchema = z.object({ questions: z.array(QuestionSchema) });

/** What an agent stages: the script fills id/createdAt/status. */
export const AskInputSchema = QuestionSchema.pick({ about: true, title: true, detail: true, suggestions: true });
export type AskInput = z.infer<typeof AskInputSchema>;

export async function loadQuestions(rootDir: string, projectId: string): Promise<Question[]> {
  try {
    return QuestionsFileSchema.parse(JSON.parse(await readFile(abs(rootDir, projectPaths(projectId).questions), "utf-8"))).questions;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function saveQuestions(rootDir: string, projectId: string, questions: Question[]): Promise<void> {
  const file = abs(rootDir, projectPaths(projectId).questions);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(QuestionsFileSchema.parse({ questions }), null, 2) + "\n", "utf-8");
}

function subjectKey(about: QuestionAbout, title: string): string {
  return about.kind === "state" ? `state:${about.stateId}:${about.issue ?? "no_flow"}` : `free:${title.trim().toLowerCase()}`;
}

/** Adds questions, skipping any already asked about the same subject (open or answered) — an
 *  answer given once is never asked again. */
export function addQuestions(existing: Question[], incoming: AskInput[], askedBy: Question["askedBy"], now = new Date().toISOString()): { questions: Question[]; added: Question[]; skipped: string[] } {
  const taken = new Map(existing.map((q) => [subjectKey(q.about, q.title), q]));
  const added: Question[] = [];
  const skipped: string[] = [];
  for (const q of incoming) {
    const key = subjectKey(q.about, q.title);
    const prior = taken.get(key);
    if (prior && prior.status !== "dismissed") {
      skipped.push(`"${q.title}" — already ${prior.status === "open" ? "asked" : "answered"}`);
      continue;
    }
    const question: Question = {
      id: `q-${createHash("sha1").update(`${key}|${now}`).digest("hex").slice(0, 10)}`,
      createdAt: now,
      askedBy,
      about: q.about,
      title: q.title,
      ...(q.detail ? { detail: q.detail } : {}),
      ...(q.suggestions?.length ? { suggestions: q.suggestions } : {}),
      status: "open",
    };
    taken.set(key, question);
    added.push(question);
  }
  const keptOld = existing.filter((q) => !added.some((a) => subjectKey(a.about, a.title) === subjectKey(q.about, q.title)));
  return { questions: [...keptOld, ...added], added, skipped };
}

/** Free-text answers the agents get as project knowledge ("the test account with orders is …"). */
export function projectKnowledge(questions: Question[]): { question: string; answer: string }[] {
  return questions.flatMap((q) => (q.status === "answered" && q.answer?.kind === "text" ? [{ question: q.title, answer: q.answer.text }] : []));
}
