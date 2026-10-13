import { useCallback, useEffect, useState } from "react";
import { HelpTip } from "./help";
import { navigate, type Tab } from "./nav";
import { useAssistant, type AssistantSection } from "./assistant";
import { startRun, timeAgo } from "./runsClient";
import { Button, Callout, Card, PageHeader, Section, StatusIcon, cx } from "./ui/kit";
import { Icon, type LucideIcon } from "./ui/icons";

// Client mirror of app/plugins/navmapOverviewApi.ts.
type InboxAction =
  | { label: string; kind: "navigate"; tab: Tab; params?: Record<string, string> }
  | { label: string; kind: "assistant"; section: AssistantSection; prefill?: { pageId?: string; useCaseId?: string; request?: string } }
  | { label: string; kind: "rerun"; caseId: string }
  | { label: string; kind: "triage"; runId: string; testIndex: number };

interface Overview {
  map: { pages: number; actions: number; snapshots: number; explorations: number; updatedAt: string };
  cases: { approved: number; drafts: number; needsReview: number; fixme: number; runnable: number; actionsWithoutCase: number };
  organization: { features: number; useCases: number; tested: number; unsorted: number } | null;
  states: { count: number; questions: number; unbound: number };
  features: {
    id: string;
    title: string;
    tested: number;
    passed: number;
    failed: number;
    useCases: { id: string; title: string; description: string | null; status: "ok" | "partial" | "failing" | "none"; passed: number; failed: number }[];
  }[];
  runs: { runId: string; label: string; finishedAt: string; counts: Record<string, number>; stale: boolean } | null;
  diagnosis: { untriaged: number; proposals: number };
  journeys: { id: string; titles: string[]; pages: string[]; covered: boolean; coveredBy: string[]; partial: number }[];
  next: { title: string; why: string; action?: InboxAction };
  inbox: { id: string; icon: string; title: string; detail?: string; actions: InboxAction[] }[];
  testRunRunning: boolean;
}

/** The project's starting point: where it stands, the one thing to do next, and everything that
 *  waits for a decision — each with a button that takes you there. */
