import { access, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { NavigationMapSchema, type NavigationMap } from "../../src/navmap-types";
import { abs, projectPaths } from "../../src/project-paths";

export { PROJECT_ID_RE } from "../../src/project-paths";

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** null = no such project; throws on a file that exists but doesn't parse. */
export async function loadMap(repoRoot: string, id: string): Promise<NavigationMap | null> {
  try {
    const raw = await readFile(abs(repoRoot, projectPaths(id).navmap), "utf-8");
    return NavigationMapSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > MAX_BODY_BYTES) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}
