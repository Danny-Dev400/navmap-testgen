import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { NavigationMap, PageNode } from "./navmap-types.js";
import { slugify } from "./navmap-ids.js";
import { abs, projectPaths, storageStatePathFor as storageStatePathOf } from "./project-paths.js";

export const USER_ID_RE = /^[a-z0-9-]{1,40}$/;
export const GUEST_USER_ID = "guest";

export const ProjectUserSchema = z.object({
  id: z.string().regex(USER_ID_RE),
  label: z.string().min(1),
  kind: z.enum(["guest", "auth"]),
  // Repo-relative path to a { username, password, loginUrl? } file under the gitignored
  // credentials/ folder — never the credential values themselves.
  credentialsRef: z.string().optional(),
  // undefined = every page this kind of user can reach; a list can only narrow that, never widen it.
  allowedPageIds: z.array(z.string()).optional(),
});
export type ProjectUser = z.infer<typeof ProjectUserSchema>;

export const ProjectUsersSchema = z.object({ users: z.array(ProjectUserSchema) });

/** Users live beside the map, not inside it: the map is owned by exploration (/navmap + merge),
 *  users by a human in the UI, so neither can clobber the other. */
export function usersConfigPath(rootDir: string, projectId: string): string {
  return abs(rootDir, projectPaths(projectId).users);
}

/** What a project gets before anyone has touched the Users tab: a guest, plus the identity
 *  /navmap explored with (if any), so existing projects keep working with zero setup. */
export function defaultUsers(map: NavigationMap): ProjectUser[] {
  const users: ProjectUser[] = [{ id: GUEST_USER_ID, label: "Guest", kind: "guest" }];
  if (map.credentialsRef) {
    users.push({ id: "default", label: "Default", kind: "auth", credentialsRef: map.credentialsRef });
  }
  return users;
}

export async function loadProjectUsers(rootDir: string, map: NavigationMap): Promise<ProjectUser[]> {
  try {
    const raw = await readFile(usersConfigPath(rootDir, map.id), "utf-8");
    return ProjectUsersSchema.parse(JSON.parse(raw)).users;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultUsers(map);
    throw err;
  }
}

export async function saveProjectUsers(rootDir: string, projectId: string, users: ProjectUser[]): Promise<void> {
  const filePath = usersConfigPath(rootDir, projectId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ users }, null, 2), "utf-8");
}

export function userCanAccess(user: ProjectUser, page: PageNode): boolean {
  if (user.kind === "guest" && page.requiresAuth === true) return false;
  return !user.allowedPageIds || user.allowedPageIds.includes(page.id);
}

/** Which user a page's generated tests run as: the guest when it may access the page (cheapest,
 *  no session needed), otherwise the first auth user that both may access it and has credentials.
 *  undefined means no configured user can reach the page — its tests are generated as fixme. */
export function chooseUserForPage(page: PageNode, users: ProjectUser[]): ProjectUser | undefined {
  return (
    users.find((u) => u.kind === "guest" && userCanAccess(u, page)) ??
    users.find((u) => u.kind === "auth" && !!u.credentialsRef && userCanAccess(u, page))
  );
}

/** Where the UI stores credentials it was given (projects/<id>/credentials/<userId>.json). Only
 *  files at exactly this path are ever deleted by the UI — a user pointing at a hand-made file
 *  (e.g. the one /navmap explored with) never gets that file removed. */
export { credentialsPathFor } from "./project-paths.js";

export function storageStatePathFor(map: NavigationMap, userId: string): string {
  return storageStatePathOf(map.id, userId);
}

export function newUserId(label: string, existing: ProjectUser[]): string {
  const base = slugify(label).slice(0, 36) || "user";
  const taken = new Set(existing.map((u) => u.id));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
