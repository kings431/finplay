import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ticksToSeconds } from "./media";
import { usePlayback } from "./playback";
import { inTauri, playerRequest } from "./player";
import { useSession } from "./session";
import type { BaseItem, RemoteSession } from "./types";

type RemoteValue = {
  /** The device titles are sent to, as last seen by the server. */
  target: RemoteSession | null;
  /** Where the target was, in seconds, when `target` was fetched. */
  seenAt: number;
  notice: string;
  devices: () => Promise<RemoteSession[]>;
  choose: (session: RemoteSession | null) => void;
  playPause: () => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  stop: () => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  toggleMute: () => Promise<void>;
};

type PlayMessage = {
  ItemIds?: string[];
  StartIndex?: number;
  StartPositionTicks?: number;
  PlayCommand?: string;
  MediaSourceId?: string;
  AudioStreamIndex?: number;
  SubtitleStreamIndex?: number;
};
type PlaystateMessage = { Command?: string; SeekPositionTicks?: number };
type GeneralMessage = { Name?: string; Arguments?: Record<string, string> };
type Track = { id: number; type: string; "ff-index"?: number; external?: boolean };

const RemoteContext = createContext<RemoteValue | null>(null);
const POLL_MS = 2000;
/** Polls in a row a chosen device may be missing before it counts as gone. */
const MISSING_LIMIT = 4;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60_000;
/** Until the server's ForceKeepAlive names its own timeout. */
const KEEPALIVE_SECONDS = 60;

const NAVIGATION_KEYS: Record<string, string> = {
  MoveUp: "ArrowUp",
  MoveDown: "ArrowDown",
  MoveLeft: "ArrowLeft",
  MoveRight: "ArrowRight",
  Select: "Enter",
  Back: "GoBack",
};

/** General commands this app carries out, announced so controllers offer them.
 * The arrow keys are couch navigation, which mpv's own window doesn't use. */
function supportedCommands() {
  const shared = ["SetVolume", "VolumeUp", "VolumeDown", "ToggleMute", "Mute", "Unmute", "SetAudioStreamIndex", "SetSubtitleStreamIndex", "DisplayMessage", "GoHome", "GoToSettings", "GoToSearch", "DisplayContent"];
  if (inTauri()) return [...shared, "ToggleFullscreen"];
  return [...shared, ...Object.keys(NAVIGATION_KEYS)];
}

/** Presses a remote key as if on the TV's own remote. Buttons only click on a
 * real Enter, so Select clicks whatever nothing else handled. */
function press(key: string) {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  if (key === "Enter" && !event.defaultPrevented && target !== document.body) target.click();
}

