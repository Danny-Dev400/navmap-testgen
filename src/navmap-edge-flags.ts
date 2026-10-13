import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { ActionEdge } from "./navmap-types.js";
import { abs, projectPaths } from "./project-paths.js";

/** The user's per-edge overrides, kept beside the map (the map is owned by exploration, so an
 *  override survives every re-exploration). An override wins over the agent's own tag. */
export const EdgeFlagsSchema = z.object({
  destructive: z.record(z.string(), z.boolean()).default({}),
});
export type EdgeFlags = z.infer<typeof EdgeFlagsSchema>;

export async function loadEdgeFlags(rootDir: string, projectId: string): Promise<EdgeFlags> {
  try {
    return EdgeFlagsSchema.parse(JSON.parse(await readFile(abs(rootDir, projectPaths(projectId).edgeFlags), "utf-8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { destructive: {} };
    throw err;
  }
}

export async function saveEdgeFlags(rootDir: string, projectId: string, flags: EdgeFlags): Promise<void> {
  const file = abs(rootDir, projectPaths(projectId).edgeFlags);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(flags, null, 2), "utf-8");
}

export function isDestructive(edge: ActionEdge, flags: EdgeFlags | undefined): boolean {
  return flags?.destructive[edge.id] ?? edge.destructive === true;
}
