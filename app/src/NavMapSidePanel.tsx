import { useEffect, useState, type ReactNode } from "react";
import { timeAgo, type LatestEntry } from "./runsClient";
import type { ActionEdge, NavigationMap, PageNode } from "../../src/navmap-types";
import { Lightbox } from "./Lightbox";
import { locatorText } from "./locatorText";
import { INTENT_COLORS } from "./intentColors";
import { categoryLabel } from "./IntentLegend";
import { RESULT_LABELS, type ResultKey } from "./resultColors";
import { caseStatus } from "./CaseRow";
import { useAssistant } from "./assistant";
import { navigate } from "./nav";
import { Badge, Button, Callout, DetailPanel, Menu, StatusIcon } from "./ui/kit";
import { Icon } from "./ui/icons";

export type NavMapSelection =
  | { type: "page"; page: PageNode }
  | { type: "edge"; edge: ActionEdge }
  | { type: "mergedEdge"; memberEdges: ActionEdge[]; fromLabel: string; toLabel: string }
  | null;

/** A test case, as much of it as the map needs to link to it. */
export interface MapCase {
  id: string;
  title: string;
  status: "draft" | "approved" | "rejected";
  health: "ok" | "needs_review";
  runnable: boolean;
  firstPageId: string | null;
  edgeIds: string[];
}

/** Present when the map is shown inside a project (not in a static report): links to its test
 *  cases and the Assistant. */
export interface MapProject {
  id: string;
  cases: MapCase[];
  latestCases: Record<string, LatestEntry>;
}

/** What a shared component an action belongs to is called, for its badge. */
export type ComponentOf = (edgeId: string) => { kind: "ui" | "repeated"; label: string } | null;

interface NavMapSidePanelProps {
  selection: Exclude<NavMapSelection, null>;
  map: NavigationMap;
  focusedPageId: string | null;
  /** Last test result per action, when known. */
  edgeResults: Record<string, ResultKey> | null;
  componentOf: ComponentOf;
  project?: MapProject;
  onClose: () => void;
  onSelectEdge: (edge: ActionEdge) => void;
  onSelectPage: (pageId: string) => void;
  onFocusPage: (pageId: string | null) => void;
}

/** The detail of whatever is selected on the map, beside the canvas. Every page and action in it is
 *  clickable, so you can walk the map from here; inside a project it also links to the test cases. */
export function NavMapSidePanel(props: NavMapSidePanelProps) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const { selection } = props;
  return (
    <>
      {selection.type === "page" ? (
        <PageDetail {...props} page={selection.page} />
      ) : selection.type === "edge" ? (
        <EdgeDetail {...props} edge={selection.edge} onImageClick={setLightboxSrc} />
      ) : (
        <DetailPanel
          eyebrow={`${selection.memberEdges.length} actions`}
          title={
            <>
              {selection.fromLabel} <span className="map-arrow">→</span> {selection.toLabel}
            </>
          }
          onClose={props.onClose}
        >
          <p className="map-detail-lead">Several actions lead between these two pages. Pick one to see it.</p>
          <ul className="map-rows">
            {selection.memberEdges.map((edge) => (
              <ActionRow key={edge.id} edge={edge} meta={categoryLabel(edge.intentCategory)} {...rowExtras(props, edge.id)} onClick={() => props.onSelectEdge(edge)} />
            ))}
          </ul>
        </DetailPanel>
      )}
      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </>
  );
}

function rowExtras(props: NavMapSidePanelProps, edgeId: string) {
  return {
    result: props.edgeResults?.[edgeId],
    caseCount: props.project ? props.project.cases.filter((c) => c.status !== "rejected" && c.edgeIds.includes(edgeId)).length : undefined,
  };
}

