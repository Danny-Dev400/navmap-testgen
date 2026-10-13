import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { projectPaths } from "../src/project-paths.js";
import { loadStateGraph } from "../src/navmap-states.js";
import { addQuestions, AskInputSchema, loadQuestions, saveQuestions } from "../src/navmap-questions.js";

// Lets an agent ask the human instead of guessing — "I need an account with an existing order",
// "is 'X' already true in a fresh session?". Validates and appends the questions (one per subject:
// anything already asked or answered is skipped) to projects/<id>/questions.json; the dashboard
// shows them in the 🧩 States tab and the Home inbox. Agents never answer them.
const Staged = z.object({ askedBy: z.enum(["linker", "designer", "analyst"]), questions: z.array(AskInputSchema).min(1).max(10) });

const [projectId, file] = process.argv.slice(2);
if (!projectId || !file || !/^[a-z0-9-]{1,80}$/.test(projectId)) {
  console.error("Usage: npm run navmap:ask -- <projectId> <staged-questions.json>");
  process.exit(1);
}
const rootDir = process.cwd();
const parsed = Staged.safeParse(JSON.parse(await readFile(file, "utf-8")));
if (!parsed.success) {
  console.error(`Nothing asked — the staged questions don't match the schema:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}
const map = NavigationMapSchema.parse(JSON.parse(await readFile(path.join(rootDir, projectPaths(projectId).navmap), "utf-8")));
const graph = await loadStateGraph(rootDir, projectId, map);
const stateIds = new Set(graph.states.map((s) => s.id));
const errors: string[] = [];
for (const q of parsed.data.questions) {
  if (q.about.kind === "state" && !stateIds.has(q.about.stateId)) errors.push(`"${q.title}": no state "${q.about.stateId}" — save the state first (navmap:save-states), then ask about it`);
  for (const s of q.suggestions ?? []) {
    if (s.answer.kind === "sameAs" && !stateIds.has(s.answer.stateId)) errors.push(`"${q.title}": suggestion "${s.label}" points to an unknown state "${s.answer.stateId}"`);
    if (s.answer.kind === "flow") for (const st of s.answer.steps) if (!map.edges[st.edgeId]) errors.push(`"${q.title}": suggestion "${s.label}" uses an unknown action "${st.edgeId}"`);
    if (s.answer.kind === "text" || s.answer.kind === "dismiss") errors.push(`"${q.title}": a suggestion must be a concrete answer (a flow, already true, same as, a user, not automatable)`);
  }
}
if (errors.length) {
  console.error(`Nothing asked — fix these and run again:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  process.exit(1);
}
const { questions, added, skipped } = addQuestions(await loadQuestions(rootDir, projectId), parsed.data.questions, parsed.data.askedBy);
await saveQuestions(rootDir, projectId, questions);
console.log(`Asked ${added.length} question(s)${added.length ? `: ${added.map((q) => `"${q.title}"`).join(", ")}` : ""}.`);
if (skipped.length) console.log(`Skipped (already asked or answered): ${skipped.join("; ")}`);
console.log("The user answers them in the 🧩 States tab / Home inbox — never answer them yourself.");
