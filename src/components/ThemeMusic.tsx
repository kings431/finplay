import { useEffect, useState } from "react";
import { IconMusic } from "../icons";
import { usePlayback } from "../playback";
import { useClient, useSession } from "../session";
import { loadSettings } from "../settings";
import { onThemeSongChange, playThemeSong, setThemeSongMuted, stopThemeSong, themeSongMuted, themeSongPlaying } from "../themeMusic";

/** Settings > Play theme music: a title's theme song under its page, stopped
 * when the page closes or anything starts playing. Shows a mute button while it plays. */
export function ThemeMusic({ itemId }: { itemId: string }) {
  const client = useClient();
  const { status } = useSession();
  const { active, busy } = usePlayback();
  const [playing, setPlaying] = useState(themeSongPlaying);
  const [muted, setMuted] = useState(themeSongMuted);
  const enabled = status === "ready" && loadSettings().themeMusic;
  const quiet = Boolean(active) || busy;

  useEffect(
    () =>
      onThemeSongChange(() => {
        setPlaying(themeSongPlaying());
        setMuted(themeSongMuted());
      }),
    [],
  );

  useEffect(() => {
    if (!enabled || quiet) {
      stopThemeSong(true);
      return;
    }
    let cancel = false;
    client
      .themeSongs(itemId)
      .then((songs) => {
        if (!cancel && songs[0] && !document.hidden) playThemeSong(client.auth, songs[0]);
      })
      .catch(() => {});
    const onHidden = () => document.hidden && stopThemeSong(true);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      cancel = true;
      document.removeEventListener("visibilitychange", onHidden);
      stopThemeSong();
    };
  }, [client, itemId, enabled, quiet]);

  if (!playing) return null;
  return (
    <button
      className={`btn-round theme-music${muted ? "" : " on"}`}
      onClick={() => setThemeSongMuted(!muted)}
      aria-label={muted ? "Unmute theme music" : "Mute theme music"}
      aria-pressed={!muted}
      title={muted ? "Unmute theme music" : "Mute theme music"}
    >
      <IconMusic size={18} muted={muted} />
    </button>
  );
}
