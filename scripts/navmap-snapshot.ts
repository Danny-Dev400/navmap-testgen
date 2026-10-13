import { readPageSnapshot } from "../src/navmap-snapshots.js";

// Prints one page's saved accessibility snapshot, normalized (no live-session refs) — how the
// test-design agent reads a page without opening a browser.
const [projectId, pageId] = process.argv.slice(2);
if (!projectId || !pageId || !/^[a-z0-9-]{1,80}$/.test(projectId) || !/^[a-z0-9_-]{1,200}$/.test(pageId)) {
  console.error("Usage: npm run navmap:snapshot -- <projectId> <pageId>");
  process.exit(1);
}
const snapshot = await readPageSnapshot(process.cwd(), projectId, pageId);
if (!snapshot) {
  console.error(`No snapshot saved for page "${pageId}" — it was never captured (see design-context "snapshot": false).`);
  process.exit(1);
}
console.log(`# ${pageId} — captured ${snapshot.capturedAt}`);
console.log(snapshot.text);
