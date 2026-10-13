import { useEffect, useRef, useState } from "react";
import { cancelRun, fetchRuns, type LiveRun } from "./runsClient";

/** The project's current test run, live: polls while it runs, shows the (already scrubbed) list
 *  reporter output, and calls onFinished once when it ends. Renders nothing when no run has
 *  happened since the dev server started. `refreshKey` re-checks right after a run is started. */
export function RunPanel({ projectId, refreshKey, onFinished }: { projectId: string; refreshKey: number; onFinished?: (run: LiveRun) => void }) {
  const [run, setRun] = useState<LiveRun | null>(null);
  const wasRunning = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const { current } = await fetchRuns(projectId).catch(() => ({ current: null }));
      if (cancelled) return;
      setRun(current);
      if (current?.state === "running") {
        wasRunning.current = true;
        timer = setTimeout(poll, 1500);
      } else if (current && wasRunning.current) {
        wasRunning.current = false;
        onFinished?.(current);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refreshKey]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [run?.log.length]);

  if (!run) return null;
  const running = run.state === "running";
  return (
    <div className={`run-panel run-panel-${run.state}`}>
      <div className="run-panel-header">
        <strong>{running ? "Running…" : run.state === "finished" ? "Last run finished" : `Last run ${run.state}`}</strong>
        <span className="muted">{run.scope.label}</span>
        {running && (
          <button className="link-button users-danger" onClick={() => cancelRun(projectId, run.runId)}>
            Cancel
          </button>
        )}
      </div>
      <pre ref={logRef} className="run-panel-log">
        {run.log.join("\n")}
      </pre>
    </div>
  );
}
