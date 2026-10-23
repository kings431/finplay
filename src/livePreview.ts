import { useCallback, useEffect, useRef, useState } from "react";
import type { Jellyfin } from "./jellyfin";
import { mediaUrl } from "./media";

export type PreviewState = "idle" | "loading" | "playing" | "error";

/** Pointing at a channel for this long opens its preview; skimming past a row opens nothing. */
const DWELL_MS = 900;
/** Waiting longer than this for the server to hand back a tuner, before starting the real stream, isn't worth it. */
const RELEASE_MS = 1500;

type Opened = { playSessionId?: string; liveStreamId?: string; hls?: { destroy(): void } };

async function release(client: Jellyfin, opened: Opened) {
  await Promise.race([
    Promise.allSettled([
      opened.playSessionId ? client.stopEncoding(opened.playSessionId) : null,
      opened.liveStreamId ? client.closeLiveStream(opened.liveStreamId) : null,
    ]),
    new Promise((resolve) => window.setTimeout(resolve, RELEASE_MS)),
  ]);
}

/**
 * A muted, low-bitrate look at what a channel is showing, in the <video> that
 * `props` go on. It opens `DWELL_MS` after `channelId` settles, keeps one
 * stream open at a time and gives the tuner back when the channel changes, the
 * preview is turned off, or the page goes. `stop` does that now, for starting
 * the real stream without the preview holding a connection.
 */
export function useLivePreview(client: Jellyfin | undefined, channelId: string | null, enabled: boolean) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<PreviewState>("idle");
  const opened = useRef<Opened | null>(null);

  const stop = useCallback(async () => {
    const current = opened.current;
    opened.current = null;
    current?.hls?.destroy();
    const element = video.current;
    if (element) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    setState("idle");
    if (client && current) await release(client, current);
  }, [client]);

  useEffect(() => {
    if (!client || !channelId || !enabled) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setState("loading");
      let info;
      try {
        info = await client.livePreview(channelId);
      } catch {
        if (!cancelled) setState("error");
        return;
      }
      const source = info.MediaSources?.[0];
      const mine: Opened = { playSessionId: info.PlaySessionId, liveStreamId: source?.LiveStreamId ?? undefined };
      if (cancelled || !source) {
        await release(client, mine);
        if (!cancelled) setState("error");
        return;
      }
      opened.current = mine;
      try {
        const element = video.current;
        if (!element) throw new Error("No video element.");
        const url = mediaUrl(client.auth, channelId, source, info.PlaySessionId, "Video");
        element.muted = true;
        // The TV's own HLS player decodes in hardware; elsewhere hls.js is steadier than a browser's partial support.
        const Hls = "tizen" in window ? null : (await import("hls.js")).default;
        if (cancelled) return;
        if (Hls?.isSupported()) {
          const instance = new Hls({ lowLatencyMode: false, maxBufferLength: 8, backBufferLength: 0 });
          mine.hls = instance;
          instance.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal && !cancelled) setState("error");
          });
          instance.loadSource(url);
          instance.attachMedia(element);
        } else {
          element.src = url;
        }
        await element.play().catch(() => {
          // Autoplay can be refused; the picture stays on the poster then.
        });
      } catch {
        if (!cancelled) setState("error");
      }
    }, DWELL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void stop();
    };
  }, [client, channelId, enabled, stop]);

  const props = {
    ref: video,
    muted: true,
    playsInline: true,
    onPlaying: () => setState("playing"),
  };
  return { props, state: enabled && channelId ? state : "idle", stop };
}
