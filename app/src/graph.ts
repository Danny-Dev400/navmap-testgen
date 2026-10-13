import type { Edge, Node } from "@xyflow/react";
import type { ExplorationRun, StepNode } from "../../src/types";

export interface MindMapNodeData extends Record<string, unknown> {
  step: StepNode;
  workflowTitles: string[];
}

export function buildGraph(run: ExplorationRun): { nodes: Node<MindMapNodeData>[]; edges: Edge[] } {
  const nodeWorkflows = new Map<string, Set<string>>();
  for (const workflow of run.workflows) {
    for (const stepId of workflow.stepIds) {
      if (!nodeWorkflows.has(stepId)) nodeWorkflows.set(stepId, new Set());
      nodeWorkflows.get(stepId)!.add(workflow.title);
    }
  }

  const nodes: Node<MindMapNodeData>[] = Object.values(run.stepNodes).map((step) => ({
    id: step.id,
    type: "stepNode",
    position: { x: 0, y: 0 },
    data: { step, workflowTitles: Array.from(nodeWorkflows.get(step.id) ?? []) },
  }));

  const edgeKeys = new Set<string>();
  const edges: Edge[] = [];
  for (const workflow of run.workflows) {
    for (let i = 0; i < workflow.stepIds.length - 1; i++) {
      const source = workflow.stepIds[i];
      const target = workflow.stepIds[i + 1];
      const key = `${source}->${target}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ id: key, source, target });
    }
  }

  return { nodes, edges };
}
