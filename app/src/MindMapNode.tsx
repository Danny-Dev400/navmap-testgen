import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { MindMapNodeData } from "./graph";

export function MindMapNode({ data, selected }: NodeProps & { data: MindMapNodeData }) {
  const { step } = data;
  const mark = step.matchedExpectation === true ? "✓" : step.matchedExpectation === false ? "✗" : "";
  const markClass = step.matchedExpectation === true ? "mark-pass" : step.matchedExpectation === false ? "mark-fail" : "";

  return (
    <div className={`step-node${selected ? " step-node-selected" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <div className="step-node-action">{step.action}</div>
      <div className="step-node-target">{step.target}</div>
      <div className="step-node-footer">
        {mark && <span className={markClass}>{mark}</span>}
        {step.screenshot && (
          <span className="step-node-camera" title="Has a screenshot">
            &#128247;
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
