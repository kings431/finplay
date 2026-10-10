import { useEffect, useMemo, useRef, useState } from "react";
import { admin, userImage, type AdminUser, type LogFile } from "../../admin";
import { useClient, useSession } from "../../session";
import { ago, bytes, errorText, fullDate, usePoll } from "./ui";

export function UsersSection() {
  const client = useClient();
  const { userId } = useSession();
  const { data, error, loading } = usePoll(() => admin.users(client), 60000, "users");
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const users = (data ?? [])
    .filter((user) => !query || user.Name.toLowerCase().includes(query))
    .sort((a, b) => (b.LastActivityDate ?? "").localeCompare(a.LastActivityDate ?? ""));
  const admins = (data ?? []).filter((user) => user.Policy?.IsAdministrator).length;
  const disabled = (data ?? []).filter((user) => user.Policy?.IsDisabled).length;
  const someHidden = (data ?? []).some((user) => user.Policy?.IsHidden) && (data ?? []).some((user) => !user.Policy?.IsHidden);

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <div>
          <h2>
            Users {data ? <span className="count-pill">{data.length}</span> : null}
          </h2>
          <p>{data ? [`${admins} ${admins === 1 ? "administrator" : "administrators"}`, disabled ? `${disabled} disabled` : ""].filter(Boolean).join(" · ") : "Everyone with an account on this server."}</p>
        </div>
        <input className="dash-search" type="search" placeholder="Find a user" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      {error && !data ? <p className="dash-empty error-text">Couldn't load users. {error}</p> : null}
      {!data && loading ? <p className="dash-empty">Loading users…</p> : null}
      {data ? (
        <div className="dash-card dash-list">
          <div className="dash-row dash-row-labels dash-user">
            <span />
            <span>Name</span>
            <span>Last active</span>
            <span>Last sign-in</span>
          </div>
          {users.map((user) => (
            <UserRow key={user.Id} user={user} self={user.Id === userId} markHidden={someHidden} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function UserRow({ user, self, markHidden }: { user: AdminUser; self: boolean; markHidden: boolean }) {
  const client = useClient();
  const avatar = userImage(client.auth.server, client.auth.token, user);
  const policy = user.Policy ?? {};
  return (
    <div className={`dash-row dash-user${policy.IsDisabled ? " dimmed" : ""}`}>
      {avatar ? <img className="dash-avatar" src={avatar} alt="" loading="lazy" /> : <span className="dash-avatar">{user.Name.slice(0, 1).toUpperCase()}</span>}
      <span className="dash-row-main">
        <strong>
          {user.Name}
          {self ? <em className="dash-badge">You</em> : null}
          {policy.IsAdministrator ? <em className="dash-badge accent">Admin</em> : null}
          {policy.IsDisabled ? <em className="dash-badge bad">Disabled</em> : null}
          {markHidden && policy.IsHidden ? <em className="dash-badge">Hidden from sign-in</em> : null}
          {user.HasPassword === false ? <em className="dash-badge warn">No password</em> : null}
        </strong>
      </span>
      <span className="dash-row-side" title={fullDate(user.LastActivityDate)}>
        {ago(user.LastActivityDate) || "never"}
      </span>
      <span className="dash-row-side" title={fullDate(user.LastLoginDate)}>
        {ago(user.LastLoginDate) || "never"}
      </span>
    </div>
  );
}

export function DevicesSection() {
  const client = useClient();
  const { deviceId } = useSession();
  const { data, error, loading } = usePoll(async () => (await admin.devices(client)).Items ?? [], 60000, "devices");
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const devices = (data ?? [])
    .filter((device) => !query || `${device.CustomName ?? device.Name} ${device.AppName} ${device.LastUserName}`.toLowerCase().includes(query))
    .sort((a, b) => (b.DateLastActivity ?? "").localeCompare(a.DateLastActivity ?? ""));

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <div>
          <h2>Devices {data ? <span className="count-pill">{data.length}</span> : null}</h2>
          <p>Every app that has signed in to this server, most recent first.</p>
        </div>
        <input className="dash-search" type="search" placeholder="Find a device, app, or user" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      {error && !data ? <p className="dash-empty error-text">Couldn't load devices. {error}</p> : null}
      {!data && loading ? <p className="dash-empty">Loading devices…</p> : null}
      {data ? (
        <div className="dash-card dash-list">
          <div className="dash-row dash-row-labels dash-device">
            <span>Device</span>
            <span>App</span>
            <span>Last user</span>
            <span>Last active</span>
          </div>
          {devices.map((device, index) => (
            <div key={`${device.Id}:${device.LastUserId ?? ""}:${index}`} className="dash-row dash-device">
              <span className="dash-row-main">
                <strong>
                  {device.CustomName || device.Name || "Unknown device"}
                  {device.Id === deviceId ? <em className="dash-badge">This app</em> : null}
                </strong>
              </span>
              <span className="dash-row-text">{[device.AppName, device.AppVersion].filter(Boolean).join(" ")}</span>
              <span className="dash-row-text">{device.LastUserName}</span>
              <span className="dash-row-side" title={fullDate(device.DateLastActivity)}>
                {ago(device.DateLastActivity)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const PLUGIN_STATUS: Record<string, string> = {
  Restart: "Restart needed",
  Deleted: "Removed on restart",
  Superseded: "Superseded",
  Malfunctioned: "Failed to load",
  NotSupported: "Not supported",
  Disabled: "Disabled",
};

export function PluginsSection() {
  const client = useClient();
  const { data, error, loading } = usePoll(() => admin.plugins(client), 120000, "plugins");
  const plugins = [...(data ?? [])].sort((a, b) => a.Name.localeCompare(b.Name));
  const imageUrl = (id: string, version?: string) => `${client.auth.server}/Plugins/${id}/${version ?? ""}/Image?${new URLSearchParams({ ApiKey: client.auth.token })}`;

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <div>
          <h2>Plugins {data ? <span className="count-pill">{data.length}</span> : null}</h2>
          <p>Installed on the server. Install, update, and configure them from Jellyfin's web dashboard.</p>
        </div>
      </div>
      {error && !data ? <p className="dash-empty error-text">Couldn't load plugins. {error}</p> : null}
      {!data && loading ? <p className="dash-empty">Loading plugins…</p> : null}
      <div className="dash-plugins">
        {plugins.map((plugin) => (
          <article key={plugin.Id} className="dash-card dash-plugin">
            <span className="dash-plugin-art">
              {plugin.HasImage ? <img src={imageUrl(plugin.Id, plugin.Version)} alt="" loading="lazy" onError={(event) => (event.currentTarget.style.display = "none")} /> : null}
            </span>
            <span className="dash-row-main">
              <strong>{plugin.Name}</strong>
              <small>
                {plugin.Version ? `Version ${plugin.Version}` : ""}
                {plugin.Status && plugin.Status !== "Active" ? <em className={`dash-badge ${plugin.Status === "Malfunctioned" ? "bad" : "warn"}`}>{PLUGIN_STATUS[plugin.Status] ?? plugin.Status}</em> : null}
              </small>
              {plugin.Description ? <small className="dash-plugin-copy">{plugin.Description}</small> : null}
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}

const LOG_LINES = 1500;

export function LogsSection() {
  const client = useClient();
  const { data, error, loading, reload } = usePoll(() => admin.logs(client), 60000, "logs");
  const [open, setOpen] = useState<LogFile | null>(null);
  const files = [...(data ?? [])].sort((a, b) => (b.DateModified ?? "").localeCompare(a.DateModified ?? ""));

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <div>
          <h2>Logs {data ? <span className="count-pill">{data.length}</span> : null}</h2>
          <p>Server and transcoder logs, newest first.</p>
        </div>
        <button className="btn-ghost dash-small" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      {error && !data ? <p className="dash-empty error-text">Couldn't load logs. {error}</p> : null}
      {!data && loading ? <p className="dash-empty">Loading logs…</p> : null}
      <div className={`dash-logs${open ? " open" : ""}`}>
        <div className="dash-card dash-list dash-log-files">
          {files.map((file) => (
            <button key={file.Name} className={`dash-row dash-log-file${open?.Name === file.Name ? " on" : ""}`} onClick={() => setOpen(file)}>
              <span className="dash-row-main">
                <strong title={file.Name}>{file.Name}</strong>
                <small>
                  {bytes(file.Size)} · {ago(file.DateModified)}
                </small>
              </span>
            </button>
          ))}
        </div>
        {open ? <LogViewer key={open.Name} file={open} onClose={() => setOpen(null)} /> : null}
      </div>
    </section>
  );
}

function LogViewer({ file, onClose }: { file: LogFile; onClose: () => void }) {
  const client = useClient();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const body = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancel = false;
    admin
      .log(client, file.Name)
      .then((value) => !cancel && setText(value))
      .catch((err: unknown) => !cancel && setError(errorText(err)));
    return () => {
      cancel = true;
    };
  }, [client, file.Name]);

  const lines = useMemo(() => {
    if (text === null) return [];
    const all = text.split(/\r?\n/);
    const query = filter.trim().toLowerCase();
    const matched = all.filter((line) => (!query || line.toLowerCase().includes(query)) && (!errorsOnly || /\b(ERR|FTL|WRN|error|fatal|warn)/i.test(line)));
    return matched.slice(-LOG_LINES);
  }, [text, filter, errorsOnly]);
  const total = useMemo(() => (text === null ? 0 : text.split(/\r?\n/).length), [text]);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [lines]);

  return (
    <div className="dash-card dash-log-view">
      <div className="dash-log-head">
        <strong title={file.Name}>{file.Name}</strong>
        <input className="dash-search" type="search" placeholder="Filter lines" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <button className={`btn-ghost dash-small${errorsOnly ? " on" : ""}`} onClick={() => setErrorsOnly((value) => !value)}>
          Warnings and errors
        </button>
        <button className="btn-ghost dash-small" onClick={onClose}>
          Close
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      {text === null && !error ? <p className="stat-empty">Loading {bytes(file.Size)}…</p> : null}
      {text !== null ? (
        <>
          <small className="dash-faint">
            {lines.length === LOG_LINES ? `Showing the last ${LOG_LINES.toLocaleString()} matching lines of ${total.toLocaleString()}.` : `${lines.length.toLocaleString()} of ${total.toLocaleString()} lines.`}
          </small>
          <pre ref={body} className="dash-log-text">
            {lines.map((line, index) => (
              <span key={index} className={/\b(ERR|FTL)\b|\[ERR\]|\berror\b/i.test(line) ? "bad" : /\bWRN\b|\[WRN\]|\bwarn/i.test(line) ? "warn" : undefined}>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </>
      ) : null}
    </div>
  );
}
