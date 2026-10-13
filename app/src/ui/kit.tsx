import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from "react";
import { Icon, type LucideIcon } from "./icons";

/* A small, dependency-free component kit on top of tokens.css. Every screen builds from these, so
   buttons, badges, headers and panels look and behave the same everywhere. */

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// ---- buttons ----

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  icon: IconCmp,
  iconRight: IconRight,
  loading,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md"; icon?: LucideIcon; iconRight?: LucideIcon; loading?: boolean }) {
  const s = size === "sm" ? 14 : 16;
  return (
    <button type={type} className={cx("ui-btn", `ui-btn-${variant}`, `ui-btn-${size}`, className)} {...rest} disabled={rest.disabled || loading}>
      {loading ? <Icon.spinner size={s} className="ui-spin" aria-hidden /> : IconCmp ? <IconCmp size={s} aria-hidden /> : null}
      {children !== undefined && children !== null && children !== false && <span>{children}</span>}
      {IconRight && <IconRight size={s} aria-hidden />}
    </button>
  );
}

export function IconButton({
  icon: IconCmp,
  label,
  size = "md",
  className,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; size?: "sm" | "md"; active?: boolean }) {
  return (
    <button type="button" className={cx("ui-icon-btn", `ui-icon-btn-${size}`, active && "active", className)} title={label} aria-label={label} {...rest}>
      <IconCmp size={size === "sm" ? 14 : 16} aria-hidden />
    </button>
  );
}

// ---- badges & status ----

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "ai";

export function Badge({ tone = "neutral", icon: IconCmp, children, title, className }: { tone?: Tone; icon?: LucideIcon; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={cx("ui-badge", `ui-badge-${tone}`, className)} title={title}>
      {IconCmp && <IconCmp size={12} aria-hidden />}
      {children}
    </span>
  );
}

export type Status = "passed" | "failed" | "flaky" | "fixme" | "draft" | "never" | "needs_review" | "rejected" | "running" | "skipped";

const STATUS_ICON: Record<Status, { icon: LucideIcon; tone: string; label: string }> = {
  passed: { icon: Icon.passed, tone: "success", label: "Passed" },
  failed: { icon: Icon.failed, tone: "danger", label: "Failed" },
  flaky: { icon: Icon.flaky, tone: "warning", label: "Flaky" },
  fixme: { icon: Icon.fixme, tone: "muted", label: "Can't run yet (fixme)" },
  skipped: { icon: Icon.fixme, tone: "muted", label: "Skipped" },
  draft: { icon: Icon.draft, tone: "accent", label: "Draft" },
  never: { icon: Icon.never, tone: "muted", label: "Never run" },
  needs_review: { icon: Icon.warning, tone: "warning", label: "Needs review" },
  rejected: { icon: Icon.rejected, tone: "muted", label: "Rejected" },
  running: { icon: Icon.spinner, tone: "accent", label: "Running" },
};

/** One glyph for "where does this stand": passed, failed, fixme, draft, never run… */
export function StatusIcon({ status, size = 16, title }: { status: Status; size?: number; title?: string }) {
  const s = STATUS_ICON[status];
  const C = s.icon;
  return (
    <span className={cx("ui-status", `ui-status-${s.tone}`)} title={title ?? s.label} aria-label={title ?? s.label} role="img">
      <C size={size} className={status === "running" ? "ui-spin" : undefined} aria-hidden />
    </span>
  );
}

// ---- layout ----

/** The top of every page: a clear title, one meta line, actions on the right, optional toolbar. */
export function PageHeader({ title, meta, actions, children, icon: IconCmp }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; children?: ReactNode; icon?: LucideIcon }) {
  return (
    <header className="ui-page-header">
      <div className="ui-page-header-row">
        <div className="ui-page-header-text">
          <h1>
            {IconCmp && <IconCmp size={22} aria-hidden className="ui-page-header-icon" />}
            {title}
          </h1>
          {meta && <div className="ui-page-meta">{meta}</div>}
        </div>
        {actions && <div className="ui-page-actions">{actions}</div>}
      </div>
      {children && <div className="ui-page-toolbar">{children}</div>}
    </header>
  );
}

