import type { Plugin } from "vite";
import { z } from "zod/v4";
import type { NavigationMap } from "../../src/navmap-types";
import { loadCases, saveCase } from "../../src/navmap-cases";
import { loadProjectUsers } from "../../src/navmap-users";
import { loadEdgeFlags } from "../../src/navmap-edge-flags";
import { applyAnswer, BindingSchema, loadStateGraph, saveStateGraph, StateSchema, validateStateGraph, type StateGraph } from "../../src/navmap-states";
import { AnswerSchema, loadQuestions, saveQuestions, type Question } from "../../src/navmap-questions";
import { buildGraphView } from "../../src/navmap-states-view";
import { loadMap, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";
import { regenerateProject } from "./regenerate";

// /api/projects/<id>/states[/answer | /binding] — everything else falls through.
const STATES_RE = /^\/([a-z0-9-]{1,80})\/states(?:\/(answer|binding))?\/?$/;

const PutBody = z.object({
  states: z.array(StateSchema),
  bindings: z.array(BindingSchema),
  /** The updatedAt the editor started from (null when the graph wasn't saved yet). */
  baseUpdatedAt: z.string().nullable(),
});
const AnswerBody = z
  .object({ stateId: z.string().optional(), questionId: z.string().optional(), answer: AnswerSchema })
  .refine((b) => b.stateId || b.questionId, { message: "stateId or questionId is required" });
const BindingBody = z.object({
  edgeId: z.string().min(1),
  precondition: z.string().min(1),
  /** null unbinds the precondition. */
  stateId: z.string().nullable(),
  sameItem: z.boolean().optional(),
});

/** The state graph as the 🧩 States tab, the case modal and the agents read it. The first read
 *  saves the in-memory conversion from precondition links as states.json (precondition-links.json
 *  stays as it was, as a backup), so from then on edits and answers have a file to land in. */
export async function loadPersistedGraph(repoRoot: string, map: NavigationMap): Promise<StateGraph> {
  const graph = await loadStateGraph(repoRoot, map.id, map);
  if (graph.derivedFromLinks && graph.states.length > 0) return saveStateGraph(repoRoot, map.id, graph);
  return graph;
}

export async function statesResponse(repoRoot: string, map: NavigationMap, extra: Record<string, unknown> = {}) {
  const [users, graph, cases, questions, flags] = await Promise.all([
    loadProjectUsers(repoRoot, map),
    loadPersistedGraph(repoRoot, map),
    loadCases(repoRoot, map.id),
    loadQuestions(repoRoot, map.id),
    loadEdgeFlags(repoRoot, map.id),
  ]);
  return { ...buildGraphView(map, users, graph, cases, questions, flags), graph: { states: graph.states, bindings: graph.bindings }, ...extra };
}

export function navmapStatesApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  async function saveAndRespond(res: Parameters<typeof sendJson>[0], map: NavigationMap, graph: StateGraph) {
    await saveStateGraph(repoRoot, map.id, graph);
    const regenerated = await regenerateProject(repoRoot, map.id);
    return sendJson(res, 200, await statesResponse(repoRoot, map, { regeneration: regenerated?.regeneration ?? null }));
  }

  return {
    name: "navmap-states-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const match = STATES_RE.exec((req.url ?? "/").split("?")[0]);
        if (!match) return next();
        const [, projectId, sub] = match;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });

        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });

          if (!sub && req.method === "GET") return sendJson(res, 200, await statesResponse(repoRoot, map));

          // The whole graph as edited in the UI (states, their flows, bindings).
          if (!sub && req.method === "PUT") {
            const parsed = PutBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid state graph", details: z.prettifyError(parsed.error) });
            const current = await loadPersistedGraph(repoRoot, map);
            if ((current.updatedAt ?? null) !== parsed.data.baseUpdatedAt) {
              return sendJson(res, 409, { error: "The states changed meanwhile (another tab or an agent) — reload and try again" });
            }
            const graph: StateGraph = { states: parsed.data.states, bindings: parsed.data.bindings };
            const errors = validateStateGraph(graph, map, await loadProjectUsers(repoRoot, map));
            if (errors.length) return sendJson(res, 400, { error: errors[0], details: errors.join("\n") });
            return saveAndRespond(res, map, graph);
          }

          // The human's answer to a question: becomes part of the graph (or project knowledge).
          if (sub === "answer" && req.method === "POST") {
            const parsed = AnswerBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid answer", details: z.prettifyError(parsed.error) });
            const { answer } = parsed.data;
            const [graph, cases, users] = await Promise.all([loadPersistedGraph(repoRoot, map), loadCases(repoRoot, projectId), loadProjectUsers(repoRoot, map)]);
            let questions = await loadQuestions(repoRoot, projectId);
            const stored = parsed.data.questionId ? questions.find((q) => q.id === parsed.data.questionId) : undefined;
            if (parsed.data.questionId && !stored) return sendJson(res, 404, { error: "Unknown question" });
            const stateId = parsed.data.stateId ?? (stored?.about.kind === "state" ? stored.about.stateId : undefined);
            const now = new Date().toISOString();

            let next = graph;
            if (stateId && answer.kind !== "dismiss" && answer.kind !== "text") {
              if (answer.kind === "user" && !users.some((u) => u.id === answer.userId)) return sendJson(res, 400, { error: "Unknown user" });
              const applied = applyAnswer(graph, map, cases, stateId, answer, now);
              if (applied.error) return sendJson(res, 400, { error: applied.error });
              const errors = validateStateGraph(applied.graph, map, users);
              if (errors.length) return sendJson(res, 400, { error: errors[0], details: errors.join("\n") });
              next = applied.graph;
              for (const c of applied.changedCases) await saveCase(repoRoot, projectId, c);
            } else if (!stored && answer.kind === "text") {
              return sendJson(res, 400, { error: "A free-text answer goes to a question" });
            }

            // Close what this answers: the stored question, and any open one about the same state. A
            // dismissal of a derived question is remembered so it isn't asked again.
            const closes = (q: Question) => q.status === "open" && (q.id === stored?.id || (stateId !== undefined && q.about.kind === "state" && q.about.stateId === stateId));
            questions = questions.map((q) => (closes(q) ? { ...q, status: answer.kind === "dismiss" ? ("dismissed" as const) : ("answered" as const), answer, answeredAt: now } : q));
            if (answer.kind === "dismiss" && !stored && stateId) {
              const issue = graph.states.find((s) => s.id === stateId)?.flow?.length ? "cant_run_here" : "no_flow";
              questions.push({
                id: `q-dismissed-${stateId}-${issue.replace(/_/g, "-")}`.slice(0, 82),
                createdAt: now,
                askedBy: "planner",
                about: { kind: "state", stateId, issue },
                title: `Dismissed: ${stateId}`,
                status: "dismissed",
                answer,
                answeredAt: now,
              });
            }
            await saveQuestions(repoRoot, projectId, questions);
            if (next === graph) {
              const regenerated = await regenerateProject(repoRoot, projectId);
              return sendJson(res, 200, await statesResponse(repoRoot, map, { regeneration: regenerated?.regeneration ?? null }));
            }
            return saveAndRespond(res, map, next);
          }

          // One precondition's binding: point it at a state (with or without the same list item), or unbind it.
          if (sub === "binding" && req.method === "POST") {
            const parsed = BindingBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid binding" });
            const { edgeId, precondition, stateId, sameItem } = parsed.data;
            const graph = await loadPersistedGraph(repoRoot, map);
            const rest = graph.bindings.filter((b) => !(b.edgeId === edgeId && b.precondition === precondition));
            const bindings = stateId ? [...rest, { edgeId, precondition, stateId, ...(sameItem ? { sameItem: true } : {}) }] : rest;
            const next: StateGraph = { states: graph.states, bindings };
            const errors = validateStateGraph(next, map, await loadProjectUsers(repoRoot, map));
            if (errors.length) return sendJson(res, 400, { error: errors[0], details: errors.join("\n") });
            return saveAndRespond(res, map, next);
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          console.error(`[navmap-states-api] ${req.method} ${req.url} failed:`, err);
          return sendJson(res, 500, { error: "States request failed" });
        }
      });
    },
  };
}
