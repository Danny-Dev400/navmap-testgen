export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECTID_RE = /^[0-9a-f]{24}$/i;
const NUMERIC_RE = /^\d+$/;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{10,}$/;

function looksDynamic(segment: string): boolean {
  if (UUID_RE.test(segment)) return true;
  if (OBJECTID_RE.test(segment)) return true;
  if (NUMERIC_RE.test(segment)) return true;
  if (OPAQUE_TOKEN_RE.test(segment) && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment)) return true;
  return false;
}

function normalizeSegments(path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((seg) => (looksDynamic(seg) ? ":id" : seg.toLowerCase()));
  return "/" + segments.join("/");
}

export function normalizePageUrl(rawUrl: string): { urlPattern: string } {
  const u = new URL(rawUrl);
  // A path-like hash (#/orders/123 or #!/orders/123) is an SPA client-side route and IS the
  // real page identity; a plain anchor hash (#section) is incidental, like a query param.
  const hashIsRoute = /^#!?\//.test(u.hash);
  const basis = hashIsRoute ? u.hash.replace(/^#!?/, "") : u.pathname;
  const normalized = normalizeSegments(basis);
  return { urlPattern: normalized === "" ? "/" : normalized };
}

export function pageIdFor(urlPattern: string): string {
  return urlPattern === "/" ? "home" : slugify(urlPattern);
}

export function edgeIdFor(fromPageId: string, semanticIntent: string, toPageId: string): string {
  return `${fromPageId}__${slugify(semanticIntent)}__${toPageId}`;
}