export function Section({
  title,
  count,
  actions,
  children,
  collapsible,
  defaultOpen = true,
  icon: IconCmp,
  className,
  help,
}: {
  title: ReactNode;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  icon?: LucideIcon;
  className?: string;
  help?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const heading = (
    <>
      {collapsible && (open ? <Icon.chevronDown size={16} aria-hidden /> : <Icon.chevronRight size={16} aria-hidden />)}
      {IconCmp && <IconCmp size={16} aria-hidden className="ui-section-icon" />}
      <span>{title}</span>
      {count !== undefined && <span className="ui-section-count">{count}</span>}
    </>
  );
  return (
    <section className={cx("ui-section", className)}>
      <div className="ui-section-head">
        {collapsible ? (
          <button type="button" className="ui-section-title ui-section-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {heading}
          </button>
        ) : (
          <h2 className="ui-section-title">{heading}</h2>
        )}
        {help}
        {actions && <div className="ui-section-actions">{actions}</div>}
      </div>
      {(!collapsible || open) && children}
    </section>
  );
}

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cx("ui-card", padded && "ui-card-padded", className)}>{children}</div>;
}

const CALLOUT_ICON: Record<"info" | "warning" | "danger" | "ai" | "success", LucideIcon> = {
  info: Icon.info,
  warning: Icon.warning,
  danger: Icon.failed,
  ai: Icon.ai,
  success: Icon.passed,
};

