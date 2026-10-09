import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { secondsToTicks, ticksToSeconds } from "./media";
import { usePlayback, usePlaybackClock, type PlayOptions } from "./playback";
import { useSession } from "./session";
import type { BaseItem, SyncGroup } from "./types";

type QueueUpdate = {
  Reason?: string;
  Playlist?: { ItemId: string; PlaylistItemId: string }[];
  PlayingItemIndex?: number;
  StartPositionTicks?: number;
  IsPlaying?: boolean;
};

type SyncCommand = { Command: "Unpause" | "Pause" | "Seek" | "Stop"; When: string; PositionTicks: number; PlaylistItemId?: string };

type SyncPlayValue = {
  group: SyncGroup | null;
  state: string;
  notice: string;
  error: string;
  groups: () => Promise<SyncGroup[]>;
  create: (name: string) => Promise<void>;
  join: (groupId: string) => Promise<void>;
  leave: () => Promise<void>;
  /** Starts this title for everyone in the group. */
  playTogether: (item: BaseItem, options?: PlayOptions) => Promise<void>;
};

const SyncPlayContext = createContext<SyncPlayValue | null>(null);
const LOAD_KINDS = new Set(["NewPlaylist", "SetCurrentItem", "NextItem", "PreviousItem"]);
/** Local drift, in seconds, past which a jump counts as the user seeking. */
const SEEK_TOLERANCE = 4;

