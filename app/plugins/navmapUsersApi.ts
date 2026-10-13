import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Plugin } from "vite";
import { z } from "zod/v4";
import type { NavigationMap } from "../../src/navmap-types";
import {
  credentialsPathFor,
  GUEST_USER_ID,
  loadProjectUsers,
  newUserId,
  saveProjectUsers,
  storageStatePathFor,
  type ProjectUser,
} from "../../src/navmap-users";
import { CredentialsSchema, type Credentials } from "../../src/navmap-auth";
import { loadMap, pathExists, PROJECT_ID_RE, readJsonBody, sendJson } from "./apiHelpers";
import { regenerateInBackground } from "./regenerate";

// /api/projects/<id>/users[/<userId>[/session]] — everything else falls through via next().
const USERS_PATH_RE = /^\/([a-z0-9-]{1,80})\/users(?:\/([a-z0-9-]{1,40}))?(?:\/(session))?\/?$/;

const CreateUserBody = z.object({
  label: z.string().trim().min(1).max(60),
  username: z.string().min(1),
  password: z.string().min(1),
  loginUrl: z.url().optional(),
  allowedPageIds: z.array(z.string()).optional(),
});

const UpdateUserBody = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  // null resets to "every page this kind of user can reach".
  allowedPageIds: z.array(z.string()).nullable().optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  loginUrl: z.url().nullable().optional(),
});

/** Keeps only real page ids, and for the guest only pages that don't require login — an
 *  allow-list can narrow what a user reaches, never widen it. */
function sanitizeAllowedPages(map: NavigationMap, kind: ProjectUser["kind"], ids: string[]): string[] {
  return ids.filter((id) => map.pages[id] && !(kind === "guest" && map.pages[id].requiresAuth === true));
}