/** A message that needs attention (a proposal waiting, why a case can't run, an error). */
export function Callout({
  tone = "info",
  title,
  children,
  actions,
  icon,
  className,
}: {
  tone?: "info" | "warning" | "danger" | "ai" | "success";
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  const IconCmp = icon ?? CALLOUT_ICON[tone];
  return (
    <div className={cx("ui-callout", `ui-callout-${tone}`, className)} role={tone === "danger" ? "alert" : undefined}>
      <IconCmp size={18} className="ui-callout-icon" aria-hidden />
      <div className="ui-callout-body">
        {title && <div className="ui-callout-title">{title}</div>}
        {children && <div className="ui-callout-text">{children}</div>}
      </div>
      {actions && <div className="ui-callout-actions">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: IconCmp = Icon.inbox, title, children, actions }: { icon?: LucideIcon; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ui-empty">
      <IconCmp size={28} aria-hidden className="ui-empty-icon" />
      <div className="ui-empty-title">{title}</div>
      {children && <div className="ui-empty-text">{children}</div>}
      {actions && <div className="ui-empty-actions">{actions}</div>}
    </div>
  );
}

// ---- menus & tabs ----

/** Where a popover fits: it opens below and toward the side it's anchored to, and flips up (or to
 *  the other side) when it would leave the window — e.g. a menu in a bar pinned to the bottom. */
export function usePopoverFit(open: boolean, ref: RefObject<HTMLElement | null>): { up: boolean; flipX: boolean } {
  const [fit, setFit] = useState({ up: false, flipX: false });
  useLayoutEffect(() => {
    if (!open) return setFit({ up: false, flipX: false });
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    setFit({
      up: r.bottom > window.innerHeight - margin && r.top - r.height - 8 > margin,
      flipX: r.right > window.innerWidth - margin || r.left < margin,
    });
  }, [open, ref]);
  return fit;
}

export interface MenuItem {
  label: ReactNode;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/** The "⋯" overflow menu for actions you don't need every time. */
export function Menu({ items, label = "More actions", icon = Icon.more, size = "md", align = "right" }: { items: (MenuItem | false | null | undefined)[]; label?: string; icon?: LucideIcon; size?: "sm" | "md"; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const fit = usePopoverFit(open, popRef);
  const list = items.filter((i): i is MenuItem => !!i);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // preventDefault so the side panel the menu sits in doesn't close too.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (list.length === 0) return null;
  return (
    <div className="ui-menu" ref={ref}>
      <IconButton icon={icon} label={label} size={size} active={open} aria-haspopup="menu" aria-expanded={open} onClick={(e) => (e.stopPropagation(), setOpen((o) => !o))} />
      {open && (
        <div ref={popRef} className={cx("ui-menu-popover", `ui-menu-${fit.flipX ? (align === "right" ? "left" : "right") : align}`, fit.up && "ui-pop-up")} role="menu">
          {list.map((item, i) => {
            const C = item.icon;
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={cx("ui-menu-item", item.danger && "danger")}
                disabled={item.disabled}
                title={item.hint}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {C ? <C size={15} aria-hidden /> : <span className="ui-menu-noicon" />}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, size = "md" }: { options: { id: T; label: ReactNode; icon?: LucideIcon; count?: number }[]; value: T; onChange: (id: T) => void; size?: "sm" | "md" }) {
  return (
    <div className={cx("ui-segmented", `ui-segmented-${size}`)} role="tablist">
      {options.map((o) => {
        const C = o.icon;
        return (
          <button key={o.id} type="button" role="tab" aria-selected={o.id === value} className={o.id === value ? "active" : ""} onClick={() => onChange(o.id)}>
            {C && <C size={14} aria-hidden />}
            {o.label}
            {o.count !== undefined && o.count > 0 && <span className="ui-segmented-count">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---- forms ----

export function Field({ label, hint, error, children, inline }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; inline?: boolean }) {
  const id = useId();
  return (
    <div className={cx("ui-field", inline && "ui-field-inline")}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="ui-field-control" id={id}>
        {children}
        {hint && <div className="ui-field-hint">{hint}</div>}
        {error && <div className="ui-field-error">{error}</div>}
      </div>
    </div>
  );
}

// ---- list + detail ----

/** The list on the left stays visible; the detail of what you picked opens on the right. On a
 *  narrow window the detail covers the list instead. */
export function SplitView({ list, detail, wide }: { list: ReactNode; detail: ReactNode | null; wide?: boolean }) {
  return (
    <div className={cx("ui-split", detail ? "has-detail" : "", wide && "wide")}>
      <div className="ui-split-list">{list}</div>
      {detail && <div className="ui-split-detail">{detail}</div>}
    </div>
  );
}

export function DetailPanel({
  title,
  eyebrow,
  badges,
  actions,
  menu,
  onClose,
  expanded,
  onToggleExpand,
  footer,
  children,
}: {
  title: ReactNode;
  /** A small line above the title (e.g. "Test case", "State"). */
  eyebrow?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  menu?: ReactNode;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the panel — unless something inside (a menu, a popover, an input) handles it first.
      if (e.key === "Escape" && !e.defaultPrevented && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside className="ui-detail" aria-label="Details">
      <div className="ui-detail-head">
        <div className="ui-detail-titles">
          {eyebrow && <div className="ui-detail-eyebrow">{eyebrow}</div>}
          <h2 className="ui-detail-title">{title}</h2>
          {badges && <div className="ui-detail-badges">{badges}</div>}
        </div>
        <div className="ui-detail-tools">
          {!actions && menu}
          {onToggleExpand && <IconButton icon={expanded ? Icon.shrink : Icon.expand} label={expanded ? "Narrow the panel" : "Widen the panel"} onClick={onToggleExpand} />}
          <IconButton icon={Icon.close} label="Close" onClick={onClose} />
        </div>
      </div>
      {actions && (
        <div className="ui-detail-actions">
          {actions}
          <span className="ui-flex-spacer" />
          {menu}
        </div>
      )}
      <div className="ui-detail-body">{children}</div>
      {footer && <div className="ui-detail-footer">{footer}</div>}
    </aside>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Icon.spinner size={size} className="ui-spin" aria-label="Loading" />;
}

export { cx };
