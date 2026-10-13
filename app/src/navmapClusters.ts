import type { NavigationMap } from "../../src/navmap-types";

export interface PageCluster {
  groupName: string;
  memberIds: string[];
}

/** Only groups with 2+ current members are real clusters — a lone page with `group` set
 *  (e.g. its sibling hasn't been discovered yet) renders as an ordinary page node. */
export function computeClusters(map: NavigationMap): Map<string, PageCluster> {
  const byGroup = new Map<string, string[]>();
  for (const page of Object.values(map.pages)) {
    if (!page.group) continue;
    const ids = byGroup.get(page.group) ?? [];
    ids.push(page.id);
    byGroup.set(page.group, ids);
  }

  const clusters = new Map<string, PageCluster>();
  for (const [groupName, memberIds] of byGroup) {
    if (memberIds.length >= 2) clusters.set(groupName, { groupName, memberIds });
  }
  return clusters;
}

export function buildPageIdToGroup(clusters: Map<string, PageCluster>): Map<string, string> {
  const map = new Map<string, string>();
  for (const cluster of clusters.values()) {
    for (const id of cluster.memberIds) map.set(id, cluster.groupName);
  }
  return map;
}

/** Count of real ActionEdges with exactly one endpoint inside this cluster — drives the
 *  collapsed cluster node's footer badge. Same-page self-loops are never crossing by definition. */
export function countCrossingEdges(map: NavigationMap, cluster: PageCluster): number {
  const members = new Set(cluster.memberIds);
  let count = 0;
  for (const edge of Object.values(map.edges)) {
    const fromIn = members.has(edge.fromPageId);
    const toIn = members.has(edge.toPageId);
    if (fromIn !== toIn) count++;
  }
  return count;
}

export function groupNodeId(groupName: string): string {
  return `cluster:${groupName}`;
}
