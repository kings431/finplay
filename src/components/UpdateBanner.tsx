import { useEffect, useState } from "react";
import { usePlayback } from "../playback";
import { findUpdate, installUpdate, type Update } from "../updates";

const SNOOZE_KEY = "finplay.update.snoozed";

export function UpdateBanner() {
  const { active } = usePlayback();
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (import.meta.env.DEV) return;
    const timer = window.setTimeout(() => {
      findUpdate()
        .then((found) => {
          if (found && localStorage.getItem(SNOOZE_KEY) !== found.version) setUpdate(found);
        })
        .catch(() => {});
    }, 8000);
    return () => window.clearTimeout(timer);
  }, []);

  if (!update) return null;

  async function install() {
    if (!update) return;
    setError("");
    setProgress(0);
    try {
      await installUpdate(update, setProgress);
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="banner update-banner">
      <p>
        {error
          ? `The update didn't install: ${error}`
          : progress !== null
            ? progress < 0
              ? "Downloading the update…"
              : `Downloading the update… ${progress}%`
            : `Finplay ${update.version} is ready to install.${active ? " Finish what you're watching first." : ""}`}
      </p>
      {progress === null ? (
        <>
          <button disabled={Boolean(active)} onClick={() => void install()}>
            {error ? "Try again" : "Update and restart"}
          </button>
          <button
            onClick={() => {
              localStorage.setItem(SNOOZE_KEY, update.version);
              setUpdate(null);
            }}
          >
            Later
          </button>
        </>
      ) : null}
    </div>
  );
}
