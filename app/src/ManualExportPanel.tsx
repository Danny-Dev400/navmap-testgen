import { useEffect, useState } from "react";
import type { CasesData } from "./casesClient";
import { Button, cx, DetailPanel, Field } from "./ui/kit";
import { Icon, type LucideIcon } from "./ui/icons";

export type ManualFormat = "markdown" | "testrail" | "xray" | "zephyr";

const FORMATS: { id: ManualFormat; title: string; text: string; icon: LucideIcon }[] = [
  { id: "markdown", title: "Markdown document", text: "To read, share or paste in a ticket or wiki: feature → use case → case, with a step table.", icon: Icon.file },
  { id: "testrail", title: "CSV for TestRail", text: "Import with \"Test cases use multiple rows\", ID as the column that starts a new case.", icon: Icon.cases },
  { id: "xray", title: "CSV for Xray (Jira)", text: "Test Case Importer: rows with the same Issue Id form one Manual test.", icon: Icon.cases },
  { id: "zephyr", title: "CSV for Zephyr Scale", text: "One row per step, the test's fields on its first row — check the first import.", icon: Icon.cases },
];

const FORMAT_KEY = "navmap.export.format";

/** GET /api/projects/<id>/export/manual — scope: the whole project's approved cases, one feature's,
 *  or one case (any status). */
export function manualExportUrl(
  projectId: string,
  opts: { format: ManualFormat; feature?: string; suite?: string; caseId?: string; caseIds?: string[]; download?: boolean },
): string {
  const q = new URLSearchParams({ format: opts.format });
  if (opts.feature) q.set("feature", opts.feature);
  if (opts.suite) q.set("suite", opts.suite);
  if (opts.caseId) q.set("case", opts.caseId);
  if (opts.caseIds?.length) q.set("cases", opts.caseIds.join(","));
  if (opts.download) q.set("download", "1");
  return `/api/projects/${encodeURIComponent(projectId)}/export/manual?${q}`;
}

/** Export test cases as manual test cases: pick what (the project's, a feature's or a suite's
 *  approved cases, or the cases selected in the list) and the format, see exactly what you'll get,
 *  then download or copy it. */
export function ManualExportPanel({
  projectId,
  data,
  initialFeatureId,
  initialSuiteId,
  caseIds,
  onClose,
}: {
  projectId: string;
  data: CasesData;
  initialFeatureId?: string;
  initialSuiteId?: string;
  /** The list's checkbox selection (offered as "Selected (N)", picked first when given). */
  caseIds?: string[];
  onClose: () => void;
}) {
  // "" = whole project, "f:<id>" a feature, "s:<id>" a suite, "sel" the selection.
  const [scope, setScope] = useState(caseIds?.length ? "sel" : initialSuiteId ? `s:${initialSuiteId}` : initialFeatureId ? `f:${initialFeatureId}` : "");
  const [format, setFormat] = useState<ManualFormat>(() => {
    try {
      const saved = localStorage.getItem(FORMAT_KEY);
      return FORMATS.some((f) => f.id === saved) ? (saved as ManualFormat) : "markdown";
    } catch {
      return "markdown";
    }
  });
  const [preview, setPreview] = useState<{ text: string; count: number } | { error: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const pick = (f: ManualFormat) => {
    setFormat(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      // storage blocked: the choice lasts this session
    }
  };

  const target = {
    feature: scope.startsWith("f:") ? scope.slice(2) : undefined,
    suite: scope.startsWith("s:") ? scope.slice(2) : undefined,
    caseIds: scope === "sel" ? caseIds : undefined,
  };
  const url = manualExportUrl(projectId, { format, ...target });
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setCopied(false);
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
        const text = await res.text();
        if (!cancelled) setPreview({ text, count: Number(res.headers.get("X-Manual-Count") ?? 0) });
      })
      .catch((err) => !cancelled && setPreview({ error: String(err.message ?? err) }));
    return () => {
      cancelled = true;
    };
  }, [url]);

  const approvedAll = data.cases.filter((c) => c.status === "approved").length;
  const features = data.organization.features.map((f) => ({ id: f.id, title: f.title, approved: f.useCases.reduce((n, u) => n + u.approved, 0) }));
  const ready = preview && "text" in preview ? preview : null;
  const copy = async () => {
    if (!ready) return;
    await navigator.clipboard.writeText(ready.text);
    setCopied(true);
  };

  return (
    <DetailPanel
      eyebrow="Export"
      title="Manual test cases"
      onClose={onClose}
      footer={
        <>
          <a className={cx("ui-btn ui-btn-primary ui-btn-md", (!ready || ready.count === 0) && "is-disabled")} href={manualExportUrl(projectId, { format, ...target, download: true })} download aria-disabled={!ready || ready.count === 0}>
            <Icon.download size={16} aria-hidden />
            <span>Download {format === "markdown" ? ".md" : ".csv"}</span>
          </a>
          <Button icon={copied ? Icon.check : Icon.copy} disabled={!ready || ready.count === 0} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <span className="ui-flex-spacer" />
          {ready && (
            <span className="export-count">
              {ready.count} case{ready.count === 1 ? "" : "s"}
            </span>
          )}
        </>
      }
    >
      <p className="export-lead">
        Test cases as steps a person can follow: preconditions, where to start, what to do, the data to use and what to check. Built from the map and the cases — passwords never appear, a sign-in step only names the user.
      </p>

      <Field label="Cases">
        <select className="users-input" value={scope} onChange={(e) => setScope(e.target.value)}>
          {caseIds?.length ? <option value="sel">Selected in the list ({caseIds.length}, any status)</option> : null}
          <option value="">Whole project ({approvedAll} approved)</option>
          {features.length > 0 && (
            <optgroup label="Features">
              {features.map((f) => (
                <option key={f.id} value={`f:${f.id}`}>
                  {f.title} ({f.approved} approved)
                </option>
              ))}
            </optgroup>
          )}
          {data.suites.list.length > 0 && (
            <optgroup label="Suites">
              {data.suites.list.map((st) => (
                <option key={st.id} value={`s:${st.id}`}>
                  {st.name} ({st.approved} approved)
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>

      <div className="export-formats" role="radiogroup" aria-label="Format">
        {FORMATS.map((f) => {
          const C = f.icon;
          return (
            <button key={f.id} type="button" role="radio" aria-checked={format === f.id} className={cx("export-format", format === f.id && "selected")} onClick={() => pick(f.id)}>
              <C size={18} aria-hidden className="export-format-icon" />
              <span className="export-format-text">
                <span className="export-format-title">{f.title}</span>
                <span className="export-format-desc">{f.text}</span>
              </span>
              {format === f.id && <Icon.check size={16} aria-hidden className="export-format-check" />}
            </button>
          );
        })}
      </div>

      <h3 className="export-preview-title">Preview</h3>
      {preview === null ? (
        <p className="muted">Building…</p>
      ) : "error" in preview ? (
        <p className="users-error">Could not build the export: {preview.error}</p>
      ) : preview.count === 0 ? (
        <p className="muted">No approved cases here yet — approve some in the list first.</p>
      ) : (
        <pre className="export-preview">{preview.text}</pre>
      )}
    </DetailPanel>
  );
}
