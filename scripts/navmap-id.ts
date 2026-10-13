import { edgeIdFor, normalizePageUrl, pageIdFor } from "../src/navmap-ids.js";

const [subcommand, ...args] = process.argv.slice(2);

function usageAndExit(): never {
  console.error('Usage: npm run navmap:id -- page "<url>"');
  console.error('       npm run navmap:id -- edge <fromPageId> "<semanticIntent>" <toPageId>');
  process.exit(1);
}

if (subcommand === "page") {
  const [url] = args;
  if (!url) usageAndExit();
  const { urlPattern } = normalizePageUrl(url);
  console.log(JSON.stringify({ urlPattern, pageId: pageIdFor(urlPattern) }));
} else if (subcommand === "edge") {
  const [fromPageId, semanticIntent, toPageId] = args;
  if (!fromPageId || !semanticIntent || !toPageId) usageAndExit();
  console.log(JSON.stringify({ edgeId: edgeIdFor(fromPageId, semanticIntent, toPageId) }));
} else {
  usageAndExit();
}
