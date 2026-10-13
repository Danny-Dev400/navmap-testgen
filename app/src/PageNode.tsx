import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { PageNodeData } from "./navmapGraph";
import { Icon } from "./ui/icons";
import { cx } from "./ui/kit";

/** A page on the map. Its size must match NODE_WIDTH / NODE_HEIGHT in elkLayout.ts. */
export function PageNode({ data, selected }: NodeProps & { data: PageNodeData }) {
  const { page, outgoingCount, isEntry, dimmed } = data;

  return (
    <div className={cx("map-node", selected && "is-selected", isEntry && "is-entry", dimmed && "is-dimmed")} title={`${page.title}\n${page.urlPattern}`}>
      <Handle type="target" position={Position.Left} />
      <div className="map-node-title">
        {isEntry && <Icon.entry size={13} className="map-node-entry" aria-label="Entry page" />}
        <span className="map-node-name">{page.title}</span>
        {page.requiresAuth && <Icon.lock size={12} className="map-node-lock" aria-label="Requires signing in" />}
      </div>
      <div className="map-node-url">{page.urlPattern}</div>
      <div className="map-node-meta">
        {outgoingCount} action{outgoingCount === 1 ? "" : "s"}
        <span aria-hidden> · </span>
        seen {page.timesObserved}×
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
