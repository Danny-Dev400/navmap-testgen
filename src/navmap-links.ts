import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { abs, projectPaths } from "./project-paths.js";
import { z } from "zod/v4";

export const LinkScopeSchema = z.enum(["same-page", "persistent"]);
export type LinkScope = z.infer<typeof LinkScopeSchema>;

export const PreconditionLinkSchema = z
  .object({
    edgeId: z.string(),
    // Exact precondition text. A link only applies while the edge's precondition still reads
    // exactly this — if /navmap rewords it, the link goes stale and the precondition is re-asked.
    precondition: z.string(),
    status: z.enum(["linked", "unresolvable", "rejected"]),
    // same-page: transient UI state (open menu, dropdown, banner) — the setup must run on the page
    // that needs it, with no navigation in between. persistent: session/server state (cart,
    // created records) — the setup can run anywhere and survives navigation.
    scope: LinkScopeSchema.optional(),
    setupEdgeIds: z.array(z.string()),
    // Explicit tag: the setup acts on the same list item as the action it prepares (add product X →
    // remove product X), so it uses the consumer's item instead of its own recorded one.
    shareItem: z.boolean().optional(),
    rationale: z.string().min(1),
    verification: z.object({ result: z.enum(["passed", "failed"]), at: z.string() }).optional(),
  })
  .refine((l) => l.status !== "linked" || (l.scope !== undefined && l.setupEdgeIds.length > 0), {
    message: "a linked precondition needs a scope and at least one setup edge",
  });
export type PreconditionLink = z.infer<typeof PreconditionLinkSchema>;

export const LinksFileSchema = z.object({ links: z.array(PreconditionLinkSchema) });

/** Kept beside the map, not in it: the map is owned by exploration, links by the linker skill,
 *  so neither can overwrite the other (same reasoning as users.json). */
export function linksPath(rootDir: string, projectId: string): string {
  return abs(rootDir, projectPaths(projectId).links);
}

export async function loadLinks(rootDir: string, projectId: string): Promise<PreconditionLink[]> {
  try {
    return LinksFileSchema.parse(JSON.parse(await readFile(linksPath(rootDir, projectId), "utf-8"))).links;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function saveLinks(rootDir: string, projectId: string, links: PreconditionLink[]): Promise<void> {
  const filePath = linksPath(rootDir, projectId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ links }, null, 2), "utf-8");
}

export function linkKey(edgeId: string, precondition: string): string {
  return `${edgeId}\u0000${precondition}`;
}

export function indexLinks(links: PreconditionLink[]): Map<string, PreconditionLink> {
  return new Map(links.map((l) => [linkKey(l.edgeId, l.precondition), l]));
}

/** Upserts by (edgeId, precondition) — a re-run replaces earlier judgments on the same
 *  precondition and leaves every other link alone. */
export function mergeLinks(existing: PreconditionLink[], incoming: PreconditionLink[]): PreconditionLink[] {
  const byKey = indexLinks(existing);
  for (const link of incoming) byKey.set(linkKey(link.edgeId, link.precondition), link);
  return [...byKey.values()];
}
