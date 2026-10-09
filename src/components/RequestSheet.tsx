import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconClose } from "../icons";
import { tile } from "../media";
import { useClient } from "../session";
import type { SeerrResult, SeerrTv } from "../types";

export function SeerrCard({ result, onOpen }: { result: SeerrResult; onOpen: (result: SeerrResult) => void }) {
  const status = seerrStatus(result.mediaInfo?.status);
  const poster = seerrPoster(result.posterPath);
  const name = result.title ?? result.name ?? "";
  const year = (result.releaseDate ?? result.firstAirDate ?? "").slice(0, 4);
  return (
    <button className="poster" onClick={() => onOpen(result)}>
      <span className="poster-art" style={{ background: tile(name) }}>
        {poster ? <img src={poster} alt="" loading="lazy" decoding="async" /> : null}
        {status ? <em className={`seerr-badge ${status.tone}`}>{status.label}</em> : null}
      </span>
      <span className="poster-title">
        {name}
        <small>
          {" "}
          {[result.voteAverage ? `★ ${result.voteAverage.toFixed(1)}` : "", year].filter(Boolean).join(" · ")}
        </small>
      </span>
    </button>
  );
}

/** Opens library items directly and everything else in the request sheet. */
export function useSeerrPicker(onRequested: (mediaType: string, id: number) => void) {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<SeerrResult | null>(null);
  const open = useCallback(
    (result: SeerrResult) => {
      const libraryId = result.mediaInfo?.jellyfinMediaId;
      if (libraryId && result.mediaInfo?.status === 5) navigate(`/item/${libraryId}`);
      else setPicked(result);
    },
    [navigate],
  );
  const sheet = picked ? <RequestSheet result={picked} onClose={() => setPicked(null)} onRequested={onRequested} /> : null;
  return { open, sheet };
}

export function markRequested(list: SeerrResult[], mediaType: string, id: number) {
  return list.map((result) =>
    result.mediaType === mediaType && result.id === id ? { ...result, mediaInfo: { ...result.mediaInfo, status: 2 } } : result,
  );
}

export function seerrPoster(path?: string | null, size = "w342") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

export function seerrStatus(status?: number) {
  if (status === 5) return { label: "In library", tone: "ok" };
  if (status === 4) return { label: "Partly in library", tone: "ok" };
  if (status === 3) return { label: "Processing", tone: "wait" };
  if (status === 2) return { label: "Requested", tone: "wait" };
  return null;
}

export function RequestSheet({
  result,
  onClose,
  onRequested,
}: {
  result: SeerrResult;
  onClose: () => void;
  onRequested: (mediaType: string, id: number) => void;
}) {
  const client = useClient();
  const [tv, setTv] = useState<SeerrTv | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const isTv = result.mediaType === "tv";
  const status = seerrStatus(result.mediaInfo?.status);
  const name = result.title ?? result.name ?? "";
  const backdrop = seerrPoster(result.backdropPath, "w1280");

  useEffect(() => {
    if (!isTv) return;
    let cancel = false;
    client
      .seerrTv(result.id)
      .then((detail) => {
        if (cancel) return;
        setTv(detail);
        setChosen(requestable(detail).map((season) => season.seasonNumber));
      })
      .catch(() => {
        if (!cancel) setMessage("Could not load the seasons for this show.");
      });
    return () => {
      cancel = true;
    };
  }, [client, isTv, result.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    setBusy(true);
    setMessage("");
    try {
      await client.seerrRequest(isTv ? { mediaType: "tv", mediaId: result.id, seasons: chosen } : { mediaType: "movie", mediaId: result.id });
      setDone(true);
      onRequested(result.mediaType, result.id);
    } catch (err) {
      setMessage(err instanceof Error ? `Request failed. ${err.message}` : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  const seasons = tv ? tv.seasons.filter((season) => season.seasonNumber > 0) : [];
  const seasonState = new Map((tv?.mediaInfo?.seasons ?? []).map((season) => [season.seasonNumber, season.status]));
  const fullyHandled = status !== null && (!isTv || (tv !== null && requestable(tv).length === 0));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        {backdrop ? <img className="sheet-art" src={backdrop} alt="" /> : null}
        <div className="sheet-shade" />
        <button className="btn-round sheet-close" onClick={onClose} aria-label="Close">
          <IconClose size={18} />
        </button>
        <div className="sheet-body">
          <p className="eyebrow">{isTv ? "Series" : "Movie"} · {(result.releaseDate ?? result.firstAirDate ?? "").slice(0, 4)}</p>
          <h1>{name}</h1>
          {result.overview ? <p className="sheet-overview">{result.overview}</p> : null}
          {isTv && seasons.length > 0 ? (
            <div className="season-picks">
              {seasons.map((season) => {
                const state = seerrStatus(seasonState.get(season.seasonNumber));
                const on = chosen.includes(season.seasonNumber);
                return (
                  <button
                    key={season.seasonNumber}
                    className={on ? "on" : ""}
                    disabled={state !== null || done}
                    onClick={() =>
                      setChosen((current) => (on ? current.filter((n) => n !== season.seasonNumber) : [...current, season.seasonNumber]))
                    }
                  >
                    {season.name}
                    <small>{state ? state.label : `${season.episodeCount} episodes`}</small>
                  </button>
                );
              })}
            </div>
          ) : null}
          {message ? <p className="error-text">{message}</p> : null}
          <div className="hero-actions">
            {done ? (
              <button className="btn-play" disabled>
                Requested
              </button>
            ) : fullyHandled ? (
              <button className="btn-play" disabled>
                {status?.label}
              </button>
            ) : (
              <button className="btn-play" disabled={busy || (isTv && chosen.length === 0)} onClick={() => void submit()}>
                {busy ? "Requesting…" : isTv ? `Request ${chosen.length === seasons.length ? "all seasons" : `${chosen.length} season${chosen.length === 1 ? "" : "s"}`}` : "Request"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function requestable(tv: SeerrTv) {
  const handled = new Set((tv.mediaInfo?.seasons ?? []).filter((season) => season.status >= 2).map((season) => season.seasonNumber));
  return tv.seasons.filter((season) => season.seasonNumber > 0 && !handled.has(season.seasonNumber));
}
