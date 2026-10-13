import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { HelpTip } from "./help";
import { actionIcon } from "./testCaseIcons";
import { useAssistant } from "./assistant";
import { clearParams, navigate } from "./nav";
import { casesApi, STATE_KIND_LABEL, type CasesData, type CaseStep, type StateKind } from "./casesClient";
import { newStateId, statesApi, type Answer, type QuestionView, type RawState, type StateView, type StatesData } from "./statesClient";
import { Badge, Button, Callout, DetailPanel, EmptyState, Field, IconButton, Menu, PageHeader, Section, SplitView, cx, type Tone } from "./ui/kit";
import { Icon, type LucideIcon } from "./ui/icons";

const KIND_ORDER: { kind: StateKind; title: string; icon: LucideIcon }[] = [
  { kind: "persistent", title: "Persists across pages", icon: Icon.flow },
  { kind: "transient", title: "On the page", icon: Icon.cases },
  { kind: "initial", title: "Already true at the start", icon: Icon.check },
  { kind: "account", title: "Run as a specific user", icon: Icon.user },
];

const STATUS: Record<StateView["status"], { tone: Tone; label: string }> = {
  ok: { tone: "success", label: "Ready" },
  needs_answer: { tone: "warning", label: "Needs an answer" },
  cant_run_here: { tone: "warning", label: "Can't run everywhere" },
  not_automatable: { tone: "neutral", label: "Not automatable" },
};

type Detail = { kind: "state"; id: string | null } | { kind: "question"; key: string };

/** States & flows: the situations tests need the app in, how each is reached (a reusable flow),
 *  who needs it — and the questions for you when nobody knows how to reach one. The list stays on
 *  the left; a question or a state opens on the right. */
