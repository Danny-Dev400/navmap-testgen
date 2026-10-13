import { useState } from "react";
import type { ExplorationRun } from "../../src/types";
import type { MindMapNodeData } from "./graph";
import { Lightbox } from "./Lightbox";

interface SidePanelProps {
  data: MindMapNodeData | null;
  run: ExplorationRun;
  onClose: () => void;
}

export function SidePanel({ data, run, onClose }: SidePanelProps) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  if (!data) {
    return (
      <aside className="side-panel side-panel-empty">
        <p className="muted">Click a node to see its details.</p>
      </aside>
    );
  }

  const { step, workflowTitles } = data;
  const derivedAssertions = run.testPlans.flatMap((plan) =>
    plan.steps
      .filter((s) => s.sourceStepId === step.id)
      .map((s) => ({ planTitle: plan.title, step: s })),
  );

  const mark =
    step.matchedExpectation === true ? (
      <span className="mark-pass">&#10003; matched expectation</span>
    ) : step.matchedExpectation === false ? (
      <span className="mark-fail">&#10007; did not match expectation</span>
    ) : null;

  return (
    <aside className="side-panel">
      <button className="side-panel-close" onClick={onClose} aria-label="Close">
        &times;
      </button>
      <h2>{step.action}</h2>
      <p className="side-panel-target">{step.target}</p>
      {step.inputValue && (
        <p>
          <strong>Input:</strong> {step.inputValue}
        </p>
      )}
      {step.expectedResult && (
        <p>
          <strong>Expected:</strong> {step.expectedResult}
        </p>
      )}
      <p>
        <strong>Observed:</strong> {step.observedResult}
      </p>
      {mark && <p>{mark}</p>}
      {step.url && (
        <p className="muted side-panel-url">{step.url}</p>
      )}
      {step.screenshot && (
        <img
          className="side-panel-screenshot"
          src={step.screenshot}
          alt="Step screenshot"
          onClick={() => setLightboxSrc(step.screenshot!)}
        />
      )}

      <h3>Workflows using this step</h3>
      {workflowTitles.length === 0 ? (
        <p className="muted">None</p>
      ) : (
        <ul>
          {workflowTitles.map((title) => (
            <li key={title}>{title}</li>
          ))}
        </ul>
      )}

      <h3>Assertions derived from this step</h3>
      {derivedAssertions.length === 0 ? (
        <p className="muted">None</p>
      ) : (
        <ul>
          {derivedAssertions.map(({ planTitle, step: assertionStep }) => (
            <li key={`${planTitle}-${assertionStep.order}`}>
              <code>{assertionStep.assertionType}</code>: {assertionStep.expectedAssertion}
              <div className="muted">from test plan "{planTitle}"</div>
            </li>
          ))}
        </ul>
      )}
      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </aside>
  );
}