function shuffled<T>(list: T[]) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function RemoteProvider({ children }: { children: ReactNode }) {
  const { client, status } = useSession();
  const playback = usePlayback();
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const [target, setTarget] = useState<RemoteSession | null>(null);
  const [seenAt, setSeenAt] = useState(0);
  const [notice, setNotice] = useState("");
  /** Text a controller sent to show on this screen. */
  const [message, setMessage] = useState("");
  const messageTimer = useRef(0);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const targetRef = useRef<RemoteSession | null>(null);
  const missingRef = useRef(0);
  const pollRef = useRef<() => Promise<void>>(async () => {});
  targetRef.current = target;

  const say = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? "" : current)), 5000);
  }, []);

  const show = useCallback((text: string, ms = 5000) => {
    window.clearTimeout(messageTimer.current);
    setMessage(text);
    messageTimer.current = window.setTimeout(() => setMessage(""), Math.max(1500, Math.min(60_000, ms)));
  }, []);
  useEffect(() => () => window.clearTimeout(messageTimer.current), []);

  const poll = useCallback(async () => {
    const chosen = targetRef.current;
    if (!client || !chosen) return;
    const sessions = await client.remoteSessions().catch(() => null);
    if (!sessions || targetRef.current?.DeviceId !== chosen.DeviceId) return;
    const fresh = sessions.find((session) => session.DeviceId === chosen.DeviceId && session.Client === chosen.Client);
    if (!fresh) {
      missingRef.current += 1;
      if (missingRef.current >= MISSING_LIMIT) {
        setTarget(null);
        say(`${chosen.DeviceName ?? "The device"} went offline.`);
      }
      return;
    }
    missingRef.current = 0;
    setTarget(fresh);
    setSeenAt(Date.now());
  }, [client, say]);
  pollRef.current = poll;

  const soon = () => window.setTimeout(() => void pollRef.current(), 700);

  useEffect(() => {
    if (!target?.DeviceId) return;
    const timer = window.setInterval(() => !document.hidden && void pollRef.current(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [target?.DeviceId]);

  useEffect(() => {
    if (status === "anon" || status === "offline" || !client) setTarget(null);
  }, [status, client]);

  // Route Play buttons to the chosen device.
  useEffect(() => {
    if (!client || !target?.DeviceId) {
      playbackRef.current.setRemote(null);
      return;
    }
    playbackRef.current.setRemote(async (item, startTicks, mediaSourceId) => {
      const chosen = targetRef.current;
      if (!chosen) throw new Error("No device to play on.");
      await client.remotePlay(chosen.Id, item.Id, startTicks, mediaSourceId);
      say(`Playing ${item.Name} on ${chosen.DeviceName ?? "the device"}.`);
      soon();
    });
    return () => playbackRef.current.setRemote(null);
  }, [client, target?.DeviceId, say]);

  // Commands from other clients that chose this app to play on. Signed out
  // there is no socket, so nothing arrives on the sign-in and profile screens.
  useEffect(() => {
    if (!client || status !== "ready") return;
    let socket: WebSocket | null = null;
    let keepAlive = 0;
    let retry = 0;
    let delay = RETRY_MIN_MS;
    let lastHeard = 0;
    let closed = false;
    const mpv = inTauri();

    const play = async (message: PlayMessage) => {
      const current = playbackRef.current;
      const ids = message.ItemIds ?? [];
      if (ids.length === 0) return;
      const found = new Map((await client.itemsByIds(ids)).map((item) => [item.Id, item]));
      const items = ids.map((id) => found.get(id)).filter((item): item is BaseItem => Boolean(item));
      if (items.length === 0) return;
      const command = message.PlayCommand ?? "PlayNow";
      if ((command === "PlayNext" || command === "PlayLast") && current.active && !current.active.trailer) {
        current.enqueue(items, command === "PlayNext" ? "next" : "last");
        const what = items.length === 1 ? items[0].Name : `${items.length} titles`;
        show(command === "PlayNext" ? `${what} plays next` : `${what} added to the queue`);
        return;
      }
      const list = command === "PlayShuffle" ? shuffled(items) : items;
      const start = command === "PlayShuffle" ? 0 : Math.min(Math.max(0, message.StartIndex ?? 0), list.length - 1);
      const queued = list.length > 1;
      await current.play(list[start], {
        local: true,
        resume: true,
        startAt: ticksToSeconds(message.StartPositionTicks ?? 0),
        mediaSourceId: message.MediaSourceId,
        audioIndex: message.AudioStreamIndex,
        subtitleIndex: message.SubtitleStreamIndex,
        queue: queued ? list.slice(start + 1) : undefined,
        history: queued ? list.slice(0, start) : undefined,
      });
      if (mpv && (message.AudioStreamIndex !== undefined || message.SubtitleStreamIndex !== undefined)) {
        void pickMpvTracks(() => playbackRef.current.active?.method, message.AudioStreamIndex, message.SubtitleStreamIndex);
      }
    };

    const playstate = async ({ Command: command, SeekPositionTicks: ticks }: PlaystateMessage) => {
      const current = playbackRef.current;
      const playing = current.active;
      if (!playing) return;
      switch (command) {
        case "Stop":
          return current.stop();
        case "Pause":
          return current.setPaused(true);
        case "Unpause":
          return current.setPaused(false);
        case "PlayPause":
          return current.togglePause();
        case "Seek":
          // Server positions count from the title's start; an mpv transcode starts at `baseTicks`.
          return current.seek(Math.max(0, ticksToSeconds((ticks ?? 0) - playing.baseTicks)));
        case "Rewind":
          return void (await playerRequest(["seek", -10, "relative"]));
        case "FastForward":
          return void (await playerRequest(["seek", 30, "relative"]));
        case "NextTrack":
          return void (await current.next());
        case "PreviousTrack":
          return current.previous();
      }
    };

    const general = async ({ Name: name = "", Arguments: args = {} }: GeneralMessage) => {
      const current = playbackRef.current;
      const playing = current.active;
      if (name === "DisplayMessage") {
        const text = [args.Header, args.Text].filter(Boolean).join(": ");
        if (!text) return;
        const ms = Number(args.TimeoutMs) || 5000;
        if (mpv && playing) await playerRequest(["show-text", text, ms]);
        else show(text, ms);
        return;
      }
      const page =
        name === "GoHome" ? "/" : name === "GoToSettings" ? "/settings" : name === "GoToSearch" ? "/search" : name === "DisplayContent" && args.ItemId ? `/item/${args.ItemId}` : "";
      if (page) {
        // The browser player covers the app, so going somewhere ends it; mpv
        // plays in its own window and the app stays where it is.
        if (playing && mpv) return;
        if (playing) await current.stop();
        navigateRef.current(page);
        return;
      }
      if (NAVIGATION_KEYS[name]) {
        if (!mpv) press(NAVIGATION_KEYS[name]);
        return;
      }
      if (!playing) return;
      switch (name) {
        case "SetVolume":
          return void (await playerRequest(["set_property", "volume", Math.max(0, Math.min(100, Number(args.Volume) || 0))]));
        case "VolumeUp":
        case "VolumeDown": {
          const volume = await playerRequest(["get_property", "volume"]);
          const next = (typeof volume === "number" ? volume : 100) + (name === "VolumeUp" ? 5 : -5);
          return void (await playerRequest(["set_property", "volume", Math.max(0, Math.min(100, next))]));
        }
        case "ToggleMute":
          return void (await playerRequest(["cycle", "mute"]));
        case "Mute":
        case "Unmute":
          return void (await playerRequest(["set_property", "mute", name === "Mute"]));
        case "ToggleFullscreen":
          if (mpv) await playerRequest(["script-message", "finplay-fullscreen"]);
          return;
        case "SetPlaybackRate": {
          const rate = Number(args.PlaybackRate ?? args.Rate);
          if (rate > 0) await playerRequest(["set_property", "speed", Math.max(0.25, Math.min(4, rate))]);
          return;
        }
        case "SetAudioStreamIndex":
        case "SetSubtitleStreamIndex": {
          const index = Number(args.Index);
          if (!Number.isInteger(index)) return;
          const audio = name === "SetAudioStreamIndex";
          if (mpv) return selectTrack(audio ? "audio" : "sub", index);
          if (audio ? index === playing.audioIndex : index === (playing.subtitleIndex ?? -1)) return;
          return current.changeStreams(audio ? { audio: index } : { subtitle: index });
        }
      }
    };

    const handle = async (type: string, data: unknown) => {
      if (type === "Play") return play(data as PlayMessage);
      if (type === "Playstate") return playstate(data as PlaystateMessage);
      if (type === "GeneralCommand") return general(data as GeneralMessage);
    };

    const drop = () => {
      window.clearInterval(keepAlive);
      const old = socket;
      socket = null;
      if (!old) return;
      old.onopen = old.onmessage = old.onclose = null;
      old.close();
    };

    const reconnectLater = () => {
      window.clearTimeout(retry);
      if (closed) return;
      retry = window.setTimeout(open, delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    };

    const beat = (seconds: number) => {
      window.clearInterval(keepAlive);
      keepAlive = window.setInterval(() => {
        const current = socket;
        if (!current || current.readyState !== WebSocket.OPEN) return;
        // The server answers every KeepAlive, so silence means a connection
        // that died without closing (a TV waking from standby, a dropped Wi-Fi).
        if (Date.now() - lastHeard > seconds * 1500) {
          drop();
          reconnectLater();
          return;
        }
        current.send(JSON.stringify({ MessageType: "KeepAlive" }));
      }, (seconds * 1000) / 2);
    };

    const open = () => {
      window.clearTimeout(retry);
      if (closed) return;
      drop();
      const next = new WebSocket(client.socketUrl());
      socket = next;
      lastHeard = Date.now();
      next.onopen = () => {
        delay = RETRY_MIN_MS;
        lastHeard = Date.now();
        beat(KEEPALIVE_SECONDS);
        void client.capabilities(supportedCommands()).catch(() => {});
      };
      next.onmessage = (event) => {
        lastHeard = Date.now();
        let message: { MessageType?: string; Data?: unknown };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.MessageType === "ForceKeepAlive") {
          beat(typeof message.Data === "number" && message.Data > 0 ? message.Data : KEEPALIVE_SECONDS);
          return;
        }
        if (message.MessageType && message.MessageType !== "KeepAlive") {
          handle(message.MessageType, message.Data).catch((err: unknown) => show(err instanceof Error ? err.message : "A remote command failed."));
        }
      };
      next.onclose = () => {
        if (socket !== next) return;
        window.clearInterval(keepAlive);
        socket = null;
        reconnectLater();
      };
    };

    const revive = () => {
      if (closed || document.hidden) return;
      if (socket && socket.readyState <= WebSocket.OPEN) return;
      delay = RETRY_MIN_MS;
      open();
    };
    open();
    window.addEventListener("online", revive);
    document.addEventListener("visibilitychange", revive);
    return () => {
      closed = true;
      window.removeEventListener("online", revive);
      document.removeEventListener("visibilitychange", revive);
      window.clearTimeout(retry);
      drop();
    };
  }, [client, status, show]);

  const value = useMemo<RemoteValue>(() => {
    const id = () => {
      const chosen = targetRef.current;
      if (!chosen || !client) throw new Error("No device chosen.");
      return chosen.Id;
    };
    return {
      target,
      seenAt,
      notice,
      devices: async () => (client ? client.remoteSessions() : []),
      choose: (session) => {
        missingRef.current = 0;
        setTarget(session);
        setSeenAt(Date.now());
      },
      playPause: async () => {
        await client?.remotePlaystate(id(), "PlayPause");
        setTarget((current) => (current?.PlayState ? { ...current, PlayState: { ...current.PlayState, IsPaused: !current.PlayState.IsPaused } } : current));
        soon();
      },
      seek: async (seconds) => {
        await client?.remotePlaystate(id(), "Seek", seconds * 10_000_000);
        setTarget((current) => (current ? { ...current, PlayState: { ...current.PlayState, PositionTicks: seconds * 10_000_000 } } : current));
        setSeenAt(Date.now());
        soon();
      },
      stop: async () => {
        await client?.remotePlaystate(id(), "Stop");
        soon();
      },
      setVolume: async (volume) => {
        await client?.remoteCommand(id(), "SetVolume", { Volume: String(Math.round(volume)) });
        setTarget((current) => (current ? { ...current, PlayState: { ...current.PlayState, VolumeLevel: volume } } : current));
        soon();
      },
      toggleMute: async () => {
        await client?.remoteCommand(id(), "ToggleMute");
        soon();
      },
    };
  }, [target, seenAt, notice, client]);

  return (
    <RemoteContext.Provider value={value}>
      {children}
      {message ? (
        <div className="toast remote-message" role="status">
          {message}
        </div>
      ) : null}
    </RemoteContext.Provider>
  );
}

/** Picks a remote's audio and subtitle choice once mpv has opened a file it
 * plays as is; a transcode already carries them. */
async function pickMpvTracks(method: () => string | undefined, audio?: number, subtitle?: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await wait(500);
    if (method() === "Transcode") return;
    const tracks = await playerRequest(["get_property", "track-list"]).catch(() => null);
    if (!Array.isArray(tracks) || !(tracks as Track[]).some((track) => track.type === "audio")) continue;
    if (audio !== undefined && audio >= 0) await selectTrack("audio", audio);
    if (subtitle !== undefined) await selectTrack("sub", subtitle);
    return;
  }
}

/** Picks the mpv track matching a Jellyfin stream index; -1 turns subtitles off. */
async function selectTrack(type: "audio" | "sub", index: number) {
  const property = type === "audio" ? "aid" : "sid";
  if (index < 0) {
    await playerRequest(["set_property", property, "no"]);
    return;
  }
  const tracks = await playerRequest(["get_property", "track-list"]);
  const match = Array.isArray(tracks) ? (tracks as Track[]).find((track) => track.type === type && !track.external && track["ff-index"] === index) : undefined;
  if (match) await playerRequest(["set_property", property, match.id]);
}

export function useRemote() {
  const value = useContext(RemoteContext);
  if (!value) throw new Error("Remote missing");
  return value;
}
