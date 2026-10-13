import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { PageClusterNodeData } from "./navmapGraph";
import { Icon } from "./ui/icons";
import { cx } from "./ui/kit";

/** A collapsed group of similar pages; clicking it expands the group. Its size must match
 *  CLUSTER_NODE_WIDTH / CLUSTER_NODE_HEIGHT in elkLayout.ts. */
export function PageClusterNode({ data, selected }: NodeProps & { data: PageClusterNodeData }) {
  const { groupName, memberPages, crossingEdgeCount, isEntry, dimmed } = data;

  return (
    <div
      className={cx("map-node map-cluster", selected && "is-selected", isEntry && "is-entry", dimmed && "is-dimmed")}
      title={`${groupName}: ${memberPages.map((p) => p.title).join(", ")}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="map-node-title">
        {isEntry && <Icon.entry size={13} className="map-node-entry" aria-label="Contains the entry page" />}
        <Icon.group size={14} className="map-cluster-icon" aria-hidden />
        <span className="map-node-name">{groupName}</span>
      </div>
      <div className="map-node-meta">
        {memberPages.length} pages · {crossingEdgeCount} action{crossingEdgeCount === 1 ? "" : "s"}
      </div>
      <div className="map-cluster-hint">
        Click to expand <Icon.chevronRight size={12} aria-hidden />
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
