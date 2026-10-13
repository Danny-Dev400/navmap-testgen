import type { NavigationMap } from "./navmap-types.js";
import type { ExplorationRun, StepNode, TestPlan, TestPlanStep, Workflow } from "./types.js";

function outcomeText(lastOutcome: "success" | "failed" | "partial" | undefined): string {
  return lastOutcome ?? "not yet verified";
}

/** Mirrors the merge-time "latest-wins" caution elsewhere in this project: an edge with no
 *  lastOutcome yet is unverified, not a free pass — it must not read as "success" in the
 *  synthesized workflow status. */
function workflowStatus(edges: NavigationMap["edges"][string][]): Workflow["status"] {
  if (edges.some((e) => e.lastOutcome === "failed")) return "failed";
  if (edges.some((e) => e.lastOutcome !== "success")) return "partial";
  return "success";
}

/** Translates a persistent /navmap NavigationMap into the same ExplorationRun shape /explore
 *  already produces (src/types.ts), so the existing report renderer (src/reportTemplate.ts)
 *  can render navmap-derived coverage with zero changes. One Workflow per PageNode (its
 *  outgoing edges), one StepNode + one TestPlan per ActionEdge. This is a point-in-time
 *  snapshot of what the map already knows, not a new exploration run. */
export function buildCoverageRun(map: NavigationMap): ExplorationRun {
  const edgesByFromPage = new Map<string, NavigationMap["edges"][string][]>();
  for (const edge of Object.values(map.edges)) {
    const bucket = edgesByFromPage.get(edge.fromPageId) ?? [];
    bucket.push(edge);
    edgesByFromPage.set(edge.fromPageId, bucket);
  }

  const stepNodes: Record<string, StepNode> = {};
  const testPlans: TestPlan[] = [];
  const workflows: Workflow[] = [];

  for (const page of Object.values(map.pages)) {
    const outgoing = edgesByFromPage.get(page.id) ?? [];

    for (const edge of outgoing) {
      stepNodes[edge.id] = {
        id: edge.id,
        action: edge.action,
        target: edge.target,
        inputValue: edge.inputValue,
        expectedResult: edge.postconditions.map((p) => p.description).join("; ") || undefined,
        observedResult: outcomeText(edge.lastOutcome),
        matchedExpectation: edge.lastOutcome === "success" ? true : edge.lastOutcome === "failed" ? false : undefined,
        screenshot: edge.screenshot,
        url: map.pages[edge.toPageId]?.urlPattern,
      };

      const steps: TestPlanStep[] =
        edge.postconditions.length > 0
          ? edge.postconditions.map((post, i) => ({
              order: i + 1,
              action: edge.action,
              target: edge.target,
              inputData: edge.inputValue,
              expectedAssertion: post.description,
              assertionType: post.assertionType,
              ...(post.check ? { checkKind: post.check.kind } : {}),
              sourceStepId: edge.id,
            }))
          : [
              {
                order: 1,
                action: edge.action,
                target: edge.target,
                inputData: edge.inputValue,
                expectedAssertion: "(no assertion recorded)",
                assertionType: "element_visible",
                sourceStepId: edge.id,
              },
            ];

      testPlans.push({
        id: `coverage:${edge.id}`,
        workflowId: edge.fromPageId,
        title: edge.semanticIntent,
        preconditions: edge.preconditions,
        steps,
      });
    }

    workflows.push({
      id: page.id,
      title: page.title,
      status: workflowStatus(outgoing),
      stepIds: outgoing.map((e) => e.id),
    });
  }

  const pageCount = Object.keys(map.pages).length;
  const edgeCount = Object.keys(map.edges).length;

  return {
    id: `coverage:${map.id}`,
    targetUrl: `https://${map.targetHost}`,
    startedAt: map.updatedAt,
    finishedAt: map.updatedAt,
    summary: `${pageCount} page${pageCount === 1 ? "" : "s"}, ${edgeCount} action${edgeCount === 1 ? "" : "s"} covered as of ${map.updatedAt} (generated from the persistent navmap, not a fresh exploration run).`,
    stepNodes,
    workflows,
    testPlans,
  };
}
