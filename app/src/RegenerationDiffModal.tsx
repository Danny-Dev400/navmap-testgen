import { useEffect, useState } from "react";
import { DetailPanel } from "./ui/kit";

interface FileDiff {
  file: string;
  status: "added" | "removed" | "modified";
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
}

interface Regeneration {
  at: string;
  files: FileDiff[];
  tests: { added: string[]; removed: string[]; modified: string[] };
}

/** What the last "Regenerate" changed in the generated code: changed tests by name, then a unified
 *  diff per file. */
export function RegenerationDiffModal({ projectId, testTitle, onClose }: { projectId: string; testTitle: (caseId: string) => string; onClose: () => void }) {
  const [data, setData] = useState<Regeneration | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/projects/${encodeURIComponent(projectId)}/coverage/regeneration`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `${res.status}`);
        setData(body);
      })
      .catch((err) => setError(String(err instanceof Error ? err.message : err)));
  }, [projectId]);

  return (
    <DetailPanel eyebrow="Generated code" title="Last code changes" onClose={onClose}>
        {error && <p className="muted">{error}</p>}
        {data && (
          <>
            <p className="muted">
              {new Date(data.at).toLocaleString()} &middot; {data.files.length} file{data.files.length === 1 ? "" : "s"} changed
            </p>
            {data.files.length === 0 && <p>Nothing changed — the generated code is identical to the previous version.</p>}
            {(["added", "modified", "removed"] as const).map((kind) =>
              data.tests[kind].length > 0 ? (
                <div key={kind} className="diff-tests">
                  <strong>
                    Tests {kind} ({data.tests[kind].length}):
                  </strong>{" "}
                  {data.tests[kind].map(testTitle).join(", ")}
                </div>
              ) : null,
            )}
            {data.files.map((f) => (
              <section key={f.file} className="diff-file">
                <div className="diff-file-header">
                  <code>{f.file}</code> <span className={`diff-badge diff-badge-${f.status}`}>{f.status}</span>
                </div>
                <pre className="diff-pre">
                  {f.hunks.map((h, i) => (
                    <span key={i}>
                      <span className="diff-hunk">
                        @@ -{h.oldStart} +{h.newStart} @@
                        {"\n"}
                      </span>
                      {h.lines.map((l, j) => (
                        <span key={j} className={l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : undefined}>
                          {l}
                          {"\n"}
                        </span>
                      ))}
                    </span>
                  ))}
                </pre>
              </section>
            ))}
          </>
        )}
    </DetailPanel>
  );
}