export function HomeView({ projectId, host, onBack, refreshSignal }: { projectId: string; host: string; onBack: () => void; refreshSignal: number }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const assistant = useAssistant();

  const load = useCallback(() => {
    fetch(`/api/projects/${encodeURIComponent(projectId)}/overview`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`);
        setData(await r.json());
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }, [projectId]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load, refreshSignal]);

  const act = async (a: InboxAction) => {
    setMessage(null);
    if (a.kind === "navigate") return navigate(projectId, a.tab, a.params);
    if (a.kind === "assistant") return assistant.open(a.section, a.prefill);
    if (a.kind === "rerun") {
      const err = await startRun(projectId, { scope: "case", caseId: a.caseId });
      setMessage(err ?? "Rerun started — the result shows up here and in Test runs when it ends.");
      return;
    }
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/runs/${a.runId}/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testIndexes: [a.testIndex] }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setMessage(body.error ?? `${res.status}`);
    assistant.open("triage");
  };

  if (error) return <p className="muted coverage-body">Could not load the overview: {error}</p>;
  if (!data) return <p className="muted coverage-body">Loading&hellip;</p>;

  const j = data.journeys;
  const runCounts = data.runs?.counts;
  const casesLines = [
    `${data.cases.approved} approved · ${data.cases.runnable} runnable`,
    data.organization ? `${data.organization.tested}/${data.organization.useCases} use cases tested` : "",
    data.states.questions ? `${data.states.questions} question${data.states.questions === 1 ? "" : "s"} for you` : "",
    [data.cases.drafts && `${data.cases.drafts} draft${data.cases.drafts === 1 ? "" : "s"}`, data.cases.needsReview && `${data.cases.needsReview} need review`, data.cases.fixme && `${data.cases.fixme} can't run yet`]
      .filter(Boolean)
      .join(" · "),
  ];
  return (
    <div className="app-layout">
      <PageHeader
        title={
          <>
            Home <HelpTip topic="home" />
          </>
        }
        meta={
          <>
            <span>{host}</span>
            <span>map updated {timeAgo(data.map.updatedAt)}</span>
          </>
        }
      />
      <div className="ui-page">
        <div className="ui-page-inner home-page">
          <div className={cx("home-next", !data.next.action && "home-next-done")}>
            <div className="home-next-icon">{data.next.action ? <Icon.forward size={20} aria-hidden /> : <Icon.passed size={22} aria-hidden />}</div>
            <div className="home-next-text">
              <div className="home-next-label">Next step</div>
              <div className="home-next-title">{data.next.title}</div>
              {data.next.why && <div className="home-next-why">{data.next.why}</div>}
            </div>
            {data.next.action && (
              <Button variant="primary" iconRight={Icon.forward} onClick={() => act(data.next.action!)}>
                {plainLabel(data.next.action.label)}
              </Button>
            )}
          </div>
          {message && <Callout tone="info">{message}</Callout>}

          <div className="home-pipeline">
            <PipelineCard
              icon={Icon.map}
              title="Map"
              status={data.map.pages ? "ok" : "todo"}
              lines={[`${data.map.pages} pages · ${data.map.actions} actions`, `${data.map.snapshots} snapshots · ${data.map.explorations} explorations`]}
              onOpen={() => navigate(projectId, "map")}
              help="map"
            />
            <PipelineCard
              icon={Icon.cases}
              title="Test cases"
              status={data.cases.drafts || data.cases.needsReview || data.states.questions ? "warn" : data.cases.approved ? "ok" : "todo"}
              lines={casesLines}
              onOpen={() => navigate(projectId, "cases")}
              help="cases"
            />
            <PipelineCard
              icon={Icon.runs}
              title="Runs"
              status={!data.runs ? "todo" : (runCounts?.failed ?? 0) > 0 || data.runs.stale ? "warn" : "ok"}
              lines={
                data.runs
                  ? [
                      `${data.runs.label}`,
                      `${timeAgo(data.runs.finishedAt)} · ✓ ${runCounts?.passed ?? 0}  ✗ ${runCounts?.failed ?? 0}${data.runs.stale ? " · cases changed since" : ""}`,
                    ]
                  : ["No run yet"]
              }
              running={data.testRunRunning}
              onOpen={() => navigate(projectId, "runs")}
            />
            <PipelineCard
              icon={Icon.triage}
              title="Diagnosis"
              status={data.diagnosis.untriaged || data.diagnosis.proposals ? "warn" : "ok"}
              lines={[
                `${data.diagnosis.untriaged} failure${data.diagnosis.untriaged === 1 ? "" : "s"} not looked at`,
                `${data.diagnosis.proposals} proposed fix${data.diagnosis.proposals === 1 ? "" : "es"} to decide`,
              ]}
              onOpen={() => navigate(projectId, "runs")}
              help="triage"
            />
          </div>

          <Section title="Inbox" icon={Icon.inbox} count={data.inbox.length || undefined} help={<HelpTip topic="inbox" />}>
            {data.inbox.length === 0 ? (
              <Card>
                <span className="muted">Nothing waits for you.</span>
              </Card>
            ) : (
              <ul className="inbox-list">
                {data.inbox.map((item) => {
                  const ItemIcon = INBOX_ICON[item.icon];
                  return (
                    <li key={item.id} className="inbox-item">
                      <span className={cx("inbox-icon", `inbox-icon-${INBOX_TONE[item.icon] ?? "neutral"}`)}>{ItemIcon ? <ItemIcon size={16} aria-hidden /> : item.icon}</span>
                      <div className="inbox-text">
                        <div className="inbox-title">{item.title}</div>
                        {item.detail && <div className="inbox-detail">{item.detail}</div>}
                      </div>
                      <div className="inbox-actions">
                        {item.actions.map((a, i) => (
                          <Button key={i} size="sm" variant={i === 0 ? "primary" : "ghost"} onClick={() => act(a)}>
                            {plainLabel(a.label)}
                          </Button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {data.features.length > 0 && (
            <Section
              title={`Features — ${data.organization?.tested ?? 0} of ${data.organization?.useCases ?? 0} use cases tested`}
              icon={Icon.feature}
              help={<HelpTip topic="features" />}
            >
              <ul className="home-features">
                {data.features.map((f) => (
                  <li key={f.id} className="home-feature">
                    <div className="home-feature-head">
                      <button className="home-feature-title" onClick={() => navigate(projectId, "cases", { group: "feature" })}>
                        {f.title}
                      </button>
                      <span className="home-feature-bar" title={`${f.tested} of ${f.useCases.length} use cases have an approved case`}>
                        <span style={{ width: `${f.useCases.length ? (100 * f.tested) / f.useCases.length : 0}%` }} />
                      </span>
                      <span className="home-feature-count">
                        {f.tested}/{f.useCases.length}
                      </span>
                      {f.passed + f.failed > 0 && (
                        <span className="feature-results">
                          <span className="feature-passed">
                            <Icon.passed size={13} aria-hidden /> {f.passed}
                          </span>
                          {f.failed > 0 && (
                            <span className="feature-failed">
                              <Icon.failed size={13} aria-hidden /> {f.failed}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="home-feature-usecases">
                      {f.useCases.map((u) => (
                        <span key={u.id} className="home-usecase" title={u.description ?? undefined}>
                          <StatusIcon status={USECASE_GLYPH[u.status]} size={13} />
                          {u.title}
                          {u.status === "none" && (
                            <button
                              className="link-button"
                              onClick={() =>
                                assistant.open("design", {
                                  useCaseId: u.id,
                                  request: `Design cases that prove the use case "${f.title} › ${u.title}"${u.description ? ` — ${u.description}` : ""}. Skip what its existing cases already cover.`,
                                })
                              }
                            >
                              Design
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {j.length > 0 && (
            <Section title={`Journeys — ${j.filter((x) => x.covered).length} of ${j.length} walked end to end`} icon={Icon.journey} help={<HelpTip topic="journeys" />}>
              <ul className="journey-list">
                {j.map((x) => (
                  <li key={x.id} className="journey-row">
                    <StatusIcon status={x.covered ? "passed" : x.partial > 0 ? "flaky" : "never"} size={15} title={x.covered ? "Walked end to end" : x.partial > 0 ? "Partly walked" : "Not walked"} />
                    <span className="journey-path">{x.titles.join(" → ")}</span>
                    {!x.covered && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Icon.design}
                        onClick={() =>
                          assistant.open("design", {
                            pageId: x.pages[0],
                            request: `Design one end-to-end case for the journey ${x.titles.join(" → ")}, with meaningful checks on each page.`,
                          })
                        }
                      >
                        Ask the designer
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Action labels from the server may start with an emoji — the buttons show plain text. */
const plainLabel = (label: string) => label.replace(/^(\p{Extended_Pictographic}|[←-⇿☀-➿])️?\s*/u, "");

/** The server's inbox items carry an emoji; the dashboard shows a matching line icon. */
const INBOX_ICON: Record<string, LucideIcon> = {
  "📝": Icon.draft,
  "⚠️": Icon.warning,
  "⏸️": Icon.fixme,
  "❌": Icon.failed,
  "🔧": Icon.triage,
  "🔑": Icon.lock,
  "❓": Icon.question,
  "⛓": Icon.link,
  "🗂": Icon.organize,
  "📦": Icon.inbox,
  "🧩": Icon.states,
};
const INBOX_TONE: Record<string, string> = {
  "📝": "accent",
  "⚠️": "warning",
  "⏸️": "neutral",
  "❌": "danger",
  "🔧": "ai",
  "🔑": "warning",
  "❓": "warning",
  "⛓": "accent",
  "🗂": "ai",
  "📦": "neutral",
  "🧩": "ai",
};
const USECASE_GLYPH = { ok: "passed", partial: "flaky", failing: "failed", none: "never" } as const;

function PipelineCard({
  icon: IconCmp,
  title,
  status,
  lines,
  onOpen,
  help,
  running,
}: {
  icon: LucideIcon;
  title: string;
  status: "ok" | "warn" | "todo";
  lines: string[];
  onOpen: () => void;
  help?: Parameters<typeof HelpTip>[0]["topic"];
  running?: boolean;
}) {
  return (
    <div
      role="link"
      tabIndex={0}
      className={`pipeline-card pipeline-${status}`}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      <div className="pipeline-head">
        <IconCmp size={18} className="pipeline-icon" aria-hidden />
        <strong>{title}</strong>
        {help && (
          <span onClick={(e) => e.stopPropagation()}>
            <HelpTip topic={help} />
          </span>
        )}
        <span className="pipeline-status">
          {running ? <StatusIcon status="running" size={16} /> : <StatusIcon status={status === "ok" ? "passed" : status === "warn" ? "needs_review" : "never"} size={16} />}
        </span>
      </div>
      {lines.filter(Boolean).map((l, i) => (
        <div key={i} className="pipeline-line">
          {l}
        </div>
      ))}
    </div>
  );
}