export function SyncPlayProvider({ children }: { children: ReactNode }) {
  const { client, status, username } = useSession();
  const playback = usePlayback();
  const clock = usePlaybackClock();
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const [group, setGroup] = useState<SyncGroup | null>(null);
  const [state, setState] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const keepAliveRef = useRef(0);
  const offsetRef = useRef(0);
  const groupRef = useRef<SyncGroup | null>(null);
  const itemRef = useRef("");
  const sourceRef = useRef<string | undefined>(undefined);
  const loadingRef = useRef(false);
  const expectRef = useRef({ paused: true, position: 0, at: Date.now(), quietUntil: 0 });
  const timersRef = useRef<number[]>([]);
  groupRef.current = group;

  const serverNow = () => new Date(Date.now() + offsetRef.current).toISOString();

  const expect = (paused: boolean, position: number, quietMs = 1500) => {
    expectRef.current = { paused, position, at: Date.now(), quietUntil: Date.now() + quietMs };
  };

  const later = (fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  };

  const clearTimers = () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  };

  const say = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? "" : current)), 5000);
  }, []);

  const syncClock = useCallback(async () => {
    if (!client) return;
    let best = { offset: 0, rtt: Number.POSITIVE_INFINITY };
    for (let attempt = 0; attempt < 3; attempt++) {
      const sent = Date.now();
      const reply = await client.utcTime().catch(() => null);
      const back = Date.now();
      if (!reply) continue;
      const received = Date.parse(reply.RequestReceptionTime);
      const answered = Date.parse(reply.ResponseTransmissionTime);
      const rtt = back - sent - (answered - received);
      if (rtt < best.rtt) best = { offset: (received - sent + (answered - back)) / 2, rtt };
    }
    if (Number.isFinite(best.rtt)) {
      offsetRef.current = best.offset;
      await client.sync("Ping", { Ping: Math.max(0, Math.round(best.rtt)) }).catch(() => {});
    }
  }, [client]);

  const waitForPlayer = async (itemId: string) => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const current = playbackRef.current;
      if (current.active?.item.Id === itemId && clockRef.current.duration > 0) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    return false;
  };

  const loadQueue = useCallback(
    async (queue: QueueUpdate) => {
      if (!client) return;
      const entry = queue.Playlist?.[queue.PlayingItemIndex ?? 0];
      if (!entry) return;
      if (!LOAD_KINDS.has(queue.Reason ?? "") && entry.PlaylistItemId === itemRef.current) return;
      clearTimers();
      itemRef.current = entry.PlaylistItemId;
      loadingRef.current = true;
      const ticks = queue.StartPositionTicks ?? 0;
      const body = (positionTicks: number) => ({ When: serverNow(), PositionTicks: positionTicks, IsPlaying: false, PlaylistItemId: entry.PlaylistItemId });
      try {
        await client.sync("Buffering", body(ticks));
        const item = await client.item(entry.ItemId);
        const mediaSourceId = sourceRef.current && sourceRef.current.startsWith(`${entry.ItemId}:`) ? sourceRef.current.slice(entry.ItemId.length + 1) : undefined;
        await playbackRef.current.play(item, { startAt: ticksToSeconds(ticks), returnTo: "/together", mediaSourceId, local: true });
        if (!(await waitForPlayer(item.Id))) throw new Error("The title didn't start in time.");
        await playbackRef.current.setPaused(true);
        expect(true, ticksToSeconds(ticks));
        await client.sync("Ready", body(ticks));
      } catch (err) {
        setError(err instanceof Error ? `Couldn't load the group's title: ${err.message}` : "Couldn't load the group's title.");
      } finally {
        loadingRef.current = false;
      }
    },
    [client],
  );

  const runCommand = useCallback(
    async (command: SyncCommand) => {
      if (!client) return;
      const current = playbackRef.current;
      const position = ticksToSeconds(command.PositionTicks);
      if (command.Command === "Stop") {
        clearTimers();
        expect(true, 0);
        if (current.active) await current.stop().catch(() => {});
        return;
      }
      if (!current.active || loadingRef.current) return;
      clearTimers();
      if (command.Command === "Unpause") {
        const delay = Date.parse(command.When) - (Date.now() + offsetRef.current);
        if (delay > 0) {
          expect(true, position, delay + 1500);
          await current.seek(position);
          later(() => {
            expect(false, position);
            void playbackRef.current.setPaused(false);
          }, delay);
        } else {
          const caughtUp = position + -delay / 1000;
          expect(false, caughtUp);
          await current.seek(caughtUp);
          await current.setPaused(false);
        }
      } else if (command.Command === "Pause") {
        expect(true, position);
        await current.setPaused(true);
        await current.seek(position);
      } else if (command.Command === "Seek") {
        expect(true, position, 3000);
        await current.setPaused(true);
        await current.seek(position);
        later(() => {
          void client.sync("Ready", { When: serverNow(), PositionTicks: command.PositionTicks, IsPlaying: false, PlaylistItemId: command.PlaylistItemId ?? itemRef.current });
        }, 600);
      }
    },
    [client],
  );

  const closeSocket = useCallback(() => {
    window.clearInterval(keepAliveRef.current);
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  }, []);

  const connect = useCallback(async () => {
    if (!client) throw new Error("Not signed in.");
    const open = socketRef.current;
    if (open && open.readyState === WebSocket.OPEN) return;
    closeSocket();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(client.socketUrl());
      socketRef.current = socket;
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Couldn't open a live connection to the server."));
      socket.onclose = () => {
        window.clearInterval(keepAliveRef.current);
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        if (groupRef.current) {
          say("Connection dropped. Reconnecting…");
          window.setTimeout(() => {
            const lost = groupRef.current;
            if (lost) void connect().then(() => client.sync("Join", { GroupId: lost.GroupId })).catch(() => setError("Lost the connection to the group."));
          }, 3000);
        }
      };
      socket.onmessage = (event) => {
        let message: { MessageType?: string; Data?: unknown };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.MessageType === "ForceKeepAlive") {
          const seconds = typeof message.Data === "number" && message.Data > 0 ? message.Data : 60;
          window.clearInterval(keepAliveRef.current);
          keepAliveRef.current = window.setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ MessageType: "KeepAlive" })), (seconds * 1000) / 2);
        } else if (message.MessageType === "SyncPlayCommand") {
          void runCommand(message.Data as SyncCommand);
        } else if (message.MessageType === "SyncPlayGroupUpdate") {
          const update = message.Data as { Type: string; Data: unknown };
          switch (update.Type) {
            case "GroupJoined":
              setGroup(update.Data as SyncGroup);
              setState((update.Data as SyncGroup).State);
              setError("");
              break;
            case "UserJoined":
              setGroup((current) => (current ? { ...current, Participants: [...current.Participants.filter((name) => name !== update.Data), String(update.Data)] } : current));
              say(`${update.Data} joined`);
              break;
            case "UserLeft":
              setGroup((current) => (current ? { ...current, Participants: current.Participants.filter((name) => name !== update.Data) } : current));
              say(`${update.Data} left`);
              break;
            case "GroupLeft":
            case "NotInGroup":
              setGroup(null);
              itemRef.current = "";
              break;
            case "StateUpdate":
              setState((update.Data as { State: string }).State);
              break;
            case "PlayQueue":
              void loadQueue(update.Data as QueueUpdate);
              break;
            case "GroupDoesNotExist":
              setError("That group no longer exists.");
              setGroup(null);
              break;
            case "CreateGroupDenied":
            case "JoinGroupDenied":
              setError("Your account isn't allowed to use SyncPlay. An admin can allow it in the user's settings.");
              break;
            case "LibraryAccessDenied":
              setError("Someone in the group can't access this title, so it can't be played together.");
              break;
          }
        }
      };
    });
  }, [client, closeSocket, loadQueue, runCommand, say]);

  useEffect(() => {
    if (status === "anon" || !client) {
      setGroup(null);
      closeSocket();
    }
  }, [status, client, closeSocket]);

  useEffect(() => () => closeSocket(), [closeSocket]);

  useEffect(() => {
    if (!group) return;
    const timer = window.setInterval(() => void syncClock(), 60_000);
    return () => window.clearInterval(timer);
  }, [group, syncClock]);

  useEffect(() => {
    if (!group || !client || loadingRef.current || !playback.active) return;
    const expected = expectRef.current;
    const now = Date.now();
    if (now < expected.quietUntil) return;
    if (clock.paused !== expected.paused) {
      expect(clock.paused, clock.position);
      void client.sync(clock.paused ? "Pause" : "Unpause");
      return;
    }
    const projected = expected.paused ? expected.position : expected.position + (now - expected.at) / 1000;
    if (Math.abs(clock.position - projected) > SEEK_TOLERANCE) {
      expect(true, clock.position, 3000);
      void client.sync("Seek", { PositionTicks: secondsToTicks(clock.position) });
      return;
    }
    expectRef.current = { ...expected, position: clock.position, at: now };
  }, [group, client, playback.active, clock.paused, clock.position]);

  const enter = useCallback(
    async (action: "New" | "Join", body: Record<string, unknown>) => {
      if (!client) return;
      setError("");
      await connect();
      await syncClock();
      await client.sync(action, body);
    },
    [client, connect, syncClock],
  );

  const value = useMemo<SyncPlayValue>(
    () => ({
      group,
      state,
      notice,
      error,
      groups: async () => (client ? client.syncGroups() : []),
      create: (name) => enter("New", { GroupName: name.trim() || `${username}'s room` }),
      join: (groupId) => enter("Join", { GroupId: groupId }),
      leave: async () => {
        clearTimers();
        await client?.sync("Leave").catch(() => {});
        setGroup(null);
        itemRef.current = "";
        closeSocket();
      },
      playTogether: async (item, options) => {
        if (!client) return;
        let target = item;
        if (item.Type === "Series") {
          const next = (await client.nextUp(item.Id)).Items?.[0];
          if (!next) throw new Error("This series has no next episode to start.");
          target = next;
        }
        sourceRef.current = options?.mediaSourceId ? `${target.Id}:${options.mediaSourceId}` : undefined;
        const percent = target.UserData?.PlayedPercentage ?? 0;
        const resumeTicks = options?.fromStart || percent > 97 ? 0 : options?.startAt != null ? secondsToTicks(options.startAt) : target.UserData?.PlaybackPositionTicks ?? 0;
        await client.sync("SetNewQueue", { PlayingQueue: [target.Id], PlayingItemPosition: 0, StartPositionTicks: resumeTicks });
      },
    }),
    [group, state, notice, error, client, enter, username, closeSocket],
  );

  return <SyncPlayContext.Provider value={value}>{children}</SyncPlayContext.Provider>;
}

export function useSyncPlay() {
  const value = useContext(SyncPlayContext);
  if (!value) throw new Error("SyncPlay missing");
  return value;
}