export function navmapUsersApiPlugin({ repoRoot }: { repoRoot: string }): Plugin {
  async function writeCredentials(relPath: string, credentials: Credentials) {
    const absPath = path.join(repoRoot, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, JSON.stringify(credentials, null, 2), { encoding: "utf-8", mode: 0o600 });
  }

  async function readExistingCredentials(relPath: string | undefined): Promise<Credentials | null> {
    if (!relPath) return null;
    try {
      return CredentialsSchema.parse(JSON.parse(await readFile(path.join(repoRoot, relPath), "utf-8")));
    } catch {
      return null;
    }
  }

  /** Public view of a user — never includes the username or password, only whether they exist. */
  async function describeUser(map: NavigationMap, user: ProjectUser) {
    const sessionPath = path.join(repoRoot, storageStatePathFor(map, user.id));
    const session = await stat(sessionPath).catch(() => null);
    return {
      id: user.id,
      label: user.label,
      kind: user.kind,
      allowedPageIds: user.allowedPageIds ?? null,
      hasCredentials: user.kind === "auth" && !!user.credentialsRef && (await pathExists(path.join(repoRoot, user.credentialsRef))),
      credentialsManagedByUi: user.credentialsRef === credentialsPathFor(map.id, user.id),
      sessionUpdatedAt: session ? session.mtime.toISOString() : null,
    };
  }

  async function listResponse(map: NavigationMap, users: ProjectUser[]) {
    return { users: await Promise.all(users.map((u) => describeUser(map, u))) };
  }

  return {
    name: "navmap-users-api",
    configureServer(server) {
      server.middlewares.use("/api/projects", async (req, res, next) => {
        const match = USERS_PATH_RE.exec(req.url ?? "/");
        if (!match) return next();
        const [, projectId, userId, sub] = match;
        if (!PROJECT_ID_RE.test(projectId)) return sendJson(res, 400, { error: "Invalid project id" });

        try {
          const map = await loadMap(repoRoot, projectId);
          if (!map) return sendJson(res, 404, { error: "Project not found" });
          const users = await loadProjectUsers(repoRoot, map);

          if (!userId) {
            if (req.method === "GET") return sendJson(res, 200, await listResponse(map, users));
            if (req.method === "POST") {
              const parsed = CreateUserBody.safeParse(await readJsonBody(req));
              if (!parsed.success) return sendJson(res, 400, { error: "Invalid user", details: z.prettifyError(parsed.error) });
              const body = parsed.data;
              const id = newUserId(body.label, users);
              const credentialsRef = credentialsPathFor(map.id, id);
              await writeCredentials(credentialsRef, { username: body.username, password: body.password, loginUrl: body.loginUrl });
              const user: ProjectUser = {
                id,
                label: body.label,
                kind: "auth",
                credentialsRef,
                allowedPageIds: body.allowedPageIds ? sanitizeAllowedPages(map, "auth", body.allowedPageIds) : undefined,
              };
              const updatedUsers = [...users, user];
              await saveProjectUsers(repoRoot, map.id, updatedUsers);
              regenerateInBackground(repoRoot, map.id, "a user change");
              return sendJson(res, 201, await listResponse(map, updatedUsers));
            }
            return sendJson(res, 405, { error: "Method not allowed" });
          }

          const user = users.find((u) => u.id === userId);
          if (!user) return sendJson(res, 404, { error: "User not found" });

          if (sub === "session") {
            if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
            if (user.kind !== "auth") return sendJson(res, 400, { error: "Guests don't have sessions" });
            // projectId/userId are regex-validated slugs, so they're safe as shell arguments.
            const child = spawn("npx", ["tsx", "scripts/navmap-auth-setup.ts", map.id, "--user", user.id], {
              cwd: repoRoot,
              shell: true,
            });
            let output = "";
            child.stdout.on("data", (chunk) => (output += chunk.toString()));
            child.stderr.on("data", (chunk) => (output += chunk.toString()));
            const exitCode: number = await new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
            return sendJson(res, 200, { ok: exitCode === 0, output: output.slice(-2000), ...(await listResponse(map, users)) });
          }

          if (req.method === "PATCH") {
            const parsed = UpdateUserBody.safeParse(await readJsonBody(req));
            if (!parsed.success) return sendJson(res, 400, { error: "Invalid update", details: z.prettifyError(parsed.error) });
            const body = parsed.data;
            const updated: ProjectUser = { ...user };
            if (body.label !== undefined) updated.label = body.label;
            if (body.allowedPageIds !== undefined) {
              updated.allowedPageIds = body.allowedPageIds === null ? undefined : sanitizeAllowedPages(map, user.kind, body.allowedPageIds);
            }
            if (body.username !== undefined || body.password !== undefined || body.loginUrl !== undefined) {
              if (user.kind !== "auth") return sendJson(res, 400, { error: "Guests don't have credentials" });
              const existing = await readExistingCredentials(user.credentialsRef);
              const username = body.username ?? existing?.username;
              const password = body.password ?? existing?.password;
              if (!username || !password) return sendJson(res, 400, { error: "Both username and password are required" });
              const loginUrl = body.loginUrl === null ? undefined : (body.loginUrl ?? existing?.loginUrl);
              // Always write to this user's UI-managed file — a hand-made file (e.g. the one /navmap
              // explored with) is never overwritten from the UI.
              const credentialsRef = credentialsPathFor(map.id, user.id);
              await writeCredentials(credentialsRef, { username, password, loginUrl });
              updated.credentialsRef = credentialsRef;
            }
            const updatedUsers = users.map((u) => (u.id === user.id ? updated : u));
            await saveProjectUsers(repoRoot, map.id, updatedUsers);
              regenerateInBackground(repoRoot, map.id, "a user change");
            return sendJson(res, 200, await listResponse(map, updatedUsers));
          }

          if (req.method === "DELETE") {
            if (user.id === GUEST_USER_ID) return sendJson(res, 400, { error: "The guest user can't be deleted" });
            if (user.credentialsRef === credentialsPathFor(map.id, user.id)) {
              await rm(path.join(repoRoot, user.credentialsRef), { force: true });
            }
            await rm(path.join(repoRoot, storageStatePathFor(map, user.id)), { force: true });
            const updatedUsers = users.filter((u) => u.id !== user.id);
            await saveProjectUsers(repoRoot, map.id, updatedUsers);
              regenerateInBackground(repoRoot, map.id, "a user change");
            return sendJson(res, 200, await listResponse(map, updatedUsers));
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        } catch (err) {
          // Never echo the error itself — a failed request body parse could contain the password.
          console.error(`[navmap-users-api] ${req.method} ${req.url} failed: ${(err as Error).name}`);
          return sendJson(res, 500, { error: "Users request failed" });
        }
      });
    },
  };
}
