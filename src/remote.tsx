import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ticksToSeconds } from "./media";
import { usePlayback } from "./playback";
import { inTauri, playerRequest } from "./player";
import { useSession } from "./session";
import type { RemoteSession } from "./types";

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

type PlayMessage = { ItemIds?: string[]; StartPositionTicks?: number; PlayCommand?: string; MediaSourceId?: string; AudioStreamIndex?: number; SubtitleStreamIndex?: number };
type PlaystateMessage = { Command?: string; SeekPositionTicks?: number };
type GeneralMessage = { Name?: string; Arguments?: Record<string, string> };
type Track = { id: number; type: string; "ff-index"?: number; external?: boolean };

const RemoteContext = createContext<RemoteValue | null>(null);
const POLL_MS = 2000;
/** Polls in a row a chosen device may be missing before it counts as gone. */
const MISSING_LIMIT = 4;

export function RemoteProvider({ children }: { children: ReactNode }) {
  const { client, status } = useSession();
  const playback = usePlayback();
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const [target, setTarget] = useState<RemoteSession | null>(null);
  const [seenAt, setSeenAt] = useState(0);
  const [notice, setNotice] = useState("");
  const targetRef = useRef<RemoteSession | null>(null);
  const missingRef = useRef(0);
  const pollRef = useRef<() => Promise<void>>(async () => {});
  targetRef.current = target;

  const say = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? "" : current)), 5000);
  }, []);

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
    const timer = window.setInterval(() => void pollRef.current(), POLL_MS);
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

  // Commands from other clients that chose this app to play on.
  useEffect(() => {
    if (!client || status !== "ready" || !inTauri()) return;
    let socket: WebSocket | null = null;
    let keepAlive = 0;
    let retry = 0;
    let closed = false;

    const handle = async (type: string, data: unknown) => {
      const current = playbackRef.current;
      if (type === "Play") {
        const message = data as PlayMessage;
        const id = message.ItemIds?.[0];
        if (!id || (message.PlayCommand && message.PlayCommand !== "PlayNow")) return;
        const item = await client.item(id);
        await current.play(item, {
          local: true,
          resume: true,
          startAt: ticksToSeconds(message.StartPositionTicks ?? 0),
          mediaSourceId: message.MediaSourceId,
        });
        return;
      }
      if (type === "Playstate") {
        const message = data as PlaystateMessage;
        if (!current.active) return;
        switch (message.Command) {
          case "Stop":
            return current.stop();
          case "Pause":
            return current.setPaused(true);
          case "Unpause":
            return current.setPaused(false);
          case "PlayPause":
            return current.togglePause();
          case "Seek":
            return current.seek(ticksToSeconds(message.SeekPositionTicks ?? 0));
          case "Rewind":
            return current.seek(Math.max(0, current.position - 10));
          case "FastForward":
            return current.seek(current.position + 30);
        }
        return;
      }
      if (type === "GeneralCommand") {
        const { Name: name, Arguments: args = {} } = data as GeneralMessage;
        if (name === "DisplayMessage") {
          const text = [args.Header, args.Text].filter(Boolean).join(": ");
          if (current.active) await playerRequest(["show-text", text, Number(args.TimeoutMs) || 4000]);
          else say(text);
          return;
        }
        if (!current.active) return;
        switch (name) {
          case "SetVolume":
            return void (await playerRequest(["set_property", "volume", Math.max(0, Math.min(100, Number(args.Volume)))]));
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
            return void (await playerRequest(["script-message", "finplay-fullscreen"]));
          case "SetAudioStreamIndex":
            return selectTrack("audio", Number(args.Index));
          case "SetSubtitleStreamIndex":
            return selectTrack("sub", Number(args.Index));
        }
      }
    };

    const open = () => {
      const next = new WebSocket(client.socketUrl());
      socket = next;
      next.onmessage = (event) => {
        let message: { MessageType?: string; Data?: unknown };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.MessageType === "ForceKeepAlive") {
          const seconds = typeof message.Data === "number" && message.Data > 0 ? message.Data : 60;
          window.clearInterval(keepAlive);
          keepAlive = window.setInterval(() => next.readyState === WebSocket.OPEN && next.send(JSON.stringify({ MessageType: "KeepAlive" })), (seconds * 1000) / 2);
          return;
        }
        if (message.MessageType) {
          handle(message.MessageType, message.Data).catch((err: unknown) => say(err instanceof Error ? err.message : "A remote command failed."));
        }
      };
      next.onopen = () => void client.capabilities().catch(() => {});
      next.onclose = () => {
        window.clearInterval(keepAlive);
        if (!closed) retry = window.setTimeout(open, 5000);
      };
    };
    open();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearInterval(keepAlive);
      socket?.close();
    };
  }, [client, status, say]);

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

  return <RemoteContext.Provider value={value}>{children}</RemoteContext.Provider>;
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
