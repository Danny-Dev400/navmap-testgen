import { rename, access } from "node:fs/promises";
import path from "node:path";
import { projectPaths } from "../src/project-paths.js";

// Renames the pending "before" screenshot of an edge to its final name. A dedicated script (rather
// than `mv`) so headless runs never need a general-purpose file-moving shell permission: both names
// are validated and the rename can only ever happen inside projects/<host-slug>/screenshots/.
const [hostSlug, edgeId] = process.argv.slice(2);
if (!hostSlug || !edgeId || !/^[a-z0-9-]{1,80}$/.test(hostSlug) || !/^[a-z0-9_-]{1,300}$/.test(edgeId)) {
  console.error("Usage: npm run navmap:finalize-shot -- <host-slug> <edgeId>");
  process.exit(1);
}

const dir = projectPaths(hostSlug).screenshots;
const from = path.join(dir, "_pending.before.png");
const to = path.join(dir, `${edgeId}.before.png`);

try {
  await access(from);
} catch {
  console.error(`No pending before-shot at ${from} — take it first (step 10.3 of the /navmap protocol).`);
  process.exit(1);
}
await rename(from, to);
console.log(`Renamed ${from} -> ${to}`);
