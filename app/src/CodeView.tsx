import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import "highlight.js/styles/github.css";

hljs.registerLanguage("typescript", typescript);

interface CodeBlock {
  file: string;
  line?: number;
  title: string;
  code: string;
}

/** Read-only, syntax-highlighted TypeScript. The code comes from our own generated files, and
 *  highlight.js escapes it before adding markup — so the HTML is safe to inject. */
export function HighlightedCode({ code }: { code: string }) {
  const html = useMemo(() => hljs.highlight(code, { language: "typescript" }).value, [code]);
  return (
    <pre className="code-view-pre">
      <code className="hljs language-typescript" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

/** A test case's generated code: the test itself, then every page-object/component method it calls
 *  (setup chain included), each with its file. "Whole file" swaps a block for its full source. A
 *  draft has no generated test yet: `preview` shows the test it would get once approved. */
export function CodeView({ projectId, caseId, preview }: { projectId: string; caseId: string; preview: boolean }) {
  const [blocks, setBlocks] = useState<CodeBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wholeFile, setWholeFile] = useState<{ file: string; code: string } | null>(null);

  useEffect(() => {
    setBlocks(null);
    setError(null);
    setWholeFile(null);
    const url = preview
      ? `/api/projects/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseId)}/preview`
      : `/api/projects/${encodeURIComponent(projectId)}/code/case/${encodeURIComponent(caseId)}`;
    fetch(url)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `${res.status}`);
        setBlocks([
          { file: body.spec.file ?? "", line: body.spec.line ?? undefined, title: preview ? "Test (preview — not in the suite until approved)" : "Test", code: body.spec.code },
          ...body.methods.map((m: { file: string; className: string; name: string; code: string }) => ({
            file: m.file,
            title: `${m.className}.${m.name}()`,
            code: m.code,
          })),
        ]);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [projectId, caseId, preview]);

  const openFile = async (file: string) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/code/file?path=${encodeURIComponent(file)}`);
    const body = await res.json();
    if (res.ok) setWholeFile(body);
    else setError(body.error ?? `${res.status}`);
  };

  if (error) return <p className="muted">{error}</p>;
  if (!blocks) return <p className="muted">Loading code&hellip;</p>;

  if (wholeFile) {
    return (
      <div className="code-view">
        <div className="code-view-block-header">
          <button className="link-button" onClick={() => setWholeFile(null)}>
            &larr; Back to the test
          </button>
          <code className="muted">{wholeFile.file}</code>
        </div>
        <HighlightedCode code={wholeFile.code} />
      </div>
    );
  }

  return (
    <div className="code-view">
      {blocks.map((b) => (
        <section key={`${b.file}:${b.title}`} className="code-view-block">
          <div className="code-view-block-header">
            <strong>{b.title}</strong>
            <code className="muted">
              {b.file}
              {b.line ? `:${b.line}` : ""}
            </code>
            {b.file && (
              <button className="link-button" onClick={() => openFile(b.file)}>
                Whole file
              </button>
            )}
          </div>
          <HighlightedCode code={b.code} />
        </section>
      ))}
    </div>
  );
}
