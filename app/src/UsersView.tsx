import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "./ui/kit";
import type { NavigationMap } from "../../src/navmap-types";

interface UserView {
  id: string;
  label: string;
  kind: "guest" | "auth";
  allowedPageIds: string[] | null;
  hasCredentials: boolean;
  credentialsManagedByUi: boolean;
  sessionUpdatedAt: string | null;
}

type Panel = { userId: string; kind: "access" | "credentials" } | null;

async function api(url: string, init?: RequestInit): Promise<{ users: UserView[]; ok?: boolean; output?: string }> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(body.details ?? body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export function UsersView({ projectId, map, onBack }: { projectId: string; map: NavigationMap; onBack?: () => void }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/users`;
  const [users, setUsers] = useState<UserView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [panel, setPanel] = useState<Panel>(null);

  const pages = useMemo(() => Object.values(map.pages).sort((a, b) => a.title.localeCompare(b.title)), [map]);

  const run = useCallback(
    async (key: string, action: () => Promise<{ users: UserView[]; ok?: boolean; output?: string }>, message?: (r: { ok?: boolean; output?: string }) => string) => {
      setBusy(key);
      setError(null);
      try {
        const result = await action();
        setUsers(result.users);
        if (message) setMessages((m) => ({ ...m, [key]: message(result) }));
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  useEffect(() => {
    api(base)
      .then((r) => setUsers(r.users))
      .catch((err) => setError(String(err)));
  }, [base]);

  const setupSession = (user: UserView) =>
    run(user.id, () => api(`${base}/${user.id}/session`, { method: "POST" }), (r) =>
      r.ok ? "Session saved." : `Login failed: ${r.output?.trim().split("\n").pop() ?? "unknown error"}`,
    );

  const deleteUser = (user: UserView) => {
    if (!window.confirm(`Delete user "${user.label}"? Its saved session${user.credentialsManagedByUi ? " and credentials file" : ""} will be removed.`)) return;
    run(user.id, () => api(`${base}/${user.id}`, { method: "DELETE" }));
  };

  return (
    <div className="app-layout">
      <PageHeader
        title="Users"
        meta={
          <span>
            Who generated tests run as. Credentials stay in the project's gitignored <code>credentials/</code> folder and are never shown again.
          </span>
        }
      />

      <div className="coverage-body">
        {error && <div className="users-error">{error}</div>}
        {!users && !error && <p className="muted">Loading&hellip;</p>}

        {users?.map((user) => {
          const access = user.allowedPageIds
            ? `${user.allowedPageIds.length} of ${pages.filter((p) => user.kind === "auth" || !p.requiresAuth).length} pages`
            : user.kind === "guest"
              ? "All public pages"
              : "All pages";
          return (
            <section key={user.id} className="users-card">
              <header className="users-card-header">
                <strong>{user.label}</strong>
                <span className={`users-kind users-kind-${user.kind}`}>{user.kind === "guest" ? "guest" : "auth"}</span>
                <code className="muted">{user.id}</code>
              </header>
              <div className="users-status muted">
                <span>{access}</span>
                {user.kind === "auth" && (
                  <>
                    <span>{user.hasCredentials ? "✓ credentials" : "✗ no credentials"}</span>
                    <span>{user.sessionUpdatedAt ? `✓ session ${new Date(user.sessionUpdatedAt).toLocaleString()}` : "✗ no session"}</span>
                  </>
                )}
              </div>
              <div className="users-actions">
                {user.kind === "auth" && (
                  <button className="link-button" disabled={busy !== null || !user.hasCredentials} onClick={() => setupSession(user)}>
                    {busy === user.id ? "Working…" : user.sessionUpdatedAt ? "Refresh session" : "Set up session"}
                  </button>
                )}
                <button className="link-button" onClick={() => setPanel(panel?.userId === user.id && panel.kind === "access" ? null : { userId: user.id, kind: "access" })}>
                  Edit access
                </button>
                {user.kind === "auth" && (
                  <button
                    className="link-button"
                    onClick={() => setPanel(panel?.userId === user.id && panel.kind === "credentials" ? null : { userId: user.id, kind: "credentials" })}
                  >
                    {user.hasCredentials ? "Change credentials" : "Set credentials"}
                  </button>
                )}
                {user.kind === "auth" && (
                  <button className="link-button users-danger" disabled={busy !== null} onClick={() => deleteUser(user)}>
                    Delete
                  </button>
                )}
              </div>
              {messages[user.id] && <div className="coverage-auth-message">{messages[user.id]}</div>}

              {panel?.userId === user.id && panel.kind === "access" && (
                <AccessEditor
                  user={user}
                  pages={pages.filter((p) => user.kind === "auth" || !p.requiresAuth)}
                  busy={busy !== null}
                  onSave={async (allowedPageIds) => {
                    if (await run(user.id, () => api(`${base}/${user.id}`, { method: "PATCH", body: JSON.stringify({ allowedPageIds }) }))) setPanel(null);
                  }}
                />
              )}
              {panel?.userId === user.id && panel.kind === "credentials" && (
                <CredentialsEditor
                  requireUsername={!user.hasCredentials}
                  busy={busy !== null}
                  onSave={async (creds) => {
                    if (await run(user.id, () => api(`${base}/${user.id}`, { method: "PATCH", body: JSON.stringify(creds) }))) setPanel(null);
                  }}
                />
              )}
            </section>
          );
        })}

        {users && <AddUserForm busy={busy !== null} onAdd={(body) => run("new", () => api(base, { method: "POST", body: JSON.stringify(body) }))} />}
      </div>
    </div>
  );
}

function AccessEditor({
  user,
  pages,
  busy,
  onSave,
}: {
  user: UserView;
  pages: NavigationMap["pages"][string][];
  busy: boolean;
  onSave: (allowedPageIds: string[] | null) => void;
}) {
  const [allPages, setAllPages] = useState(user.allowedPageIds === null);
  const [selected, setSelected] = useState<Set<string>>(new Set(user.allowedPageIds ?? pages.map((p) => p.id)));

  return (
    <div className="users-panel">
      <label className="users-check">
        <input type="checkbox" checked={allPages} onChange={(e) => setAllPages(e.target.checked)} />
        <strong>All {user.kind === "guest" ? "public " : ""}pages</strong> (including ones discovered later)
      </label>
      {!allPages && (
        <div className="users-page-list">
          {pages.map((p) => (
            <label key={p.id} className="users-check">
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onChange={(e) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(p.id);
                    else next.delete(p.id);
                    return next;
                  })
                }
              />
              {p.requiresAuth ? "🔒 " : ""}
              {p.title} <span className="muted">{p.urlPattern}</span>
            </label>
          ))}
        </div>
      )}
      <button className="primary-button" disabled={busy} onClick={() => onSave(allPages ? null : [...selected])}>
        Save access
      </button>
    </div>
  );
}

function CredentialsEditor({
  requireUsername,
  busy,
  onSave,
}: {
  requireUsername: boolean;
  busy: boolean;
  onSave: (creds: { username?: string; password: string }) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      className="users-panel"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...(username ? { username } : {}), password });
      }}
    >
      <input
        className="users-input"
        placeholder={requireUsername ? "Username" : "Username (leave blank to keep the current one)"}
        value={username}
        required={requireUsername}
        autoComplete="off"
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        className="users-input"
        type="password"
        placeholder="New password"
        value={password}
        required
        autoComplete="new-password"
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="primary-button" type="submit" disabled={busy}>
        Save credentials
      </button>
    </form>
  );
}

function AddUserForm({ busy, onAdd }: { busy: boolean; onAdd: (body: Record<string, string>) => Promise<boolean> }) {
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  return (
    <form
      className="users-card users-add"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await onAdd({ label, username, password, ...(loginUrl ? { loginUrl } : {}) });
        if (ok) {
          setLabel("");
          setUsername("");
          setPassword("");
          setLoginUrl("");
        }
      }}
    >
      <strong>Add authenticated user</strong>
      <input className="users-input" placeholder="Label (e.g. General, Viewer)" value={label} required onChange={(e) => setLabel(e.target.value)} />
      <input className="users-input" placeholder="Username" value={username} required autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
      <input
        className="users-input"
        type="password"
        placeholder="Password"
        value={password}
        required
        autoComplete="new-password"
        onChange={(e) => setPassword(e.target.value)}
      />
      <input className="users-input" placeholder="Login URL (optional — defaults to the mapped login page)" value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} />
      <button className="primary-button" type="submit" disabled={busy}>
        Add user
      </button>
    </form>
  );
}
