import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, publicInfo } from "../jellyfin";
import { loadSettings, saveSettings } from "../settings";
import { useSession } from "../session";
import { normalizeStatsUrl, openStats } from "../stats";
import { applyLowPower, applyTheme } from "../theme";
import { applyCouch } from "../couch";
import { appVersion, findUpdate, installUpdate, type Update } from "../updates";
import type { HeroSource, Settings, Theme } from "../types";

const HERO_SOURCES: { id: HeroSource; label: string }[] = [
  { id: "resume", label: "Continue watching" },
  { id: "nextUp", label: "Next up" },
  { id: "picks", label: "Recommended" },
  { id: "latest", label: "Recently added" },
  { id: "favorites", label: "Favorites" },
];

const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "system", label: "System", hint: "Follows your desktop's light or dark mode" },
  { id: "dark", label: "Dark", hint: "Black with purple accents" },
  { id: "light", label: "Light", hint: "Bright and clean" },
  { id: "tv", label: "Apple TV", hint: "Frosted glass, big artwork" },
];

const RATES = [
  { value: 1_000_000_000, label: "Original" },
  { value: 80_000_000, label: "80 Mbps" },
  { value: 40_000_000, label: "40 Mbps" },
  { value: 20_000_000, label: "20 Mbps" },
  { value: 8_000_000, label: "8 Mbps" },
];

