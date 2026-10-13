import { createContext, useContext } from "react";

export type AssistantSection = "explore" | "design" | "link" | "triage" | "organize";

export interface AssistantPrefill {
  pageId?: string;
  /** Design cases that prove this use case (drafts are filed under it). */
  useCaseId?: string;
  /** Design cases for this requirement's uncovered acceptance criteria (drafts are linked to them). */
  requirementId?: string;
  request?: string;
}

export interface AssistantApi {
  /** Opens the assistant drawer on a section, optionally prefilled (e.g. "design this journey"). */
  open: (section: AssistantSection, prefill?: AssistantPrefill) => void;
}

export const AssistantContext = createContext<AssistantApi>({ open: () => undefined });

export const useAssistant = () => useContext(AssistantContext);

/** The shell's light poll: /api/projects/<id>/agents. */
export interface AgentsStatus {
  agents: Record<AssistantSection, { state: string; meta?: Record<string, unknown>; costUsd?: number; label?: string } | null>;
  running: AssistantSection | null;
  testRunRunning: boolean;
}

export const SECTION_LABEL: Record<AssistantSection, string> = {
  explore: "Explore",
  design: "Design cases",
  link: "Link preconditions",
  triage: "Diagnose",
  organize: "Organize",
};
