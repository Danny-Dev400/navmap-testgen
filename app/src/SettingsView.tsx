import { useEffect, useState } from "react";
import { PageHeader, Segmented } from "./ui/kit";
import { Icon } from "./ui/icons";
import { useThemePref, type ThemePref } from "./ui/theme";
import type { ProjectSettings } from "../../src/navmap-settings";

const THEME_OPTIONS: { id: ThemePref; label: string; icon: typeof Icon.themeSystem }[] = [
  { id: "system", label: "System", icon: Icon.themeSystem },
  { id: "light", label: "Light", icon: Icon.themeLight },
  { id: "dark", label: "Dark", icon: Icon.themeDark },
];

interface ModelOption {
  id: string;
  label: string;
  note: string;
}

interface FieldError {
  path: string;
  message: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; defaults: ProjectSettings; models: ModelOption[]; browsersInstalled: Record<string, boolean> };

const BROWSERS = ["chromium", "firefox", "webkit"] as const;

/** Per-project settings (projects/<id>/settings.json): how the generated tests run, and which model
 *  and quota cap the agent runs use. Saved as a whole; takes effect on the next run. */
export function SettingsView({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/settings`;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState<ProjectSettings | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [fileError, setFileError] = useState<string | null>(null);
  const [theme, setTheme] = useThemePref();

  useEffect(() => {
    fetch(base)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const body = await res.json();
        setDraft(body.settings);
        setFileError(body.fileError ?? null);
        setLoad({ status: "ready", defaults: body.defaults, models: body.models, browsersInstalled: body.browsersInstalled ?? {} });
      })
      .catch((err) => setLoad({ status: "error", message: String(err) }));
  }, [base]);

  if (load.status === "loading" || (load.status === "ready" && !draft)) return <p className="muted settings-body">Loading&hellip;</p>;
  if (load.status === "error") return <p className="muted settings-body">Could not load settings: {load.message}</p>;
  const s = draft!;
  const ex = s.execution;

  const setExecution = (patch: Partial<ProjectSettings["execution"]>) => {
    setDraft({ ...s, execution: { ...ex, ...patch } });
    setSaved("idle");
  };
  const setAgent = <K extends keyof ProjectSettings["agents"]>(agent: K, patch: Partial<ProjectSettings["agents"][K]>) => {
    setDraft({ ...s, agents: { ...s.agents, [agent]: { ...s.agents[agent], ...patch } } });
    setSaved("idle");
  };
  const errorFor = (path: string) => errors.find((e) => e.path === path || e.path.startsWith(`${path}.`))?.message;

  const save = async () => {
    setSaved("saving");
    setErrors([]);
    const res = await fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
    const body = await res.json();
    if (!res.ok) {
      setErrors(body.fieldErrors ?? [{ path: "", message: body.error ?? `${res.status}` }]);
      return setSaved("idle");
    }
    setDraft(body.settings);
    setFileError(null);
    setSaved("saved");
  };

  const modelSelect = (value: string, onChange: (v: string) => void) => {
    const note = load.models.find((m) => m.id === value)?.note;
    return (
      <>
        <select className="users-input" value={value} onChange={(e) => onChange(e.target.value)}>
          {load.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {note && <span className="muted settings-note">{note}</span>}
      </>
    );
  };

  // Timeouts are stored in ms but edited in seconds; 0 means "no limit" for action/navigation.
  const seconds = (field: "testTimeoutMs" | "expectTimeoutMs" | "actionTimeoutMs" | "navigationTimeoutMs", label: string, hint?: string) => (
    <Field label={label} error={errorFor(`execution.${field}`)} hint={hint}>
      <input
        className="users-input settings-number"
        type="number"
        min={0}
        step={0.5}
        value={ex[field] / 1000}
        onChange={(e) => setExecution({ [field]: Math.round(Number(e.target.value) * 1000) })}
      />
      <span className="muted">s</span>
    </Field>
  );

  return (
    <div className="app-layout">
      <PageHeader title="Settings" meta={<span>Saved to projects/{projectId}/settings.json · applies from the next run</span>} />

      <div className="settings-body">
        {fileError && (
          <div className="users-error">
            projects/{projectId}/settings.json is invalid, so the defaults are shown (and used by test runs). Saving replaces the file.
          </div>
        )}
        <section className="users-card settings-section">
          <strong>Appearance</strong>
          <p className="muted">Applies right away, to every project, in this browser — not saved with the project settings.</p>
          <Field label="Theme">
            <Segmented options={THEME_OPTIONS} value={theme} onChange={setTheme} size="sm" />
          </Field>
        </section>

        <section className="users-card settings-section">
          <strong>Test execution</strong>
          <p className="muted">
            Used by the generated Playwright tests:{" "}
            {ex.browsers.length > 1 ? (
              <>
                <code>npx playwright test projects/{projectId}/tests</code> runs every browser, or one with{" "}
                {ex.browsers.map((b, i) => (
                  <span key={b}>
                    {i > 0 && ", "}
                    <code>--project={projectId}-{b}</code>
                  </span>
                ))}
              </>
            ) : (
              <code>npx playwright test --project={projectId}</code>
            )}
            .
          </p>

          <Field
            label="Browsers"
            error={errorFor("execution.browsers")}
            hint={(() => {
              const missing = ex.browsers.filter((b) => load.browsersInstalled[b] === false);
              return missing.length ? `⚠ not installed for this Playwright version — run: npx playwright install ${missing.join(" ")}` : undefined;
            })()}
          >
            {BROWSERS.map((b) => (
              <label key={b} className="users-check">
                <input
                  type="checkbox"
                  checked={ex.browsers.includes(b)}
                  onChange={(e) => setExecution({ browsers: e.target.checked ? [...ex.browsers, b] : ex.browsers.filter((x) => x !== b) })}
                />
                {b}
              </label>
            ))}
          </Field>
          <Field label="Headless">
            <label className="users-check">
              <input type="checkbox" checked={ex.headless} onChange={(e) => setExecution({ headless: e.target.checked })} />
              Run without a visible browser window
            </label>
          </Field>
          <Field label="Viewport" error={errorFor("execution.viewport")}>
            <input
              className="users-input settings-number"
              type="number"
              value={ex.viewport.width}
              onChange={(e) => setExecution({ viewport: { ...ex.viewport, width: Number(e.target.value) } })}
            />
            <span className="muted">&times;</span>
            <input
              className="users-input settings-number"
              type="number"
              value={ex.viewport.height}
              onChange={(e) => setExecution({ viewport: { ...ex.viewport, height: Number(e.target.value) } })}
            />
          </Field>
          {seconds("testTimeoutMs", "Test timeout")}
          {seconds("expectTimeoutMs", "Assertion timeout")}
          {seconds("actionTimeoutMs", "Action timeout", "0 = no limit")}
          {seconds("navigationTimeoutMs", "Navigation timeout", "0 = no limit")}
          <Field label="Retries" error={errorFor("execution.retries")}>
            <input
              className="users-input settings-number"
              type="number"
              min={0}
              max={5}
              value={ex.retries}
              onChange={(e) => setExecution({ retries: Number(e.target.value) })}
            />
          </Field>
          <Field label="Workers" error={errorFor("execution.workers")}>
            <label className="users-check">
              <input
                type="checkbox"
                checked={ex.workers === "auto"}
                onChange={(e) => setExecution({ workers: e.target.checked ? "auto" : 2 })}
              />
              auto
            </label>
            {ex.workers !== "auto" && (
              <input
                className="users-input settings-number"
                type="number"
                min={1}
                max={16}
                value={ex.workers}
                onChange={(e) => setExecution({ workers: Number(e.target.value) })}
              />
            )}
          </Field>
          <Field label="Trace">
            <Select value={ex.trace} options={["off", "on", "retain-on-failure", "on-first-retry"]} onChange={(v) => setExecution({ trace: v as typeof ex.trace })} />
          </Field>
          <Field label="Screenshot">
            <Select value={ex.screenshot} options={["off", "on", "only-on-failure"]} onChange={(v) => setExecution({ screenshot: v as typeof ex.screenshot })} />
          </Field>
          <Field label="Video">
            <Select value={ex.video} options={["off", "on", "retain-on-failure"]} onChange={(v) => setExecution({ video: v as typeof ex.video })} />
          </Field>
          <Field label="Session max age" error={errorFor("execution.sessionMaxAgeMinutes")} hint="minutes — auth tests log in again after this, or when a cookie expires">
            <input
              className="users-input settings-number"
              type="number"
              min={1}
              max={1440}
              value={ex.sessionMaxAgeMinutes}
              onChange={(e) => setExecution({ sessionMaxAgeMinutes: Number(e.target.value) })}
            />
          </Field>
        </section>

        <section className="users-card settings-section">
          <strong>Agents</strong>
          <p className="muted">
            Headless Claude Code runs on your plan. Budgets cap Claude Code's <em>estimate</em> of each run — on a subscription that's quota, not money.
          </p>

          <div className="settings-subhead">🔭 Explorer (new project / Explore more)</div>
          <Field label="Model" error={errorFor("agents.explorer.model")}>
            {modelSelect(s.agents.explorer.model, (v) => setAgent("explorer", { model: v as ProjectSettings["agents"]["explorer"]["model"] }))}
          </Field>
          <Field label="Budget cap" error={errorFor("agents.explorer.budgetUsd")} hint="$1–50">
            <span className="muted">$</span>
            <input
              className="users-input settings-number"
              type="number"
              min={1}
              max={50}
              step={1}
              value={s.agents.explorer.budgetUsd}
              onChange={(e) => setAgent("explorer", { budgetUsd: Number(e.target.value) })}
            />
          </Field>
          <Field label="Default max new pages" error={errorFor("agents.explorer.defaultMaxNewPages")} hint="1–50">
            <input
              className="users-input settings-number"
              type="number"
              min={1}
              max={50}
              value={s.agents.explorer.defaultMaxNewPages}
              onChange={(e) => setAgent("explorer", { defaultMaxNewPages: Number(e.target.value) })}
            />
          </Field>

          <div className="settings-subhead">⛓ Linker (Link preconditions)</div>
          <Field label="Model" error={errorFor("agents.linker.model")}>
            {modelSelect(s.agents.linker.model, (v) => setAgent("linker", { model: v as ProjectSettings["agents"]["linker"]["model"] }))}
          </Field>
          <Field label="Budget cap" error={errorFor("agents.linker.budgetUsd")} hint="$0.5–20">
            <span className="muted">$</span>
            <input
              className="users-input settings-number"
              type="number"
              min={0.5}
              max={20}
              step={0.5}
              value={s.agents.linker.budgetUsd}
              onChange={(e) => setAgent("linker", { budgetUsd: Number(e.target.value) })}
            />
          </Field>

          <div className="settings-subhead">🩺 Triager (Triage failures)</div>
          <Field label="Model" error={errorFor("agents.triager.model")}>
            {modelSelect(s.agents.triager.model, (v) => setAgent("triager", { model: v as ProjectSettings["agents"]["triager"]["model"] }))}
          </Field>
          <Field label="Budget cap" error={errorFor("agents.triager.budgetUsd")} hint="$1–20">
            <span className="muted">$</span>
            <input
              className="users-input settings-number"
              type="number"
              min={1}
              max={20}
              step={0.5}
              value={s.agents.triager.budgetUsd}
              onChange={(e) => setAgent("triager", { budgetUsd: Number(e.target.value) })}
            />
          </Field>

          <div className="settings-subhead">✨ Designer (Design cases)</div>
          <Field label="Model" error={errorFor("agents.designer.model")}>
            {modelSelect(s.agents.designer.model, (v) => setAgent("designer", { model: v as ProjectSettings["agents"]["designer"]["model"] }))}
          </Field>
          <Field label="Budget cap" error={errorFor("agents.designer.budgetUsd")} hint="$1–30">
            <span className="muted">$</span>
            <input
              className="users-input settings-number"
              type="number"
              min={1}
              max={30}
              step={0.5}
              value={s.agents.designer.budgetUsd}
              onChange={(e) => setAgent("designer", { budgetUsd: Number(e.target.value) })}
            />
          </Field>

          <div className="settings-subhead">🗂 Organizer (features → use cases)</div>
          <Field label="Model" error={errorFor("agents.organizer.model")}>
            {modelSelect(s.agents.organizer.model, (v) => setAgent("organizer", { model: v as ProjectSettings["agents"]["organizer"]["model"] }))}
          </Field>
          <Field label="Budget cap" error={errorFor("agents.organizer.budgetUsd")} hint="$0.5–10 · text only, no browser">
            <span className="muted">$</span>
            <input
              className="users-input settings-number"
              type="number"
              min={0.5}
              max={10}
              step={0.5}
              value={s.agents.organizer.budgetUsd}
              onChange={(e) => setAgent("organizer", { budgetUsd: Number(e.target.value) })}
            />
          </Field>

          <div className="settings-subhead">📋 Analyst (requirements → acceptance criteria)</div>
          <Field label="Model" error={errorFor("agents.analyst.model")}>
            {modelSelect(s.agents.analyst.model, (v) => setAgent("analyst", { model: v as ProjectSettings["agents"]["analyst"]["model"] }))}
          </Field>
          <Field label="Budget cap" error={errorFor("agents.analyst.budgetUsd")} hint="$0.5–5 · text only, no browser">
            <span className="muted">$</span>
            <input
              className="users-input settings-number"
              type="number"
              min={0.5}
              max={5}
              step={0.5}
              value={s.agents.analyst.budgetUsd}
              onChange={(e) => setAgent("analyst", { budgetUsd: Number(e.target.value) })}
            />
          </Field>
        </section>

        {errors.some((e) => !e.path) && <div className="users-error">{errors.find((e) => !e.path)!.message}</div>}
        <div className="settings-actions">
          <button className="primary-button" onClick={save} disabled={saved === "saving"}>
            {saved === "saving" ? "Saving…" : "Save"}
          </button>
          <button
            className="link-button"
            onClick={() => {
              setDraft(load.defaults);
              setErrors([]);
              setSaved("idle");
            }}
          >
            Reset to defaults
          </button>
          {saved === "saved" && <span className="muted">Saved ✓</span>}
          {errors.length > 0 && <span className="users-error">Fix the highlighted fields before saving.</span>}
        </div>

        <DangerZone projectId={projectId} onDeleted={onBack} />
      </div>
    </div>
  );
}

/** Deletes the whole projects/<id>/ folder — map, users, credentials, sessions, tests and runs —
 *  so the site can be explored from scratch. Typed confirmation, since there's no undo. */
function DangerZone({ projectId, onDeleted }: { projectId: string; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: typed }),
    });
    setBusy(false);
    if (res.ok) return onDeleted();
    setError((await res.json().catch(() => ({}))).error ?? `${res.status}`);
  };

  return (
    <section className="users-card settings-section danger-zone">
      <strong>Danger zone</strong>
      <p className="muted">
        Delete this project: removes <code>projects/{projectId}/</code> entirely — the map, users, settings, credentials, saved sessions, generated
        tests and test runs. You can then create it again from scratch with + New project. This can't be undone.
      </p>
      <div className="settings-control">
        <input
          className="users-input"
          placeholder={`Type ${projectId} to confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label="Type the project id to confirm deletion"
        />
        <button className="primary-button danger-button" disabled={typed !== projectId || busy} onClick={remove}>
          {busy ? "Deleting…" : "Delete project"}
        </button>
      </div>
      {error && <div className="users-error">{error}</div>}
    </section>
  );
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={`settings-field${error ? " has-error" : ""}`}>
      <span className="settings-label">{label}</span>
      <div className="settings-control">
        {children}
        {hint && <span className="muted settings-note">{hint}</span>}
      </div>
      {error && <span className="users-error settings-field-error">{error}</span>}
    </div>
  );
}

function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select className="users-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