function About() {
  const [version, setVersion] = useState("");
  const [state, setState] = useState<{ text: string; update?: Update } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void appVersion().then(setVersion).catch(() => {});
  }, []);

  async function checkNow() {
    setBusy(true);
    setState({ text: "Checking…" });
    try {
      const update = await findUpdate();
      setState(update ? { text: `Finplay ${update.version} is available.`, update } : { text: "You're on the latest version." });
    } catch (err) {
      setState({ text: `Couldn't check for updates: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  }

  async function install(update: Update) {
    setBusy(true);
    try {
      await installUpdate(update, (percent) => setState({ text: percent < 0 ? "Downloading…" : `Downloading… ${percent}%`, update }));
    } catch (err) {
      setState({ text: `The update didn't install: ${err instanceof Error ? err.message : String(err)}`, update });
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>About</h2>
      <div className="setting-row">
        <div>
          <strong>Finplay {version}</strong>
          <p>{state?.text ?? "Updates are checked automatically when Finplay starts."}</p>
        </div>
        {state?.update ? (
          <button className="btn-primary" disabled={busy} onClick={() => state.update && void install(state.update)}>
            Update and restart
          </button>
        ) : (
          <button className="btn-ghost" disabled={busy} onClick={() => void checkNow()}>
            Check for updates
          </button>
        )}
      </div>
    </section>
  );
}

function QuickConnect() {
  const { client, status, username } = useSession();
  const [code, setCode] = useState("");
  const [state, setState] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!client || status !== "ready") return null;

  async function authorize(event: FormEvent) {
    event.preventDefault();
    if (!client) return;
    setBusy(true);
    setState(null);
    try {
      await client.quickConnectAuthorize(code);
      setState({ tone: "ok", text: `Done. That device is now signed in as ${username}.` });
      setCode("");
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setState({
        tone: "error",
        text: status === 404 || status === 400 ? "That code wasn't found. Check it, or get a new one on the other device." : status === 403 ? "Quick Connect is turned off on this server." : err instanceof Error ? err.message : "Could not approve that code.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Quick Connect</h2>
      <form className="setting-row" onSubmit={authorize}>
        <div>
          <strong>Sign in another device</strong>
          <p>Enter the code shown on a TV, phone, or another Finplay to sign it in as you without a password.</p>
          {state ? <p className={state.tone === "ok" ? "ok-text" : "error-text"}>{state.text}</p> : null}
        </div>
        <div className="inline-form">
          <input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="123456" inputMode="numeric" />
          <button className="btn-ghost" type="submit" disabled={busy || code.length < 6}>
            {busy ? "Approving…" : "Approve"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Connection() {
  const { server, accountServer, localServer, setLocalServer } = useSession();
  const [draft, setDraft] = useState(localServer ?? "");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [suggested, setSuggested] = useState("");
  const home = Boolean(localServer) && server === localServer;

  useEffect(() => setDraft(localServer ?? ""), [localServer]);
  useEffect(() => {
    if (localServer) return;
    let cancel = false;
    void publicInfo(accountServer, 4000).then((info) => {
      const address = info?.LocalAddress?.replace(/\/+$/, "");
      if (!cancel && address && address !== accountServer) setSuggested(address);
    });
    return () => {
      cancel = true;
    };
  }, [accountServer, localServer]);

  async function save(event?: FormEvent, value = draft) {
    event?.preventDefault();
    setBusy(true);
    setState(null);
    try {
      const reached = await setLocalServer(value.trim() || null);
      if (!value.trim()) setState({ tone: "ok", text: "Removed. Finplay will always use the main address." });
      else if (reached) setState({ tone: "ok", text: "Saved. You're on your home network, so Finplay is using it now." });
      else setState({ tone: "ok", text: "Saved, but it can't be reached from here. Finplay will switch to it whenever you're home." });
    } catch (err) {
      setState({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Connection</h2>
      <div className="setting-row">
        <div>
          <strong>Main address</strong>
          <p>Used whenever you're away from home.</p>
        </div>
        <span className="setting-value">{accountServer.replace(/^https?:\/\//, "")}</span>
      </div>
      <form className="setting-row wide-control" onSubmit={(event) => void save(event)}>
        <div>
          <strong>Home network address</strong>
          <p>
            Optional. When this answers, Finplay uses it instead, for full-speed streaming at home with no trip through the internet. It's checked to
            be the same server before your sign-in is ever sent to it.
          </p>
          {localServer ? (
            <p className="connection-now">
              <i className={home ? "on" : ""} />
              {home ? "Connected through your home network" : "Connected through the main address"}
            </p>
          ) : null}
          {suggested && !localServer ? (
            <p>
              Your server reports{" "}
              <button type="button" className="link-btn" onClick={() => setDraft(suggested)}>
                {suggested.replace(/^https?:\/\//, "")}
              </button>
              . That may be an internal address; use the one you'd type in a browser at home.
            </p>
          ) : null}
          {state ? <p className={state.tone === "ok" ? "ok-text" : "error-text"}>{state.text}</p> : null}
        </div>
        <div className="inline-form">
          <input className="address-input" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="http://192.168.1.10:8096" spellCheck={false} />
          {localServer && draft.trim() === localServer ? null : (
            <button className="btn-ghost" type="submit" disabled={busy || !draft.trim()}>
              {busy ? "Checking…" : "Save"}
            </button>
          )}
          {localServer && draft.trim() === localServer ? (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void save(undefined, "")}>
              Remove
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

export function Settings() {
  const { username, server, logout, isAdmin } = useSession();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [statsError, setStatsError] = useState("");

  useEffect(() => {
    if (window.location.hash.endsWith("#streamystats")) document.getElementById("streamystats")?.querySelector("input")?.focus();
  }, []);

  function update(patch: Partial<Settings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  }

  return (
    <div className="page settings">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>
            {username} · {server.replace(/^https?:\/\//, "")}
          </p>
        </div>
      </header>
      <section>
        <h2>Appearance</h2>
        <div className="theme-picks" role="radiogroup" aria-label="Theme">
          {THEMES.map((option) => (
            <button
              key={option.id}
              role="radio"
              aria-checked={settings.theme === option.id}
              className={`theme-pick${settings.theme === option.id ? " on" : ""}`}
              onClick={() => {
                update({ theme: option.id });
                applyTheme(option.id);
              }}
            >
              <span className={`theme-swatch swatch-${option.id}`}>
                <i />
                <i />
                <i />
              </span>
              <strong>{option.label}</strong>
              <small>{option.hint}</small>
            </button>
          ))}
        </div>
        <div className="setting-row">
          <div>
            <strong>Couch mode</strong>
            <p>Bigger focus highlights and navigation with arrow keys, a TV remote, or a gamepad. Enter or A selects, Backspace or B goes back.</p>
          </div>
          <button
            className={`switch${settings.couchMode ? " on" : ""}`}
            onClick={() => {
              update({ couchMode: !settings.couchMode });
              applyCouch(!settings.couchMode);
            }}
            aria-pressed={settings.couchMode}
          />
        </div>
        <div className="setting-row">
          <div>
            <strong>Low-power mode</strong>
            <p>Turns off glass blur effects and uses lighter video scaling. Smoother on older computers and easier on the battery.</p>
          </div>
          <button
            className={`switch${settings.lowPower ? " on" : ""}`}
            onClick={() => {
              update({ lowPower: !settings.lowPower });
              applyLowPower(!settings.lowPower);
            }}
            aria-pressed={settings.lowPower}
          />
        </div>
      </section>
      <section>
        <h2>Home</h2>
        <div className="setting-row">
          <div>
            <strong>Highlights</strong>
            <p>What the big banner at the top of Home shows, in the order picked. Changes apply the next time Home opens.</p>
          </div>
          <div className="chips" role="group" aria-label="Highlights">
            {HERO_SOURCES.map((source) => {
              const on = settings.heroSources.includes(source.id);
              return (
                <button
                  key={source.id}
                  className={on ? "on" : ""}
                  aria-pressed={on}
                  onClick={() => {
                    const next = on ? settings.heroSources.filter((id) => id !== source.id) : [...settings.heroSources, source.id];
                    if (next.length > 0) update({ heroSources: next });
                  }}
                >
                  {source.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Highlight titles</strong>
            <p>Limit the banner to movies or shows.</p>
          </div>
          <select value={settings.heroTypes} onChange={(event) => update({ heroTypes: event.target.value as Settings["heroTypes"] })}>
            <option value="all">Movies and shows</option>
            <option value="movies">Movies only</option>
            <option value="shows">Shows only</option>
          </select>
        </div>
        <div className="setting-row">
          <div>
            <strong>Rotate highlights</strong>
            <p>Moves to the next highlight every few seconds.</p>
          </div>
          <button className={`switch${settings.heroAutoAdvance ? " on" : ""}`} onClick={() => update({ heroAutoAdvance: !settings.heroAutoAdvance })} aria-pressed={settings.heroAutoAdvance} />
        </div>
      </section>
      <section>
        <h2>Playback</h2>
        <div className="setting-row">
          <div>
            <strong>Quality</strong>
            <p>Original asks Jellyfin for the file as stored. Lower caps can force a transcode.</p>
          </div>
          <select value={settings.maxBitrate} onChange={(event) => update({ maxBitrate: Number(event.target.value) })}>
            {RATES.map((rate) => (
              <option key={rate.value} value={rate.value}>
                {rate.label}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div>
            <strong>Open fullscreen</strong>
            <p>The player window starts fullscreen.</p>
          </div>
          <button className={`switch${settings.fullscreen ? " on" : ""}`} onClick={() => update({ fullscreen: !settings.fullscreen })} aria-pressed={settings.fullscreen} />
        </div>
        <div className="setting-row">
          <div>
            <strong>Auto-play next episode</strong>
            <p>Shows an Up next countdown during the credits or at the end of an episode.</p>
          </div>
          <button className={`switch${settings.autoplayNext ? " on" : ""}`} onClick={() => update({ autoplayNext: !settings.autoplayNext })} aria-pressed={settings.autoplayNext} />
        </div>
        <div className="setting-row">
          <div>
            <strong>Skip intros automatically</strong>
            <p>Jumps past intros and recaps the server or file has marked. Otherwise a Skip button appears.</p>
          </div>
          <button className={`switch${settings.autoSkipIntro ? " on" : ""}`} onClick={() => update({ autoSkipIntro: !settings.autoSkipIntro })} aria-pressed={settings.autoSkipIntro} />
        </div>
        <div className="setting-row">
          <div>
            <strong>Playback speed</strong>
            <p>Used when a title starts. You can still change speed in the player with [ and ].</p>
          </div>
          <select value={settings.playbackSpeed} onChange={(event) => update({ playbackSpeed: Number(event.target.value) })}>
            {[0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
              <option key={speed} value={speed}>
                {speed === 1 ? "Normal" : `${speed}×`}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div>
            <strong>Subtitles</strong>
            <p>Off keeps image subtitles from being burned in. You can still turn them on in the player.</p>
          </div>
          <button className={`switch${settings.subtitlesEnabled ? " on" : ""}`} onClick={() => update({ subtitlesEnabled: !settings.subtitlesEnabled })} aria-pressed={settings.subtitlesEnabled} />
        </div>
        <div className="setting-row">
          <div>
            <strong>Subtitle language</strong>
            <p>Used when subtitles are on. Example: eng</p>
          </div>
          <input value={settings.subtitleLanguage} onChange={(event) => update({ subtitleLanguage: event.target.value })} />
        </div>
        <div className="setting-row">
          <div>
            <strong>Subtitle size</strong>
            <p>Bigger helps on a living-room TV. Applies the next time you play something.</p>
          </div>
          <select value={settings.subtitleScale} onChange={(event) => update({ subtitleScale: Number(event.target.value) })}>
            {[0.8, 1, 1.2, 1.5, 2].map((scale) => (
              <option key={scale} value={scale}>
                {scale === 1 ? "Normal" : `${scale}×`}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div>
            <strong>Subtitle color</strong>
            <p>High-contrast yellow is often easier to read than white.</p>
          </div>
          <select value={settings.subtitleColor} onChange={(event) => update({ subtitleColor: event.target.value })}>
            <option value="white">White</option>
            <option value="yellow">Yellow</option>
            <option value="cyan">Cyan</option>
            <option value="lime">Lime</option>
          </select>
        </div>
        <div className="setting-row">
          <div>
            <strong>Subtitle font</strong>
            <p>Leave blank for mpv's default. Examples: sans-serif, serif, monospace.</p>
          </div>
          <input value={settings.subtitleFont} onChange={(event) => update({ subtitleFont: event.target.value })} placeholder="sans-serif" />
        </div>
        <div className="setting-row">
          <div>
            <strong>Audio language</strong>
            <p>Leave blank to use the file default.</p>
          </div>
          <input value={settings.audioLanguage} onChange={(event) => update({ audioLanguage: event.target.value })} placeholder="eng" />
        </div>
        <div className="setting-row">
          <div>
            <strong>mpv path</strong>
            <p>Leave as mpv to use the player built into Finplay (Windows and macOS) or your system's mpv (Linux). Enter a full path to use a different mpv.</p>
          </div>
          <input value={settings.mpvPath} onChange={(event) => update({ mpvPath: event.target.value })} spellCheck={false} />
        </div>
      </section>
      {isAdmin ? (
        <section id="streamystats">
          <h2>Streamystats</h2>
          <div className="setting-row">
            <div>
              <strong>Dashboard address</strong>
              <p>Optional. Adds a Streamystats button to the Stats page that opens the full dashboard in its own window, for extras like Wrapped and Security.</p>
              {statsError ? <p className="error-text">{statsError}</p> : null}
            </div>
            <input
              value={settings.streamystatsUrl}
              onChange={(event) => update({ streamystatsUrl: event.target.value })}
              onBlur={() => update({ streamystatsUrl: normalizeStatsUrl(settings.streamystatsUrl) })}
              placeholder="http://192.168.1.10:3000"
              spellCheck={false}
            />
          </div>
          <button
            className="btn-ghost"
            disabled={!settings.streamystatsUrl.trim()}
            onClick={() => {
              setStatsError("");
              openStats(settings.streamystatsUrl).catch((err: unknown) => setStatsError(err instanceof Error ? err.message : String(err)));
            }}
          >
            Open Streamystats
          </button>
        </section>
      ) : null}
      <Connection />
      <QuickConnect />
      <About />
      <section>
        <h2>Account</h2>
        <button
          className="btn-ghost"
          onClick={() => {
            logout();
            navigate("/login");
          }}
        >
          Sign out
        </button>
      </section>
    </div>
  );
}
