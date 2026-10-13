import { readFile } from "node:fs/promises";
import type { NavigationMap } from "./navmap-types.js";
import { CredentialsSchema } from "./navmap-auth.js";
import { loadProjectUsers } from "./navmap-users.js";
import { abs } from "./project-paths.js";

/** Every password this project's users can type — scrubbed from anything stored or shown (test-run
 *  logs and summaries, page snapshots), since Playwright call logs and aria snapshots can echo
 *  filled values. Values shorter than 3 chars are skipped: scrubbing them would mangle text. */
export async function projectSecrets(rootDir: string, map: NavigationMap): Promise<string[]> {
  const refs = new Set<string>((await loadProjectUsers(rootDir, map)).flatMap((u) => (u.credentialsRef ? [u.credentialsRef] : [])));
  if (map.credentialsRef) refs.add(map.credentialsRef);
  const secrets: string[] = [];
  for (const ref of refs) {
    try {
      secrets.push(CredentialsSchema.parse(JSON.parse(await readFile(abs(rootDir, ref), "utf-8"))).password);
    } catch {
      // missing/invalid credentials file — nothing to scrub
    }
  }
  return secrets.filter((s) => s.length >= 3);
}

export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  return out;
}