function PageDetail(props: NavMapSidePanelProps & { page: PageNode }) {
  const { page, map, project, focusedPageId, onClose, onSelectEdge, onFocusPage } = props;
  const assistant = useAssistant();
  const edges = Object.values(map.edges);
  const outgoing = edges.filter((e) => e.fromPageId === page.id);
  const incoming = edges.filter((e) => e.toPageId === page.id && e.fromPageId !== page.id);
  const startingHere = project?.cases.filter((c) => c.firstPageId === page.id && c.status !== "rejected") ?? [];
  const focused = focusedPageId === page.id;
  const pageTitle = (id: string) => map.pages[id]?.title ?? id;

  return (
    <DetailPanel
      eyebrow="Page"
      title={page.title}
      badges={
        <>
          {page.id === map.entryPageId && (
            <Badge tone="accent" icon={Icon.entry}>
              Entry page
            </Badge>
          )}
          {page.requiresAuth ? <Badge icon={Icon.lock}>Requires signing in</Badge> : <Badge icon={Icon.publicPage}>Public</Badge>}
        </>
      }
      actions={
        <>
          <Button
            size="sm"
            icon={Icon.focus}
            onClick={() => onFocusPage(focused ? null : page.id)}
            title={focused ? "Show the whole map again" : "Show only this page and the pages it connects to"}
          >
            {focused ? "Show all" : "Focus"}
          </Button>
          {project && (
            <>
              <Button size="sm" icon={Icon.add} onClick={() => navigate(project.id, "cases", { newCase: page.id })}>
                New case
              </Button>
              <Button size="sm" icon={Icon.design} onClick={() => assistant.open("design", { pageId: page.id })}>
                Design cases
              </Button>
            </>
          )}
        </>
      }
      menu={
        project && (
          <Menu
            items={[
              {
                label: "Explore more from here",
                icon: Icon.explore,
                hint: "The explorer agent looks for actions on this page that aren't in the map yet",
                onSelect: () => assistant.open("explore", { request: `The ${page.title} page (${page.urlPattern}): actions not in the map yet` }),
              },
            ]}
          />
        )
      }
      onClose={onClose}
    >
      <div className="map-detail-url">
        <code>{page.urlPattern}</code>
      </div>
      {page.sampleUrls.length > 0 && (
        <details className="map-detail-samples">
          <summary>
            {page.sampleUrls.length} sample URL{page.sampleUrls.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {page.sampleUrls.map((url) => (
              <li key={url}>{url}</li>
            ))}
          </ul>
        </details>
      )}
      {page.notes && <p className="map-detail-notes">{page.notes}</p>}
      {page.lastRepair && <RepairNote note={page.lastRepair} />}

      <MapSection title="Actions from here" count={outgoing.length}>
        {outgoing.length === 0 ? (
          <p className="map-detail-empty">None recorded yet.</p>
        ) : (
          <ul className="map-rows">
            {outgoing.map((edge) => (
              <ActionRow
                key={edge.id}
                edge={edge}
                meta={edge.toPageId === page.id ? "stays on this page" : `→ ${pageTitle(edge.toPageId)}`}
                {...rowExtras(props, edge.id)}
                onClick={() => onSelectEdge(edge)}
              />
            ))}
          </ul>
        )}
      </MapSection>

      <MapSection title="Ways to get here" count={incoming.length}>
        {incoming.length === 0 ? (
          <p className="map-detail-empty">{page.id === map.entryPageId ? "This is where exploring starts." : "None recorded yet."}</p>
        ) : (
          <ul className="map-rows">
            {incoming.map((edge) => (
              <ActionRow key={edge.id} edge={edge} meta={`from ${pageTitle(edge.fromPageId)}`} {...rowExtras(props, edge.id)} onClick={() => onSelectEdge(edge)} />
            ))}
          </ul>
        )}
      </MapSection>

      {project && (
        <MapSection title="Test cases starting here" count={startingHere.length}>
          {startingHere.length === 0 ? (
            <p className="map-detail-empty">None yet.</p>
          ) : (
            <ul className="map-rows">
              {startingHere.map((c) => (
                <CaseLink key={c.id} c={c} project={project} />
              ))}
            </ul>
          )}
        </MapSection>
      )}

      <PageSnapshot key={page.id} projectId={map.id} pageId={page.id} />

      <p className="map-detail-meta">
        Seen {page.timesObserved}× · last verified {timeAgo(page.lastVerifiedAt)}
      </p>
    </DetailPanel>
  );
}

function EdgeDetail(props: NavMapSidePanelProps & { edge: ActionEdge; onImageClick: (src: string) => void }) {
  const { edge, map, project, edgeResults, componentOf, onClose, onSelectPage, onImageClick } = props;
  const pageTitle = (id: string) => map.pages[id]?.title ?? id;
  const result = edgeResults?.[edge.id];
  const component = componentOf(edge.id);
  const usedBy = project?.cases.filter((c) => c.status !== "rejected" && c.edgeIds.includes(edge.id)) ?? [];

  return (
    <DetailPanel
      eyebrow={
        <span className="map-eyebrow">
          <span className="map-row-dot" style={{ background: INTENT_COLORS[edge.intentCategory] }} />
          Action · {categoryLabel(edge.intentCategory)}
        </span>
      }
      title={edge.semanticIntent}
      badges={
        <>
          {result && (
            <span className="map-detail-result" title="Last test result for this action">
              <StatusIcon status={result} size={14} />
              {RESULT_LABELS[result]}
            </span>
          )}
          {edge.lastOutcome === "failed" && <Badge tone="danger">Failed while exploring</Badge>}
          {edge.requiresAuth && <Badge icon={Icon.lock}>Requires signing in</Badge>}
          {component && (
            <Badge icon={component.kind === "ui" ? Icon.uiComponent : Icon.repeated} title={component.kind === "ui" ? "Part of a shared UI component" : "The same element on several pages"}>
              {component.label}
            </Badge>
          )}
        </>
      }
      actions={
        project && (
          <Button size="sm" icon={Icon.add} onClick={() => navigate(project.id, "cases", { newCase: edge.fromPageId, step: edge.id })}>
            New case from this action
          </Button>
        )
      }
      onClose={onClose}
    >
      <div className="map-route">
        <button type="button" className="map-route-page" onClick={() => onSelectPage(edge.fromPageId)} title="Show this page">
          {pageTitle(edge.fromPageId)}
        </button>
        <Icon.forward size={14} aria-hidden className="map-route-arrow" />
        {edge.toPageId === edge.fromPageId ? (
          <span className="map-route-same">same page</span>
        ) : (
          <button type="button" className="map-route-page" onClick={() => onSelectPage(edge.toPageId)} title="Show this page">
            {pageTitle(edge.toPageId)}
          </button>
        )}
      </div>
      {edge.lastRepair && <RepairNote note={edge.lastRepair} />}

      <MapSection title="How it's done">
        <dl className="map-facts">
          <dt>Does</dt>
          <dd>
            {edge.action} on {edge.target}
            {edge.inputValue && <> with “{edge.inputValue}”</>}
          </dd>
          <dt>Locator</dt>
          <dd>
            <code className="map-code">{locatorText(edge.locator)}</code>
          </dd>
        </dl>
      </MapSection>

      {(edge.screenshotBefore || edge.screenshot) && (
        <MapSection title="Screenshots">
          <div className="map-shots">
            {edge.screenshotBefore && (
              <figure>
                <button type="button" onClick={() => onImageClick(edge.screenshotBefore!)} title="Enlarge">
                  <img src={edge.screenshotBefore} alt="The page before the action, with its target highlighted" />
                </button>
                <figcaption>Before · target highlighted</figcaption>
              </figure>
            )}
            {edge.screenshot && (
              <figure>
                <button type="button" onClick={() => onImageClick(edge.screenshot!)} title="Enlarge">
                  <img src={edge.screenshot} alt="The page after the action" />
                </button>
                <figcaption>{edge.screenshotBefore ? "After" : "Screenshot"}</figcaption>
              </figure>
            )}
          </div>
        </MapSection>
      )}

      <MapSection title="Needs first" count={edge.preconditions.length}>
        {edge.preconditions.length === 0 ? (
          <p className="map-detail-empty">Nothing — it works right away on its page.</p>
        ) : (
          <ul className="map-list">
            {edge.preconditions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </MapSection>

      <MapSection title="Checks after it" count={edge.postconditions.length}>
        {edge.postconditions.length === 0 ? (
          <p className="map-detail-empty">None recorded.</p>
        ) : (
          <ul className="map-list">
            {edge.postconditions.map((p, i) => (
              <li key={i}>
                <span className="map-check-kind">{p.assertionType.replace(/_/g, " ")}</span> {p.description}
              </li>
            ))}
          </ul>
        )}
      </MapSection>

      {project && (
        <MapSection title="Test cases using it" count={usedBy.length}>
          {usedBy.length === 0 ? (
            <p className="map-detail-empty">No test case uses this action yet.</p>
          ) : (
            <ul className="map-rows">
              {usedBy.map((c) => (
                <CaseLink key={c.id} c={c} project={project} />
              ))}
            </ul>
          )}
        </MapSection>
      )}

      <p className="map-detail-meta">
        Seen {edge.timesObserved}× · last verified {timeAgo(edge.lastVerifiedAt)}
      </p>
    </DetailPanel>
  );
}

function MapSection({ title, count, children }: { title: ReactNode; count?: number; children: ReactNode }) {
  return (
    <section className="map-detail-section">
      <h3 className="map-detail-h">
        {title}
        {count !== undefined && <span className="map-detail-count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function ActionRow({ edge, meta, result, caseCount, onClick }: { edge: ActionEdge; meta: ReactNode; result?: ResultKey; caseCount?: number; onClick: () => void }) {
  return (
    <li>
      <button type="button" className="map-row" onClick={onClick}>
        <span className="map-row-dot" style={{ background: INTENT_COLORS[edge.intentCategory] }} aria-hidden />
        <span className="map-row-text">
          <span className="map-row-title">{edge.semanticIntent}</span>
          <span className="map-row-meta">{meta}</span>
        </span>
        {caseCount !== undefined && caseCount > 0 && (
          <span className="map-row-count" title={`${caseCount} test case${caseCount === 1 ? "" : "s"} use${caseCount === 1 ? "s" : ""} it`}>
            <Icon.cases size={12} aria-hidden />
            {caseCount}
          </span>
        )}
        {result && <StatusIcon status={result} size={14} title={`Last result: ${RESULT_LABELS[result]}`} />}
        <Icon.chevronRight size={14} className="map-row-chevron" aria-hidden />
      </button>
    </li>
  );
}

function CaseLink({ c, project }: { c: MapCase; project: MapProject }) {
  const status = caseStatus(c, { cases: project.latestCases, edges: {} });
  const last = project.latestCases[c.id];
  const meta =
    c.status === "draft"
      ? "Draft"
      : c.health === "needs_review"
        ? "Needs review"
        : !c.runnable
          ? "Can't run yet"
          : last
            ? `${last.status} ${timeAgo(last.at)}`
            : "Never run";
  return (
    <li>
      <button type="button" className="map-row" onClick={() => navigate(project.id, "cases", { case: c.id })} title="Open in Test cases">
        <StatusIcon status={status} size={15} />
        <span className="map-row-text">
          <span className="map-row-title">{c.title}</span>
          <span className="map-row-meta">{meta}</span>
        </span>
        <Icon.chevronRight size={14} className="map-row-chevron" aria-hidden />
      </button>
    </li>
  );
}

/** The page's saved accessibility snapshot (projects/<id>/snapshots/<pageId>.yml) — what later
 *  agents read to find elements the map didn't record. Only on the dev server: in a static report
 *  the request fails and nothing is shown. */
function PageSnapshot({ projectId, pageId }: { projectId: string; pageId: string }) {
  const [state, setState] = useState<{ text: string; capturedAt: string } | "missing" | "unavailable" | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    fetch(`/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(pageId)}`)
      .then(async (res) => {
        if (res.status === 404) return setState("missing");
        if (!res.ok || !res.headers.get("content-type")?.includes("json")) return setState("unavailable");
        setState(await res.json());
      })
      .catch(() => setState("unavailable"));
  }, [projectId, pageId]);

  if (state === null || state === "unavailable") return null;
  return (
    <MapSection title="Accessibility snapshot">
      {state === "missing" ? (
        <p className="map-detail-empty">Not captured yet — “Refresh page snapshots” in Assistant › Explore saves one, free.</p>
      ) : (
        <>
          <div className="map-snapshot-head">
            <span>Captured {timeAgo(state.capturedAt)} · what agents read to find elements the map doesn't have</span>
            <Button size="sm" variant="ghost" icon={open ? Icon.chevronUp : Icon.snapshot} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "View"}
            </Button>
          </div>
          {open && <pre className="page-snapshot-pre">{state.text}</pre>}
        </>
      )}
    </MapSection>
  );
}

/** A map fact changed by an approved triage fix (not observed by exploration). */
function RepairNote({ note }: { note: { at: string; runId: string; reason: string } }) {
  return (
    <Callout tone="warning" icon={Icon.triage} title={`Repaired by a triage fix ${timeAgo(note.at)}`}>
      {note.reason}
    </Callout>
  );
}