export function StatesView({ projectId, initialStateId, refreshSignal }: { projectId: string; onBack?: () => void; initialStateId?: string; refreshSignal: number }) {
  const [data, setData] = useState<StatesData | null>(null);
  const [cases, setCases] = useState<CasesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(initialStateId ? { kind: "state", id: initialStateId } : null);
  const [showUnbound, setShowUnbound] = useState(false);
  const assistant = useAssistant();

  const load = useCallback(() => {
    statesApi
      .load(projectId)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(String(err)));
    casesApi.load(projectId).then(setCases).catch(() => undefined);
  }, [projectId]);
  useEffect(load, [load, refreshSignal]);
  useEffect(() => {
    if (initialStateId) setDetail({ kind: "state", id: initialStateId });
  }, [initialStateId]);

  const run = async (fn: () => Promise<StatesData>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setData(await fn());
      casesApi.load(projectId).then(setCases).catch(() => undefined);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <p className="muted coverage-body">{error ? `Could not load states: ${error}` : "Loading…"}</p>;

  const closeDetail = () => {
    setDetail(null);
    if (initialStateId) clearParams(projectId, "states");
  };
  const openState = (id: string) => setDetail({ kind: "state", id });
  const question = detail?.kind === "question" ? data.questions.find((q) => q.key === detail.key) : undefined;
  const editingState = detail?.kind === "state" && detail.id ? data.graph.states.find((s) => s.id === detail.id) : undefined;
  const answer = (q: QuestionView, a: Answer) => run(() => statesApi.answer(projectId, { ...(q.questionId ? { questionId: q.questionId } : {}), ...(q.stateId ? { stateId: q.stateId } : {}), answer: a }));

  let panel: ReactNode = null;
  if (question && cases) {
    panel = (
      <QuestionPanel
        key={question.key}
        q={question}
        data={data}
        cases={cases}
        busy={busy}
        onAnswer={async (a) => {
          if (await answer(question, a)) closeDetail();
        }}
        onOpenState={openState}
        onClose={closeDetail}
      />
    );
  } else if (detail?.kind === "state" && cases && (detail.id === null || editingState)) {
    panel = (
      <StatePanel
        key={detail.id ?? "new"}
        projectId={projectId}
        data={data}
        cases={cases}
        state={editingState ?? null}
        view={detail.id ? data.states.find((s) => s.id === detail.id) : undefined}
        busy={busy}
        onSave={async (graph) => (await run(() => statesApi.save(projectId, graph, data.updatedAt))) && (closeDetail(), true)}
        onMerge={async (targetId) => (await run(() => statesApi.answer(projectId, { stateId: detail.id!, answer: { kind: "sameAs", stateId: targetId } }))) && (closeDetail(), true)}
        onBind={(body) => run(() => statesApi.bind(projectId, body))}
        onClose={closeDetail}
      />
    );
  }

  const byKind = (kind: StateKind) => data.states.filter((s) => s.kind === kind && !s.notAutomatable);
  const notAutomatable = data.states.filter((s) => s.notAutomatable);
  const selectedStateId = detail?.kind === "state" ? detail.id : null;

  const list = (
    <div className="cases-list-pane">
      {error && <Callout tone="danger">{error}</Callout>}

      {data.unbound.length > 0 && (
        <Callout
          tone="info"
          icon={Icon.link}
          title={`${data.unbound.length} precondition${data.unbound.length === 1 ? " isn't" : "s aren't"} linked to a state yet`}
          actions={
            <Button size="sm" variant="primary" icon={Icon.link} onClick={() => assistant.open("link")}>
              Link them
            </Button>
          }
        >
          Their actions' tests stay fixme until then.{" "}
          <button className="link-button" onClick={() => setShowUnbound((v) => !v)}>
            {showUnbound ? "Hide" : "Show"}
          </button>
          {showUnbound && (
            <ul>
              {data.unbound.map((u) => (
                <li key={`${u.edgeId}|${u.precondition}`}>
                  <em>{u.precondition}</em> — {u.intent} ({u.pageTitle})
                </li>
              ))}
            </ul>
          )}
        </Callout>
      )}

      {data.questions.length > 0 && (
        <Section title="Questions for you" icon={Icon.question} count={data.questions.length} help={<HelpTip topic="questions" />}>
          <div className="question-list">
            {data.questions.map((q) => (
              <div key={q.key} className={cx("question-card", detail?.kind === "question" && detail.key === q.key && "selected")}>
                <div className="question-card-main">
                  <div className="question-title">{q.title}</div>
                  <div className="question-meta">
                    {q.blocking > 0 && (
                      <Badge tone="danger">
                        blocks {q.blocking} case{q.blocking === 1 ? "" : "s"}
                      </Badge>
                    )}
                    {q.source === "agent" && (
                      <Badge tone="ai" icon={Icon.ai}>
                        asked by the {q.askedBy}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="question-card-actions">
                  {q.suggestions.slice(0, 1).map((s, i) => (
                    <Button key={i} size="sm" disabled={busy} onClick={() => answer(q, s.answer)} title="The agent's suggested answer">
                      {s.label}
                    </Button>
                  ))}
                  <Button size="sm" variant="primary" iconRight={Icon.forward} onClick={() => setDetail({ kind: "question", key: q.key })}>
                    Answer
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {data.states.length === 0 && (
        <EmptyState icon={Icon.states} title="No states yet">
          States appear when actions' preconditions are linked (Link preconditions in the Assistant) or when you create one. A state is described once — e.g. “Cart has items”
          with the flow that adds a product — and every test that needs it reuses it.
        </EmptyState>
      )}

      {KIND_ORDER.map(({ kind, title, icon }) => {
        const list = byKind(kind);
        if (list.length === 0) return null;
        return (
          <Section key={kind} title={title} icon={icon} count={list.length} help={kind === "persistent" ? <HelpTip topic="stateKinds" /> : undefined}>
            <ul className="coverage-case-list">
              {list.map((s) => (
                <StateRow key={s.id} s={s} selected={s.id === selectedStateId} onOpen={() => openState(s.id)} />
              ))}
            </ul>
          </Section>
        );
      })}
      {notAutomatable.length > 0 && (
        <Section title="Can't be automated" icon={Icon.ban} count={notAutomatable.length} help={<HelpTip topic="notAutomatable" />}>
          <ul className="coverage-case-list">
            {notAutomatable.map((s) => (
              <StateRow key={s.id} s={s} selected={s.id === selectedStateId} onOpen={() => openState(s.id)} />
            ))}
          </ul>
        </Section>
      )}
      {data.stale.length > 0 && (
        <p className="muted">
          {data.stale.length} link{data.stale.length === 1 ? "" : "s"} point to preconditions the map no longer has (re-explored or reworded) — they're ignored; the state
          linker re-links the new wording.
        </p>
      )}
    </div>
  );

  return (
    <div className="app-layout">
      <PageHeader
        title={
          <>
            States &amp; flows <HelpTip topic="states" />
          </>
        }
        meta={
          <>
            <span>
              <strong>{data.states.length}</strong> state{data.states.length === 1 ? "" : "s"}
            </span>
            {data.questions.length > 0 && (
              <Badge tone="warning">
                {data.questions.length} question{data.questions.length === 1 ? "" : "s"} for you
              </Badge>
            )}
            {data.unbound.length > 0 && <Badge tone="info">{data.unbound.length} unlinked</Badge>}
          </>
        }
        actions={
          <>
            <Button icon={Icon.link} onClick={() => assistant.open("link")} title="The state linker agent links preconditions to states — reusing existing ones — and asks you when it can't">
              Link preconditions
            </Button>
            <Button variant="primary" icon={Icon.add} onClick={() => setDetail({ kind: "state", id: null })}>
              New state
            </Button>
          </>
        }
      />
      <SplitView list={list} detail={panel} />
    </div>
  );
}

function StateRow({ s, onOpen, selected }: { s: StateView; onOpen: () => void; selected?: boolean }) {
  const st = STATUS[s.status];
  return (
    <li>
      <button className={cx("coverage-case-row", selected && "selected")} onClick={onOpen}>
        <Icon.states size={16} className="state-row-icon" aria-hidden />
        <span className="coverage-case-title">
          <span className="case-row-title">
            {s.title}
            {s.perItem && <span className="state-row-peritem"> · per item</span>}
          </span>
          <span className="case-row-meta">
            {s.notAutomatable
              ? s.notAutomatable.reason
              : s.kind === "account"
                ? `runs as ${s.userLabel}`
                : s.kind === "initial"
                  ? "nothing to set up"
                  : s.flow.length
                    ? s.flow.map((f) => f.intent).join(" → ")
                    : "no flow yet"}
            <span className="case-row-meta-item">
              · {s.usedBy.actions.length} action{s.usedBy.actions.length === 1 ? "" : "s"} · {s.usedBy.cases.length} case{s.usedBy.cases.length === 1 ? "" : "s"}
            </span>
          </span>
        </span>
        {s.status !== "ok" && <Badge tone={st.tone}>{st.label}</Badge>}
        <Icon.chevronRight size={16} className="case-row-chevron" aria-hidden />
      </button>
    </li>
  );
}

type Choice = "flow" | "initial" | "same" | "user" | "explore" | "never" | "leave" | "text";

/** One question, with every way to answer it as a clear choice. */
function QuestionPanel({
  q,
  data,
  cases,
  busy,
  onAnswer,
  onOpenState,
  onClose,
}: {
  q: QuestionView;
  data: StatesData;
  cases: CasesData;
  busy: boolean;
  onAnswer: (answer: Answer) => Promise<void>;
  onOpenState: (id: string) => void;
  onClose: () => void;
}) {
  const assistant = useAssistant();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [sameAs, setSameAs] = useState("");
  const [sameItem, setSameItem] = useState(false);
  const [userId, setUserId] = useState(data.users.find((u) => u.kind === "auth")?.id ?? data.users[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [text, setText] = useState("");
  const state = q.stateId ? data.states.find((s) => s.id === q.stateId) : undefined;
  const raw = q.stateId ? data.graph.states.find((s) => s.id === q.stateId) : undefined;
  const [steps, setSteps] = useState<CaseStep[]>(raw?.flow ?? []);
  const [stateKind, setStateKind] = useState<"persistent" | "transient">(raw?.kind === "transient" ? "transient" : "persistent");
  const others = data.states.filter((s) => s.id !== q.stateId && !s.notAutomatable);

  const explore = () => {
    const pages = state?.cantRunOn.map((p) => p.pageTitle).join(", ");
    const focus =
      q.issue === "cant_run_here" && state
        ? `On ${pages}: record how to ${state.flow[0]?.intent.toLowerCase() ?? state.title.toLowerCase()} there (the control exists in the page, the map just hasn't recorded it)`
        : `Find how a user gets to the state "${state?.title ?? q.title}" and record the actions that lead there`;
    assistant.open("explore", { request: focus.slice(0, 300) });
  };

  const choices: { id: Choice; icon: LucideIcon; title: string; text: string; immediate?: () => void }[] =
    q.issue === "free"
      ? [
          { id: "text", icon: Icon.edit, title: "Answer", text: "Write the answer — the agents read it next time (never put a password here)." },
          { id: "leave", icon: Icon.close, title: "Dismiss", text: "Don't answer; it isn't asked again.", immediate: () => void onAnswer({ kind: "dismiss" }) },
        ]
      : [
          ...(q.issue === "no_flow"
            ? [
                { id: "flow" as const, icon: Icon.flow, title: "Compose a flow", text: "The recorded actions that put the app in this state." },
                { id: "initial" as const, icon: Icon.check, title: "Already true at the start", text: "A fresh session is already like that — nothing to set up.", immediate: () => void onAnswer({ kind: "initial" }) },
                { id: "same" as const, icon: Icon.states, title: "Same as another state", text: "Merge it into a state that already exists." },
                { id: "user" as const, icon: Icon.user, title: "Run as a specific user", text: "The test runs as one of the project's users." },
              ]
            : []),
          { id: "explore", icon: Icon.explore, title: "Explore to find it", text: "Opens the explorer with this as its focus (uses quota).", immediate: explore },
          ...(q.issue === "no_flow" ? [{ id: "never" as const, icon: Icon.ban, title: "Can't be automated", text: "Tests needing it stay fixme with your reason." }] : []),
          { id: "leave", icon: Icon.close, title: "Leave it", text: "Its tests stay fixme; it isn't asked again.", immediate: () => void onAnswer({ kind: "dismiss" }) },
        ];

  const form = (c: Choice): ReactNode => {
    switch (c) {
      case "flow":
        return (
          <>
            <FlowEditor steps={steps} onChange={setSteps} cases={cases} />
            <Field label="Kind">
              <select className="users-input" value={stateKind} onChange={(e) => setStateKind(e.target.value as "persistent" | "transient")}>
                <option value="persistent">Persists across pages (cart, submitted form)</option>
                <option value="transient">Only on the page that needs it (open menu)</option>
              </select>
            </Field>
            <Button variant="primary" disabled={busy || steps.length === 0} onClick={() => onAnswer({ kind: "flow", steps, stateKind })}>
              Use this flow
            </Button>
          </>
        );
      case "same":
        return (
          <>
            <select className="users-input" value={sameAs} onChange={(e) => setSameAs(e.target.value)}>
              <option value="">Pick the state it's the same as…</option>
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({STATE_KIND_LABEL[s.kind]})
                </option>
              ))}
            </select>
            <label className="users-check">
              <input type="checkbox" checked={sameItem} onChange={(e) => setSameItem(e.target.checked)} /> with the same list item as the action that needs it
            </label>
            <Button variant="primary" disabled={busy || !sameAs} onClick={() => onAnswer({ kind: "sameAs", stateId: sameAs, sameItem })}>
              Merge into it
            </Button>
          </>
        );
      case "user":
        return (
          <>
            <select className="users-input" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {data.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label} ({u.kind})
                </option>
              ))}
            </select>
            <Button variant="primary" disabled={busy || !userId} onClick={() => onAnswer({ kind: "user", userId })}>
              Run as this user
            </Button>
          </>
        );
      case "never":
        return (
          <>
            <input className="users-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (e.g. needs a real payment)" maxLength={500} />
            <Button variant="primary" disabled={busy || !reason.trim()} onClick={() => onAnswer({ kind: "notAutomatable", reason: reason.trim() })}>
              Mark as not automatable
            </Button>
          </>
        );
      case "text":
        return (
          <>
            <textarea className="users-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer" />
            <Button variant="primary" disabled={busy || !text.trim()} onClick={() => onAnswer({ kind: "text", text: text.trim() })}>
              Send answer
            </Button>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <DetailPanel
      eyebrow={q.source === "agent" ? `Question from the ${q.askedBy}` : "Question"}
      title={q.title}
      badges={
        <>
          {q.blocking > 0 && (
            <Badge tone="danger">
              blocks {q.blocking} case{q.blocking === 1 ? "" : "s"}
            </Badge>
          )}
          {state && (
            <button className="link-button" onClick={() => onOpenState(state.id)}>
              Open the state
            </button>
          )}
        </>
      }
      onClose={onClose}
    >
      {q.detail && <p className="question-detail">{q.detail}</p>}
      {q.suggestions.length > 0 && (
        <Callout tone="ai" title="Suggested by the agent">
          <div className="question-suggestions">
            {q.suggestions.map((s, i) => (
              <Button key={i} size="sm" disabled={busy} onClick={() => onAnswer(s.answer)}>
                {s.label}
              </Button>
            ))}
          </div>
        </Callout>
      )}
      <div className="answer-choices" role="list">
        {choices.map((c) => {
          const C = c.icon;
          const open = choice === c.id;
          return (
            <div key={c.id} className={cx("answer-choice", open && "open")} role="listitem">
              <button
                className="answer-choice-head"
                disabled={busy}
                onClick={() => {
                  if (c.immediate) return c.immediate();
                  setChoice(open ? null : c.id);
                }}
              >
                <C size={18} className="answer-choice-icon" aria-hidden />
                <span className="answer-choice-text">
                  <span className="answer-choice-title">{c.title}</span>
                  <span className="answer-choice-desc">{c.text}</span>
                </span>
                {!c.immediate && (open ? <Icon.chevronDown size={16} aria-hidden /> : <Icon.chevronRight size={16} aria-hidden />)}
              </button>
              {open && <div className="answer-choice-form">{form(c.id)}</div>}
            </div>
          );
        })}
      </div>
    </DetailPanel>
  );
}

/** A flow: map actions in order, each with its list item / typed value. */
function FlowEditor({ steps, onChange, cases }: { steps: CaseStep[]; onChange: (steps: CaseStep[]) => void; cases: CasesData }) {
  const set = (i: number, patch: Partial<CaseStep>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="flow-editor">
      {steps.length === 0 && <p className="muted">No steps yet — add the actions that put the app in this state, in order.</p>}
      <ol className="flow-steps">
        {steps.map((s, i) => {
          const a = cases.actions[s.edgeId];
          return (
            <li key={i} className="flow-step">
              <span className="flow-step-name">
                {a ? actionIcon(a.action) : "⚠️"} <strong>{a?.semanticIntent ?? s.edgeId}</strong>{" "}
                <span className="muted">on {cases.pages.find((p) => p.id === (s.on ?? a?.fromPageId))?.title ?? "?"}</span>
              </span>
              {a?.item && <input className="users-input flow-step-input" placeholder={`item (default ${a.item})`} value={s.item ?? ""} onChange={(e) => set(i, { item: e.target.value || undefined })} />}
              {a?.inputValue !== undefined && (
                <input className="users-input flow-step-input" placeholder={`value (default ${a.inputValue})`} value={s.input ?? ""} onChange={(e) => set(i, { input: e.target.value || undefined })} />
              )}
              <span className="flow-step-buttons">
                <IconButton icon={Icon.chevronUp} size="sm" label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton icon={Icon.chevronDown} size="sm" label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)} />
                <IconButton icon={Icon.close} size="sm" label="Remove step" onClick={() => onChange(steps.filter((_, j) => j !== i))} />
              </span>
            </li>
          );
        })}
      </ol>
      <select className="users-input" value="" onChange={(e) => e.target.value && onChange([...steps, { edgeId: e.target.value }])} aria-label="Add an action">
        <option value="">＋ Add an action…</option>
        {cases.pages.map((p) => {
          const list = Object.values(cases.actions).filter((a) => a.fromPageId === p.id && !a.isLogin);
          if (list.length === 0) return null;
          return (
            <optgroup key={p.id} label={p.title}>
              {list.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.semanticIntent}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </div>
  );
}

/** Create or edit a state: what it is, how it's reached, what it needs first, and which
 *  preconditions point to it. */
function StatePanel({
  projectId,
  data,
  cases,
  state,
  view,
  busy,
  onSave,
  onMerge,
  onBind,
  onClose,
}: {
  projectId: string;
  data: StatesData;
  cases: CasesData;
  state: RawState | null;
  view?: StateView;
  busy: boolean;
  onSave: (graph: StatesData["graph"]) => Promise<boolean>;
  onMerge: (targetId: string) => Promise<boolean>;
  onBind: (body: { edgeId: string; precondition: string; stateId: string | null; sameItem?: boolean }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(state?.title ?? "");
  const [description, setDescription] = useState(state?.description ?? "");
  const [kind, setKind] = useState<StateKind>(state?.kind ?? "persistent");
  const [steps, setSteps] = useState<CaseStep[]>(state?.flow ?? []);
  const [perItem, setPerItem] = useState(!!state?.perItem);
  const [userId, setUserId] = useState(state?.userId ?? data.users.find((u) => u.kind === "auth")?.id ?? "");
  const [requires, setRequires] = useState<string[]>(state?.requires ?? []);
  const [never, setNever] = useState(state?.notAutomatable?.reason ?? "");
  const [mode, setMode] = useState<null | "merge" | "delete">(null);
  const [mergeInto, setMergeInto] = useState("");
  const hasFlow = kind === "persistent" || kind === "transient";
  const scopedStep = useMemo(() => steps.some((s) => !!cases.actions[s.edgeId]?.item && !s.item), [steps, cases.actions]);

  const save = () => {
    const now = new Date().toISOString();
    const next: RawState = {
      id: state?.id ?? newStateId(title, data.graph.states.map((s) => s.id)),
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      kind,
      ...(hasFlow && steps.length ? { flow: steps } : {}),
      ...(hasFlow && perItem && scopedStep ? { perItem: true } : {}),
      ...(kind === "account" && userId ? { userId } : {}),
      ...(hasFlow && requires.length ? { requires } : {}),
      ...(never.trim() ? { notAutomatable: { reason: never.trim() } } : {}),
      ...(state?.note ? { note: state.note } : {}),
      origin: state ? (state.origin === "migrated" || state.origin === "agent" ? "manual" : state.origin) : "manual",
      createdAt: state?.createdAt ?? now,
      updatedAt: now,
    };
    const states = state ? data.graph.states.map((s) => (s.id === state.id ? next : s)) : [...data.graph.states, next];
    return onSave({ states, bindings: data.graph.bindings });
  };
  const remove = () => {
    if (!state) return;
    const states = data.graph.states.filter((s) => s.id !== state.id).map((s) => (s.requires?.includes(state.id) ? { ...s, requires: s.requires.filter((r) => r !== state.id) } : s));
    return onSave({ states, bindings: data.graph.bindings.filter((b) => b.stateId !== state.id) });
  };
  const askedByCases = view?.usedBy.cases.filter((c) => cases.cases.find((x) => x.id === c.id)?.given?.some((g) => g.state === state?.id)) ?? [];

  return (
    <DetailPanel
      eyebrow={state ? "State" : "New state"}
      title={title.trim() || "Untitled state"}
      badges={
        view && (
          <>
            <Badge tone={STATUS[view.status].tone}>{STATUS[view.status].label}</Badge>
            <Badge tone="neutral">{STATE_KIND_LABEL[view.kind]}</Badge>
          </>
        )
      }
      menu={
        state ? (
          <Menu
            items={[
              { label: "Merge into another state…", icon: Icon.states, onSelect: () => setMode("merge") },
              { label: "Delete…", icon: Icon.delete, danger: true, onSelect: () => setMode("delete") },
            ]}
          />
        ) : undefined
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" icon={Icon.check} loading={busy} disabled={!title.trim() || (kind === "account" && !userId)} onClick={save}>
            {state ? "Save" : "Create state"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      {mode === "merge" && state && (
        <Callout
          tone="info"
          title="Merge into another state"
          actions={
            <>
              <Button size="sm" variant="primary" disabled={busy || !mergeInto} onClick={() => onMerge(mergeInto)}>
                Merge
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
                Cancel
              </Button>
            </>
          }
        >
          Its preconditions and the cases that ask for it move over.
          <select className="users-input state-merge-select" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
            <option value="">Pick a state…</option>
            {data.states
              .filter((s) => s.id !== state.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
          </select>
        </Callout>
      )}
      {mode === "delete" && state && (
        <Callout
          tone="danger"
          title={askedByCases.length ? "Can't delete it yet" : `Delete "${state.title}"?`}
          actions={
            <>
              {askedByCases.length === 0 && (
                <Button size="sm" variant="danger" disabled={busy} onClick={remove}>
                  Delete
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
                Keep it
              </Button>
            </>
          }
        >
          {askedByCases.length > 0
            ? `${askedByCases.length} case(s) ask for it in their Given — remove it there first, or merge it into another state.`
            : "Preconditions pointing here become unlinked; their tests go fixme until re-linked."}
        </Callout>
      )}
      {view?.cantRunOn.map((p) => (
        <Callout key={p.pageId} tone="warning" title={`Can't run on ${p.pageTitle}`}>
          {p.reason}.
        </Callout>
      ))}
      {state?.note && <p className="state-note">{state.note}</p>}

      <Field label="Title" hint="The situation, e.g. “Cart has items”">
        <input className="users-input wide" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={!state} maxLength={160} />
      </Field>
      <Field label="Description" hint="Optional">
        <input className="users-input wide" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </Field>
      <Field label={<>Kind <HelpTip topic="stateKinds" /></>}>
        <select className="users-input wide" value={kind} onChange={(e) => setKind(e.target.value as StateKind)}>
          <option value="persistent">Persists across pages — a reusable flow function (cart, submitted form)</option>
          <option value="transient">Only on the page that needs it — its steps run right there (open menu)</option>
          <option value="initial">Already true at the start — nothing to set up</option>
          <option value="account">Run as a specific user</option>
        </select>
      </Field>
      {kind === "account" && (
        <Field label="User">
          <select className="users-input wide" value={userId} onChange={(e) => setUserId(e.target.value)}>
            {data.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label} ({u.kind})
              </option>
            ))}
          </select>
        </Field>
      )}
      {hasFlow && (
        <Field label="Flow" hint="The map actions that put the app in this state, in order.">
          <FlowEditor steps={steps} onChange={setSteps} cases={cases} />
          {scopedStep && (
            <label className="users-check">
              <input type="checkbox" checked={perItem} onChange={(e) => setPerItem(e.target.checked)} /> per item — the test can choose which list item the flow acts on
            </label>
          )}
        </Field>
      )}
      {hasFlow && (
        <Field label="Needs first" hint="Other states its flow needs, beyond its first action's own preconditions.">
          <div>
            {requires.map((r) => (
              <div key={r} className="case-require-row">
                <Icon.states size={14} aria-hidden /> {data.states.find((s) => s.id === r)?.title ?? r}
                <IconButton icon={Icon.close} size="sm" label="Remove" onClick={() => setRequires(requires.filter((x) => x !== r))} />
              </div>
            ))}
            <select className="users-input wide" value="" onChange={(e) => e.target.value && setRequires([...requires, e.target.value])}>
              <option value="">＋ Add a state it needs first…</option>
              {data.states
                .filter((s) => s.id !== state?.id && !requires.includes(s.id))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
            </select>
          </div>
        </Field>
      )}
      <Field label={<>Can't be automated <HelpTip topic="notAutomatable" /></>} hint="Optional reason — tests needing it stay fixme.">
        <input className="users-input wide" value={never} onChange={(e) => setNever(e.target.value)} placeholder="Leave empty if it can be automated" maxLength={500} />
      </Field>

      {view && view.usedBy.actions.length > 0 && (
        <div className="state-section">
          <div className="state-section-title">Preconditions pointing here ({view.usedBy.actions.length})</div>
          <ul className="state-bindings">
            {view.usedBy.actions.map((b) => (
              <li key={`${b.edgeId}|${b.precondition}`}>
                <span className="state-binding-text">
                  <em>{b.precondition}</em> <span className="muted">— {b.intent} ({b.pageTitle})</span>
                </span>
                {b.canShareItem && (
                  <label className="users-check">
                    <input type="checkbox" checked={b.sameItem} disabled={busy} onChange={(e) => onBind({ edgeId: b.edgeId, precondition: b.precondition, stateId: view.id, sameItem: e.target.checked })} /> same item
                  </label>
                )}
                <select
                  className="users-input state-binding-move"
                  value=""
                  disabled={busy}
                  onChange={(e) => e.target.value && onBind({ edgeId: b.edgeId, precondition: b.precondition, stateId: e.target.value === "__none" ? null : e.target.value })}
                >
                  <option value="">Move…</option>
                  {data.states
                    .filter((s) => s.id !== view.id)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        to “{s.title}”
                      </option>
                    ))}
                  <option value="__none">Unlink</option>
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}
      {view && view.usedBy.cases.length > 0 && (
        <div className="state-section">
          <div className="state-section-title">Needed by {view.usedBy.cases.length} case{view.usedBy.cases.length === 1 ? "" : "s"}</div>
          <ul className="state-cases">
            {view.usedBy.cases.map((c) => (
              <li key={c.id}>
                <button className="link-button" onClick={() => navigate(projectId, "cases", { case: c.id })}>
                  {c.title}
                </button>
                {!c.runnable && c.status !== "rejected" && <Badge tone="neutral">fixme</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </DetailPanel>
  );
}
