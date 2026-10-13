import type { ExplorationRun, StepNode, TestPlan, Workflow } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_COLORS: Record<Workflow["status"], string> = {
  success: "#1a7f37",
  partial: "#9a6700",
  failed: "#cf222e",
};

function renderThumbnail(dataUri: string | undefined): string {
  if (!dataUri) return "";
  return `<a class="thumb-link" href="${dataUri}" target="_blank"><img class="thumb" src="${dataUri}" alt="Step screenshot" /></a>`;
}

function renderWorkflowCard(
  workflow: Workflow,
  stepNodes: Record<string, StepNode>,
  resolveScreenshot: (path: string) => string | undefined,
): string {
  const color = STATUS_COLORS[workflow.status];
  const steps = workflow.stepIds
    .map((stepId, i) => {
      const step = stepNodes[stepId];
      if (!step) return `<li><span class="step-index">${i + 1}.</span><span class="muted">(missing step node: ${escapeHtml(stepId)})</span></li>`;
      const expectationMark =
        step.matchedExpectation === true ? '<span class="mark-pass">&#10003;</span>' : step.matchedExpectation === false ? '<span class="mark-fail">&#10007;</span>' : "";
      return `
        <li>
          <span class="step-index">${i + 1}.</span>
          <strong>${escapeHtml(step.action)}</strong> ${escapeHtml(step.target)}
          ${step.inputValue ? `<span class="muted">(input: ${escapeHtml(step.inputValue)})</span>` : ""}
          ${step.expectedResult ? `<div class="expected">Expected: ${escapeHtml(step.expectedResult)} ${expectationMark}</div>` : ""}
          <div class="observed">&rarr; ${escapeHtml(step.observedResult)}</div>
          ${step.url ? `<div class="url">${escapeHtml(step.url)}</div>` : ""}
          ${step.screenshot ? renderThumbnail(resolveScreenshot(step.screenshot)) : ""}
        </li>`;
    })
    .join("");

  return `
    <article class="card" id="workflow-${escapeHtml(workflow.id)}">
      <header class="card-header">
        <h3>${escapeHtml(workflow.title)}</h3>
        <span class="badge" style="background:${color}">${workflow.status}</span>
      </header>
      <ol class="steps">${steps}</ol>
    </article>`;
}

function renderTestPlanCard(
  plan: TestPlan,
  stepNodes: Record<string, StepNode>,
  resolveScreenshot: (path: string) => string | undefined,
): string {
  const preconditions = plan.preconditions.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
  const rows = plan.steps
    .map((step) => {
      const sourceStep = step.sourceStepId ? stepNodes[step.sourceStepId] : undefined;
      return `
        <tr>
          <td>${step.order}</td>
          <td>${escapeHtml(step.action)}</td>
          <td>${escapeHtml(step.target)}</td>
          <td>${step.inputData ? escapeHtml(step.inputData) : ""}</td>
          <td><code>${escapeHtml(step.assertionType)}</code></td>
          <td>${escapeHtml(step.expectedAssertion)}</td>
          <td>${sourceStep?.screenshot ? renderThumbnail(resolveScreenshot(sourceStep.screenshot)) : ""}</td>
        </tr>`;
    })
    .join("");

  return `
    <article class="card">
      <header class="card-header">
        <h3>${escapeHtml(plan.title)}</h3>
        <a class="muted" href="#workflow-${escapeHtml(plan.workflowId)}">source workflow &#8594;</a>
      </header>
      ${preconditions ? `<p class="muted">Preconditions:</p><ul>${preconditions}</ul>` : ""}
      <table>
        <thead>
          <tr><th>#</th><th>Action</th><th>Target</th><th>Input</th><th>Assertion type</th><th>Expected</th><th>Screenshot</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </article>`;
}

export function buildReportHtml(
  run: ExplorationRun,
  resolveScreenshot: (path: string) => string | undefined = () => undefined,
): string {
  const workflowCards =
    run.workflows.map((w) => renderWorkflowCard(w, run.stepNodes, resolveScreenshot)).join("\n") ||
    "<p class=\"muted\">No workflows recorded.</p>";
  const testPlanCards =
    run.testPlans.map((p) => renderTestPlanCard(p, run.stepNodes, resolveScreenshot)).join("\n") ||
    "<p class=\"muted\">No test plans generated.</p>";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Exploration Report — ${escapeHtml(run.targetUrl)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, Segoe UI, Roboto, sans-serif;
    max-width: 920px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
    line-height: 1.5;
    background: Canvas;
    color: CanvasText;
  }
  header.run-header { margin-bottom: 2.5rem; }
  header.run-header h1 { margin-bottom: 0.25rem; font-size: 1.4rem; }
  .muted { color: color-mix(in srgb, CanvasText 55%, Canvas); font-size: 0.9em; }
  .meta { font-size: 0.9rem; margin: 0.25rem 0; }
  section { margin-bottom: 2.5rem; }
  section > h2 { border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, Canvas); padding-bottom: 0.4rem; }
  .card {
    border: 1px solid color-mix(in srgb, CanvasText 15%, Canvas);
    border-radius: 10px;
    padding: 1rem 1.25rem;
    margin-bottom: 1.25rem;
  }
  .card-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .card-header h3 { margin: 0; }
  .badge {
    color: white;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
  }
  .steps { padding-left: 1.1rem; }
  .steps li { margin-bottom: 0.6rem; }
  .step-index { color: color-mix(in srgb, CanvasText 45%, Canvas); margin-right: 0.15rem; }
  .expected { margin-left: 1.4rem; font-size: 0.92em; color: color-mix(in srgb, CanvasText 70%, Canvas); }
  .observed { margin-left: 1.4rem; font-size: 0.92em; }
  .url { margin-left: 1.4rem; font-size: 0.8em; color: color-mix(in srgb, CanvasText 50%, Canvas); }
  .mark-pass { color: #1a7f37; font-weight: 700; }
  .mark-fail { color: #cf222e; font-weight: 700; }
  .thumb-link { display: inline-block; margin: 0.4rem 0 0 1.4rem; }
  .thumb {
    display: block;
    max-width: 160px;
    max-height: 120px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, CanvasText 15%, Canvas);
    cursor: zoom-in;
  }
  table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); vertical-align: top; }
  code { font-size: 0.85em; }
</style>
</head>
<body>
  <header class="run-header">
    <h1>Exploration Report</h1>
    <p class="meta"><strong>Target:</strong> ${escapeHtml(run.targetUrl)}</p>
    <p class="meta"><strong>Run:</strong> ${escapeHtml(run.id)} &middot; ${escapeHtml(run.startedAt)} &rarr; ${escapeHtml(run.finishedAt)}</p>
    <p>${escapeHtml(run.summary)}</p>
  </header>

  <section>
    <h2>Discovered Workflows (${run.workflows.length})</h2>
    ${workflowCards}
  </section>

  <section>
    <h2>Generated Test Plans (${run.testPlans.length})</h2>
    ${testPlanCards}
  </section>
</body>
</html>`;
}
