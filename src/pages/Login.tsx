import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { IconClose, Mark } from "../icons";
import { Jellyfin, normalizeServer } from "../jellyfin";
import { userImageUrl } from "../media";
import { useSession, type StoredAuth } from "../session";
import { tv } from "../tv";

type PublicUser = Awaited<ReturnType<typeof Jellyfin.publicUsers>>[number];

export function Login() {
  const { accounts, switchTo, forget, cancelAdd } = useSession();
  const [params] = useSearchParams();
  const adding = params.get("add") === "1";
  const [picking, setPicking] = useState(!adding && accounts.length > 0);

  if (picking && accounts.length > 0) {
    return (
      <div className="login">
        <div className="profiles">
          <Mark size={44} />
          <h1>Who's watching?</h1>
          <div className="profile-grid">
            {accounts.map((account) => (
              <ProfileTile key={`${account.server}:${account.userId}`} account={account} onPick={() => switchTo(account)} onForget={() => forget(account)} />
            ))}
            <button className="profile-tile" onClick={() => setPicking(false)}>
              <span className="profile-avatar add">+</span>
              <strong>Add account</strong>
              <small>Another user or server</small>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <SignIn onBack={accounts.length > 0 ? () => (adding ? cancelAdd() : setPicking(true)) : undefined} />;
}

function ProfileTile({ account, onPick, onForget }: { account: StoredAuth; onPick: () => void; onForget: () => void }) {
  const avatar = userImageUrl({ server: account.server, token: account.token, userId: account.userId, deviceId: "" }, account.imageTag);
  const [broken, setBroken] = useState(false);
  return (
    <div className="profile-tile-wrap">
      <button className="profile-tile" onClick={onPick}>
        <span className="profile-avatar">
          {avatar && !broken ? <img src={avatar} alt="" onError={() => setBroken(true)} /> : account.username.slice(0, 1).toUpperCase()}
        </span>
        <strong>{account.username}</strong>
        <small>{account.server.replace(/^https?:\/\//, "")}</small>
      </button>
      <button className="profile-forget" onClick={onForget} aria-label={`Remove ${account.username}`} title="Remove from this device">
        <IconClose size={12} />
      </button>
    </div>
  );
}

function SignIn({ onBack }: { onBack?: () => void }) {
  const { login, adopt, deviceFor } = useSession();
  const [server, setServer] = useState(localStorage.getItem("finplay.server") || "http://");
  const [mode, setMode] = useState<"password" | "quick">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [users, setUsers] = useState<{ server: string; list: PublicUser[] }>({ server: "", list: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef(0);

  useEffect(() => () => window.clearTimeout(pollRef.current), []);

  async function findUsers(address = server) {
    let normalized: string;
    try {
      normalized = normalizeServer(address);
    } catch {
      return;
    }
    if (normalized === users.server) return;
    const list = await Jellyfin.publicUsers(normalized, deviceFor(normalized)).catch(() => []);
    setUsers({ server: normalized, list });
  }

  useEffect(() => {
    void findUsers();
  }, []);

  function remember(address: string) {
    localStorage.setItem("finplay.server", address);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(server, username, password);
      remember(normalizeServer(server));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function startQuickConnect() {
    window.clearTimeout(pollRef.current);
    setError("");
    setCode("");
    setBusy(true);
    try {
      const address = normalizeServer(server);
      const device = deviceFor(address);
      const started = await Jellyfin.quickConnectStart(address, device);
      setCode(started.Code);
      const deadline = Date.now() + 10 * 60_000;
      const poll = async () => {
        try {
          if (await Jellyfin.quickConnectReady(address, device, started.Secret)) {
            const signedIn = await Jellyfin.quickConnectLogin(address, device, started.Secret);
            remember(address);
            adopt(address, signedIn, device);
            return;
          }
          if (Date.now() > deadline) throw new Error("That code expired. Start again for a new one.");
          pollRef.current = window.setTimeout(() => void poll(), 2500);
        } catch (err) {
          setCode("");
          setError(err instanceof Error ? err.message : "Quick Connect failed.");
        }
      };
      pollRef.current = window.setTimeout(() => void poll(), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Quick Connect failed.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: "password" | "quick") {
    window.clearTimeout(pollRef.current);
    setCode("");
    setError("");
    setMode(next);
  }

  const shownUsers = users.list.slice(0, 8);

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        {onBack ? (
          <button type="button" className="login-back" onClick={onBack}>
            ‹ Profiles
          </button>
        ) : null}
        <Mark size={48} />
        <h1>Finplay</h1>
        <p>Your Jellyfin library, played directly.</p>
        <label>
          Server
          <input
            value={server}
            onChange={(event) => setServer(event.target.value)}
            onBlur={() => void findUsers()}
            placeholder="http://192.168.1.20:8096"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </label>
        <div className="login-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "password"} className={mode === "password" ? "on" : ""} onClick={() => switchMode("password")}>
            Password
          </button>
          <button type="button" role="tab" aria-selected={mode === "quick"} className={mode === "quick" ? "on" : ""} onClick={() => switchMode("quick")}>
            Quick Connect
          </button>
        </div>
        {mode === "password" ? (
          <>
            {shownUsers.length ? (
              <div className="login-users">
                {shownUsers.map((user) => (
                  <button
                    type="button"
                    key={user.Id}
                    className={username === user.Name ? "on" : ""}
                    onClick={() => {
                      setUsername(user.Name);
                      setPassword("");
                      window.setTimeout(() => passwordRef.current?.focus(), 0);
                    }}
                  >
                    <span className="profile-avatar small">
                      {user.PrimaryImageTag ? <img src={`${users.server}/Users/${user.Id}/Images/Primary?tag=${user.PrimaryImageTag}&maxHeight=80`} alt="" /> : user.Name.slice(0, 1).toUpperCase()}
                    </span>
                    {user.Name}
                  </button>
                ))}
              </div>
            ) : null}
            <label>
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoCapitalize="off" autoCorrect="off" required />
            </label>
            <label>
              Password
              <input ref={passwordRef} type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            {error ? <p className="error-text">{error}</p> : null}
            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </>
        ) : (
          <div className="quick-connect">
            {code ? (
              <>
                <p>On a device that's already signed in, open Quick Connect and enter:</p>
                <strong className="quick-code">{code}</strong>
                <p className="fine">In Jellyfin web that's your profile → Quick Connect. In Finplay it's Settings → Quick Connect. Waiting for approval…</p>
              </>
            ) : (
              <p>Sign in without typing a password by approving this device from your phone or another signed-in app.</p>
            )}
            {error ? <p className="error-text">{error}</p> : null}
            <button className="btn-primary" type="button" disabled={busy} onClick={() => void startQuickConnect()}>
              {busy ? "Starting…" : code ? "Get a new code" : "Get a code"}
            </button>
          </div>
        )}
        {tv ? (
          <p className="fine">Video plays on the TV's own decoders, so HEVC and Dolby audio play as stored.</p>
        ) : (
          <p className="fine">Video opens in mpv, so HEVC, AV1, DTS, TrueHD, and PGS subtitles do not have to be transcoded the way they are in Firefox.</p>
        )}
      </form>
    </div>
  );
}
