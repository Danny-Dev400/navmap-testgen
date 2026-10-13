import { readFile } from "node:fs/promises";
import { NavigationMapSchema } from "../src/navmap-types.js";
import { loadProjectUsers, storageStatePathFor } from "../src/navmap-users.js";
import { performLogin, readCredentials } from "../src/navmap-auth.js";
import { resolveMapArg } from "../src/project-paths.js";

const args = process.argv.slice(2);
const mapArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--user");
const userFlagIndex = args.indexOf("--user");
const onlyUserId = userFlagIndex >= 0 ? args[userFlagIndex + 1] : undefined;

if (!mapArg || (userFlagIndex >= 0 && !onlyUserId)) {
  console.error("Usage: npm run navmap:auth-setup -- <project-id | path-to-navmap.json> [--user <userId>]");
  process.exit(1);
}
const inputPath = resolveMapArg(mapArg);

const rootDir = process.cwd();
const map = NavigationMapSchema.parse(JSON.parse(await readFile(inputPath, "utf-8")));
const users = (await loadProjectUsers(rootDir, map)).filter((u) => u.kind === "auth" && (!onlyUserId || u.id === onlyUserId));

if (users.length === 0) {
  console.error(
    onlyUserId
      ? `No auth user "${onlyUserId}" in project "${map.id}".`
      : `Project "${map.id}" has no auth users — add one in the Users tab, or re-run /navmap with creds=<path>.`,
  );
  process.exit(1);
}

let failed = false;
for (const user of users) {
  if (!user.credentialsRef) {
    console.error(`User "${user.id}" has no credentials file — set a password in the Users tab.`);
    failed = true;
    continue;
  }
  const outputPath = storageStatePathFor(map, user.id);
  let secret: string | undefined;
  try {
    const credentials = await readCredentials(rootDir, user.credentialsRef);
    secret = credentials.password;
    await performLogin(map, credentials, outputPath);
    console.log(`[${user.id}] Logged in and wrote session state to ${outputPath}`);
  } catch (err) {
    // This output is shown in the Users tab — Playwright call logs can echo filled values, so
    // keep only the first line and scrub the password defensively.
    let message = (err as Error).message.split("\n")[0];
    if (secret) message = message.split(secret).join("***");
    console.error(`[${user.id}] Login failed: ${message}`);
    failed = true;
  }
}

if (failed) process.exit(1);
