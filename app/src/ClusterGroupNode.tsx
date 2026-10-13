import type { NodeProps } from "@xyflow/react";
import type { ClusterGroupNodeData } from "./navmapGraph";
import { Icon } from "./ui/icons";

/** The frame around an expanded group. Its header height must equal GROUP_HEADER_HEIGHT in elkLayout.ts. */
export function ClusterGroupNode({ data }: NodeProps & { data: ClusterGroupNodeData }) {
  const { groupName, memberCount, onCollapse } = data;

  return (
    <div className="map-group">
      <div className="map-group-header">
        <Icon.group size={14} aria-hidden className="map-group-icon" />
        <span className="map-group-name">{groupName}</span>
        <span className="map-group-count">{memberCount} pages</span>
        <button
          type="button"
          className="map-group-collapse nodrag nopan"
          onClick={(e) => {
            e.stopPropagation();
            onCollapse();
          }}
          title={`Collapse ${groupName}`}
          aria-label={`Collapse ${groupName}`}
        >
          <Icon.collapseGroup size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}
