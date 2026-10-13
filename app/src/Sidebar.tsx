import { useEffect, useState } from "react";
import type { Tab } from "./nav";
import { navigate } from "./nav";
import { Icon, type LucideIcon } from "./ui/icons";
import { cx } from "./ui/kit";

export interface SidebarCounts {
  /** Drafts + cases the map changed under. */
  cases: number;
  /** Open questions for the human. */
  states: number;
  /** Acceptance criteria failing or without a case, plus analyses to review. */
  requirements: number;
}

const ITEMS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "Home", icon: Icon.home },
  { id: "map", label: "Map", icon: Icon.map },
  { id: "cases", label: "Test cases", icon: Icon.cases },
  { id: "requirements", label: "Requirements", icon: Icon.requirements },
  { id: "states", label: "States & flows", icon: Icon.states },
  { id: "runs", label: "Runs", icon: Icon.runs },
  { id: "users", label: "Users", icon: Icon.users },
];

const STORAGE_KEY = "navmap.sidebar.collapsed";

/** Project navigation: where you are, what waits for you (counts), and the Assistant. */
export function Sidebar({
  projectId,
  host,
  tab,
  counts,
  testRunRunning,
  assistantOpen,
  agentRunning,
  onAssistant,
  onBack,
}: {
  projectId: string;
  host: string;
  tab: Tab;
  counts: SidebarCounts | null;
  testRunRunning: boolean;
  assistantOpen: boolean;
  /** Label of the agent running right now, if any. */
  agentRunning: string | null;
  onAssistant: () => void;
  onBack: () => void;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // private mode — the choice just isn't remembered
    }
  }, [collapsed]);

  const badge = (id: Tab) => (id === "cases" ? counts?.cases : id === "states" ? counts?.states : id === "requirements" ? counts?.requirements : undefined);

  const item = (id: Tab, label: string, IconCmp: LucideIcon) => {
    const n = badge(id);
    return (
      <button
        key={id}
        type="button"
        className={cx("sidebar-item", tab === id && "active")}
        onClick={() => navigate(projectId, id)}
        title={collapsed ? label : undefined}
        aria-current={tab === id ? "page" : undefined}
      >
        <IconCmp size={18} aria-hidden />
        {!collapsed && <span className="sidebar-label">{label}</span>}
        {id === "runs" && testRunRunning ? (
          <Icon.spinner size={14} className="ui-spin sidebar-running" aria-label="A test run is in progress" />
        ) : n ? (
          <span className={cx("sidebar-count", collapsed && "dot")} aria-label={`${n} waiting`}>
            {collapsed ? "" : n}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <nav className={cx("sidebar", collapsed && "collapsed")} aria-label="Project">
      <div className="sidebar-head">
        {!collapsed && (
          <button type="button" className="sidebar-back" onClick={onBack} title="All projects">
            <Icon.back size={14} aria-hidden /> All projects
          </button>
        )}
        {!collapsed && (
          <div className="sidebar-project" title={host}>
            {host.replace(/^www\./, "")}
          </div>
        )}
      </div>
      <div className="sidebar-items">{ITEMS.map((i) => item(i.id, i.label, i.icon))}</div>
      <div className="sidebar-spacer" />
      <div className="sidebar-items">
        <button type="button" className={cx("sidebar-item sidebar-assistant", assistantOpen && "active")} onClick={onAssistant} title={agentRunning ? `${agentRunning} is running` : "Assistant: explore, design, link, diagnose, organize"}>
          <Icon.assistant size={18} aria-hidden />
          {!collapsed && <span className="sidebar-label">Assistant</span>}
          {agentRunning && <span className="sidebar-live" aria-label={`${agentRunning} is running`} />}
        </button>
        {item("settings", "Settings", Icon.settings)}
        <button type="button" className="sidebar-item sidebar-collapse" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}>
          {collapsed ? <Icon.expandSidebar size={18} aria-hidden /> : <Icon.collapseSidebar size={18} aria-hidden />}
          {!collapsed && <span className="sidebar-label">Collapse</span>}
        </button>
      </div>
    </nav>
  );
}
