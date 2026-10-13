import { z } from "zod/v4";

export const StepNodeSchema = z.object({
  id: z.string(),
  action: z.string(),
  target: z.string(),
  inputValue: z.string().optional(),
  expectedResult: z.string().optional(),
  observedResult: z.string(),
  matchedExpectation: z.boolean().optional(),
  screenshot: z.string().optional(),
  url: z.string().optional(),
});
export type StepNode = z.infer<typeof StepNodeSchema>;

export const WorkflowSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["success", "partial", "failed"]),
  stepIds: z.array(z.string()),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export const AssertionTypeSchema = z.enum([
  "url_matches",
  "text_visible",
  "element_visible",
  "value_equals",
  "status_ok",
]);
export type AssertionType = z.infer<typeof AssertionTypeSchema>;

export const TestPlanStepSchema = z.object({
  order: z.number(),
  action: z.string(),
  target: z.string(),
  inputData: z.string().optional(),
  expectedAssertion: z.string(),
  assertionType: AssertionTypeSchema,
  // Set for navmap coverage when the postcondition has a structured check — what the generated
  // test really asserts (e.g. "hidden" for something that disappears).
  checkKind: z.enum(["visible", "hidden", "has_text", "url", "count"]).optional(),
  sourceStepId: z.string().optional(),
});
export type TestPlanStep = z.infer<typeof TestPlanStepSchema>;

export const TestPlanSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  title: z.string(),
  preconditions: z.array(z.string()),
  steps: z.array(TestPlanStepSchema),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

export const ExplorationRunSchema = z.object({
  id: z.string(),
  targetUrl: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  summary: z.string(),
  stepNodes: z.record(z.string(), StepNodeSchema),
  workflows: z.array(WorkflowSchema),
  testPlans: z.array(TestPlanSchema),
});
export type ExplorationRun = z.infer<typeof ExplorationRunSchema>;
