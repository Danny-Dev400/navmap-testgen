import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ExplorationRun } from "../../src/types";
import { buildGraph, type MindMapNodeData } from "./graph";
import { layoutNodes } from "./layout";
import { MindMapNode } from "./MindMapNode";
import { SidePanel } from "./SidePanel";

const nodeTypes = { stepNode: MindMapNode };

export function App({ run }: { run: ExplorationRun }) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    const { nodes: rawNodes, edges } = buildGraph(run);
    return { nodes: layoutNodes(rawNodes, edges), edges };
  }, [run]);

  const selectedData = useMemo<MindMapNodeData | null>(() => {
    if (!selectedNodeId) return null;
    const node = nodes.find((n) => n.id === selectedNodeId) as Node<MindMapNodeData> | undefined;
    return node?.data ?? null;
  }, [nodes, selectedNodeId]);

  return (
    <div className="app-layout">
      <header className="app-header">
        <h1>Exploration Map</h1>
        <p className="muted">{run.targetUrl}</p>
      </header>
      <div className="app-body">
        <div className="canvas-wrap">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        <SidePanel data={selectedData} run={run} onClose={() => setSelectedNodeId(null)} />
      </div>
    </div>
  );
}
