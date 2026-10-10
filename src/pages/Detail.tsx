import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { IconBack, IconCheck, IconFilm, IconHeart, IconPlay } from "../icons";
import { playRemoteTrailer, trailerStream } from "../trailer";
import {
  audioStream,
  backdropUrl,
  episodeCode,
  formatRuntime,
  tile,
  logoUrl,
  prettyCodec,
  primaryUrl,
  resolutionLabel,
  thumbUrl,
  videoStream,
} from "../media";
import { Poster, Scroller } from "../components/Cards";
import { DownloadButton, SeasonDownload, UnwatchedDownload } from "../components/DownloadButton";
import { AddToPlaylist } from "../components/AddToPlaylist";
import { ExtrasRow, sortExtras } from "../components/Extras";
import { ThemeMusic } from "../components/ThemeMusic";
import { downloadImage, useDownloads } from "../downloads";
import { inTauri } from "../player";
import { usePlayback, type PlayOptions } from "../playback";
import { useSyncPlay } from "../syncplay";
import { invalidate, useCached } from "../cache";
import { useClient, useSession } from "../session";
import type { BaseItem, MediaSource, Person as PersonCredit } from "../types";

function TrailerButton({ item }: { item: BaseItem }) {
  const client = useClient();
  const { play, busy } = usePlayback();
  const [opening, setOpening] = useState(false);
  const [note, setNote] = useState("");
  const remote = item.RemoteTrailers?.find((trailer) => trailer.Url)?.Url;
  if (!item.LocalTrailerCount && !remote) return null;

  async function open() {
    setNote("");
    setOpening(true);
    try {
      const local = item.LocalTrailerCount ? (await client.localTrailers(item.Id).catch(() => []))[0] : undefined;
      if (local) {
        await play(local, { fromStart: true, returnTo: `/item/${item.Id}` });
      } else if (remote) {
        const stream = await trailerStream(remote);
        if (stream) {
          await play(item, { trailerUrl: stream, returnTo: `/item/${item.Id}` });
        } else {
          const where = await playRemoteTrailer(remote, item.Name);
          if (where === "window") setNote("Playing in the trailer window. Install yt-dlp to play trailers in Finplay.");
        }
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      <button className="btn-round" disabled={busy || opening} onClick={() => void open()} aria-label="Trailer" title="Watch trailer">
        <IconFilm size={19} />
      </button>
      {note ? <span className="trailer-note">{note}</span> : null}
    </>
  );
}

export function Detail() {
  const { id = "" } = useParams();
  const client = useClient();
  const session = useSession();
  const downloads = useDownloads();
  const playback = usePlayback();
  const together = useSyncPlay();
  const busy = playback.busy;
  const offline = session.status === "offline";
  const local = downloads.find(id);
  const play = (target: BaseItem, options?: PlayOptions) =>
    together.group ? together.playTogether(target, options).catch(() => playback.play(target, options)) : playback.play(target, options);
  const navigate = useNavigate();
  const [pickedSeason, setPickedSeason] = useState("");
  const [pickedSource, setPickedSource] = useState("");
  const [logoBroken, setLogoBroken] = useState(false);
  const [favorite, setFavorite] = useState<boolean | undefined>();
  const [played, setPlayed] = useState<Record<string, boolean>>({});
  const [version, setVersion] = useState(0);
  const [localArt, setLocalArt] = useState<string>();

  const { data, error } = useCached(offline ? null : `item:${id}`, async () => {
    const item = await client.item(id);
    const seriesId = item.Type === "Series" ? item.Id : item.Type === "Episode" ? item.SeriesId : undefined;
    const seasons = seriesId ? ((await client.seasons(seriesId)).Items ?? []) : [];
    const children =
      item.Type === "BoxSet" || item.Type === "CollectionFolder"
        ? ((await client.items({ parentId: item.Id, recursive: false, sortBy: "SortName", limit: 200 })).Items ?? [])
        : [];
    return { item, seasons, children };
  });
  const item = data?.item ?? (local?.state === "done" || local?.state === "downloading" || local?.state === "queued" || local?.state === "failed" ? local.item : undefined);
  const seasons = data?.seasons ?? [];
  const children = data?.children ?? [];
  const seriesId = item?.Type === "Series" ? item.Id : item?.Type === "Episode" ? item.SeriesId : undefined;
  const collection = item?.Type === "BoxSet" || item?.Type === "CollectionFolder";

  const nextUp = useCached(!offline && item?.Type === "Series" ? `nextup:${item.Id}:${version}` : null, async () =>
    item ? ((await client.nextUp(item.Id)).Items?.[0] ?? null) : null,
  ).data;

  const similar = useCached(!offline && item && !collection && (item.Type === "Movie" || item.Type === "Series" || item.Type === "Episode") ? `similar:${item.Type === "Episode" ? item.SeriesId ?? item.Id : item.Id}` : null, async () => {
    if (!item) return [];
    const seed = item.Type === "Episode" && item.SeriesId ? item.SeriesId : item.Id;
    return (await client.similar(seed)).Items ?? [];
  }).data;

  const unwatched = useCached(!offline && item?.Type === "Series" ? `unwatched:${item.Id}:${version}` : null, async () =>
    item
      ? ((
          await client.items({
            parentId: item.Id,
            includeItemTypes: "Episode",
            filters: "IsUnplayed",
            recursive: true,
            sortBy: "ParentIndexNumber,IndexNumber",
            limit: 400,
          })
        ).Items ?? [])
      : [],
  ).data;

  const seasonId =
    pickedSeason ||
    (item?.Type === "Episode" ? item.SeasonId : undefined) ||
    (nextUp && seasons.some((season) => season.Id === nextUp.SeasonId) ? nextUp.SeasonId : undefined) ||
    seasons[0]?.Id ||
    "";
  const sourceId = pickedSource || item?.MediaSources?.[0]?.Id || "";
  const episodes =
    useCached(!offline && seriesId && seasonId ? `episodes:${seriesId}:${seasonId}:${version}` : null, async () =>
      seriesId ? ((await client.episodes(seriesId, seasonId)).Items ?? []) : [],
    ).data ?? [];
  // Tagged with whose they are: the hook hands back the last title's list until the next one loads.
  const ownExtras = useCached(!offline && item && !collection && !item.ExtraType ? `extras:${item.Id}` : null, async () =>
    item ? { id: item.Id, list: sortExtras(await client.specialFeatures(item.Id)) } : null,
  ).data;
  const extras = ownExtras && ownExtras.id === item?.Id ? ownExtras.list : [];
  const seasonOwn = useCached(!offline && seriesId && seasonId ? `extras:${seasonId}` : null, async () => ({
    id: seasonId,
    list: sortExtras(await client.specialFeatures(seasonId)),
  })).data;
  const seasonExtras = seasonOwn && seasonOwn.id === seasonId ? seasonOwn.list : [];

  useEffect(() => {
    setPickedSeason("");
    setPickedSource("");
    setLogoBroken(false);
    setFavorite(undefined);
    setPlayed({});
    setLocalArt(undefined);
    document.querySelector(".main")?.scrollTo({ top: 0 });
  }, [id]);

  useEffect(() => {
    if (!local || (!offline && data?.item)) return;
    let cancel = false;
    const kind = local.images.backdrop ? "backdrop" : local.images.still ? "still" : local.images.poster ? "poster" : "";
    if (!kind) return;
    void downloadImage(local, kind).then((url) => {
      if (!cancel) setLocalArt(url);
    });
    return () => {
      cancel = true;
    };
  }, [local, offline, data?.item]);

  if (!item && error) return <p className="empty">{error}</p>;
  if (!item) {
    if (offline && !local) return <p className="empty">This title isn't downloaded, so it isn't available offline.</p>;
    return <div className="detail-hero"><div className="hero-skeleton" /></div>;
  }

  const backdrop = offline || (!data?.item && local) ? localArt : backdropUrl(session, item);
  const logo = item.Type === "Episode" || offline ? undefined : logoUrl(session, item);
  const progress = offline && local ? (item.RunTimeTicks ? (local.position / (item.RunTimeTicks / 10_000_000)) * 100 : 0) : (item.UserData?.PlayedPercentage ?? 0);
  const canResume = progress > 1 && progress < 97;
  const isFavorite = favorite ?? item.UserData?.IsFavorite ?? false;
  const isPlayed = played[item.Id] ?? (offline && local ? local.played : item.UserData?.Played) ?? false;
  const cast = (item.People ?? []).filter((person) => person.Type === "Actor" || person.Type === "GuestStar").slice(0, 30);
  const crew = (item.People ?? []).filter((person) => CREW_ROLES.includes(person.Type ?? "")).slice(0, 16);
  const sources = item.MediaSources ?? [];
  const source = sources.find((entry) => entry.Id === sourceId) ?? sources[0];
  const season = seasons.find((entry) => entry.Id === seasonId);
  const nextProgress = nextUp?.UserData?.PlayedPercentage ?? 0;
  const firstChild = children.find((entry) => entry.Type === "Movie" || entry.Type === "Series" || entry.Type === "Episode" || entry.Type === "Video");

  async function toggleFavorite() {
    if (!item || offline) return;
    const next = !isFavorite;
    setFavorite(next);
    try {
      await client.setFavorite(item.Id, next);
      invalidate(`item:${item.Id}`);
    } catch {
      setFavorite(!next);
    }
  }

  /** Extras always start at the beginning, play nothing after, and come back here. */
  function playExtra(extra: BaseItem) {
    if (item) void play(extra, { fromStart: true, returnTo: `/item/${item.Id}` });
  }

  /** The title's library, filtered to a genre or studio. */
  async function openFiltered(kind: "genre" | "studio", name: string) {
    if (!item || offline) return;
    const libraries = new Set(session.views.map((view) => view.Id));
    const ancestors = await client.ancestors(item.Id).catch(() => [] as BaseItem[]);
    const library =
      ancestors.find((ancestor) => libraries.has(ancestor.Id))?.Id ??
      session.views.find((view) => view.CollectionType === (item.Type === "Movie" ? "movies" : "tvshows"))?.Id;
    if (library) navigate(`/library/${library}?${new URLSearchParams({ [kind]: name })}`);
  }

  const filterLink = (kind: "genre" | "studio", name: string) => (
    <button key={name} className="filter-link" disabled={offline} onClick={() => void openFiltered(kind, name)} title={`More ${kind === "genre" ? name : `from ${name}`}`}>
      {name}
    </button>
  );

  async function markPlayed(target: BaseItem, next: boolean, event?: MouseEvent) {
    event?.stopPropagation();
    if (offline) return;
    setPlayed((current) => ({ ...current, [target.Id]: next }));
    try {
      await client.setPlayed(target.Id, next);
      invalidate("home:");
      invalidate(`item:${target.Id}`);
      if (target.Type !== "Episode") {
        setPlayed({ [target.Id]: next });
        setVersion((value) => value + 1);
      }
    } catch {
      setPlayed((current) => ({ ...current, [target.Id]: !next }));
    }
  }

  const pills = [
    item.OfficialRating ? <span key="rating" className="pill">{item.OfficialRating}</span> : null,
    item.CommunityRating ? <span key="stars" className="pill star">★ {item.CommunityRating.toFixed(1)}</span> : null,
    item.CriticRating ? <span key="critic" className="pill critic">{item.CriticRating}%</span> : null,
    offline && local ? <span key="offline" className="pill">Downloaded · {local.quality}</span> : null,
  ].filter(Boolean);
  const meta = [
    episodeCode(item),
    yearsOf(item),
    collection && children.length ? `${children.length} titles` : "",
    item.Type === "Series" && seasons.length ? `${seasons.length} ${seasons.length === 1 ? "Season" : "Seasons"}` : "",
    item.Type !== "Series" && !collection ? formatRuntime(item.RunTimeTicks) : "",
    item.Type !== "Series" && !collection && item.RunTimeTicks ? endsAt(item, canResume) : "",
  ].filter(Boolean);
  const facts = factsOf(item, source, (name) => filterLink("studio", name));

  return (
    <article className="detail">
      {together.group ? (
        <div className="banner together-banner">
          <p>
            Watching together in <strong>{together.group.GroupName}</strong>
            {together.state ? ` · ${together.state === "Idle" ? "pick something to play" : together.state}` : ""}. Play starts for everyone in the room.
          </p>
          <button onClick={() => navigate("/together")}>Room</button>
        </div>
      ) : null}
      <div className="detail-hero">
        {backdrop ? <img src={backdrop} alt="" /> : null}
        <div className="hero-shade" />
        <button className="btn-round back" onClick={() => (offline ? navigate("/downloads") : navigate(-1))} aria-label="Back">
          <IconBack size={18} />
        </button>
        <div className="hero-copy">
          {item.SeriesName ? (
            <button className="eyebrow link" onClick={() => item.SeriesId && navigate(`/item/${item.SeriesId}`)} disabled={offline}>
              {item.SeriesName}
              {item.SeasonName ? ` · ${item.SeasonName}` : ""}
            </button>
          ) : null}
          {logo && !logoBroken ? <img className="hero-logo" src={logo} alt={item.Name} onError={() => setLogoBroken(true)} /> : <h1>{item.Name}</h1>}
          <div className="hero-pills">
            {pills}
            {meta.length ? <span className="hero-meta">{meta.join("  ·  ")}</span> : null}
          </div>
          {item.Genres?.length ? (
            <p className="hero-genres">
              {item.Genres.slice(0, 4).map((genre, index) => (
                <span key={genre}>
                  {index ? <i aria-hidden>·</i> : null}
                  {filterLink("genre", genre)}
                </span>
              ))}
            </p>
          ) : null}
          <div className="hero-actions" data-down=".version select, .facts .filter-link">
            {collection ? (
              firstChild ? (
                <button className="btn-play" disabled={busy} onClick={() => void play(firstChild, { resume: true })}>
                  <IconPlay size={16} />
                  {busy ? "Starting…" : `Play ${firstChild.Name}`}
                </button>
              ) : null
            ) : item.Type === "Series" ? (
              <>
                <button className="btn-play" disabled={busy} onClick={() => void play(nextUp ?? item, { resume: true })}>
                  <IconPlay size={16} />
                  {busy ? "Starting…" : nextUp ? `${nextProgress > 1 ? "Resume" : "Play"} ${episodeCode(nextUp)}` : "Play"}
                </button>
                {nextUp && nextProgress > 1 ? (
                  <button className="btn-ghost" disabled={busy} onClick={() => void play(nextUp, { fromStart: true })}>
                    Play from start
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <button
                  className="btn-play"
                  disabled={busy || (offline && local?.state !== "done")}
                  onClick={() => void play(item, { resume: true, mediaSourceId: sourceId || undefined })}
                >
                  <IconPlay size={16} />
                  {busy ? "Starting…" : canResume ? "Resume" : "Play"}
                </button>
                {canResume ? (
                  <button className="btn-ghost" disabled={busy || (offline && local?.state !== "done")} onClick={() => void play(item, { fromStart: true, mediaSourceId: sourceId || undefined })}>
                    Play from start
                  </button>
                ) : null}
              </>
            )}
            {!offline ? (
              <>
                <button className={`btn-round ${isFavorite ? "on-heart" : ""}`} onClick={() => void toggleFavorite()} aria-label="Favorite" title={isFavorite ? "Remove from favorites" : "Add to favorites"}>
                  <IconHeart size={19} filled={isFavorite} />
                </button>
                <button className={`btn-round ${isPlayed ? "on-check" : ""}`} onClick={() => void markPlayed(item, !isPlayed)} aria-label="Watched" title={isPlayed ? "Mark unwatched" : "Mark watched"}>
                  <IconCheck size={19} />
                </button>
                {item.Type === "Movie" || item.Type === "Episode" || item.Type === "Series" || item.Type === "Season" ? <AddToPlaylist item={item} /> : null}
                {inTauri() && (item.Type === "Movie" || item.Type === "Episode") ? <DownloadButton item={item} mediaSourceId={sourceId || undefined} /> : null}
                <TrailerButton item={item} />
                <ThemeMusic itemId={item.Id} />
              </>
            ) : null}
          </div>
          {!offline && sources.length > 1 ? (
            <label className="version">
              Version
              <select value={sourceId} onChange={(event) => setPickedSource(event.target.value)}>
                {sources.map((entry) => (
                  <option key={entry.Id} value={entry.Id}>
                    {versionLabel(entry)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>

      <div className="detail-body">
        <div className="detail-text">
          {item.Taglines?.[0] ? <p className="tagline">{item.Taglines[0]}</p> : null}
          {item.Overview ? <p className="overview">{item.Overview}</p> : null}
          {source ? <MediaChips source={source} /> : null}
        </div>
        {facts.length ? (
          <dl className="facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>

      {item.Type === "Series" && nextUp ? (
        <section className="detail-section">
          <h2>Next up</h2>
          <EpisodeRow
            className="next"
            episode={nextUp}
            played={false}
            onPlay={() => void play(nextUp)}
            onOpen={() => navigate(`/item/${nextUp.Id}`)}
          />
        </section>
      ) : null}

      {seasons.length > 0 ? (
        <section className="detail-section">
          <h2>Seasons</h2>
          <Scroller className="season-track">
            {seasons.map((entry) => {
              const art = primaryUrl(session, entry) ?? (item.Type === "Series" ? primaryUrl(session, item) : undefined);
              const unplayed = entry.UserData?.UnplayedItemCount ?? 0;
              const done = played[entry.Id] ?? entry.UserData?.Played;
              return (
                <button key={entry.Id} className={`season-card ${entry.Id === seasonId ? "on" : ""}`} onClick={() => setPickedSeason(entry.Id)}>
                  <span className="poster-art" style={{ background: tile(entry.Name) }}>
                    {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
                    {done ? (
                      <i className="badge-check">
                        <IconCheck size={13} />
                      </i>
                    ) : unplayed ? (
                      <em>{unplayed}</em>
                    ) : null}
                  </span>
                  <strong>{entry.Name}</strong>
                  {entry.ChildCount ? <small>{entry.ChildCount} episodes</small> : null}
                </button>
              );
            })}
          </Scroller>
          <div className="episodes-head">
            <h3>
              {season?.Name ?? "Episodes"}
              {episodes.length ? <small>{episodes.length} episodes</small> : null}
            </h3>
            <div className="episodes-actions">
              {inTauri() ? <SeasonDownload episodes={episodes} /> : null}
              {inTauri() && item.Type === "Series" && unwatched && unwatched.length > 0 ? <UnwatchedDownload episodes={unwatched} /> : null}
              {season ? (
                <button className="btn-ghost" onClick={() => void markPlayed(season, !(played[season.Id] ?? season.UserData?.Played))}>
                  <IconCheck size={15} />
                  {played[season.Id] ?? season.UserData?.Played ? "Mark season unwatched" : "Mark season watched"}
                </button>
              ) : null}
            </div>
          </div>
          <div className="episode-list">
            {episodes.map((episode) => (
              <EpisodeRow
                key={episode.Id}
                episode={episode}
                current={episode.Id === item.Id}
                played={played[episode.Id] ?? episode.UserData?.Played ?? false}
                onPlay={() => void play(episode)}
                onOpen={() => navigate(`/item/${episode.Id}`)}
                onToggle={(next, event) => void markPlayed(episode, next, event)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {season && seasonExtras.length > 0 ? <ExtrasRow title={`${season.Name} extras`} extras={seasonExtras} onPlay={playExtra} /> : null}
      <ExtrasRow title="Extras" extras={extras} onPlay={playExtra} />

      {children.length > 0 ? (
        <section className="detail-section">
          <h2>{item.Type === "BoxSet" ? "In this collection" : "Titles"}</h2>
          <Scroller>
            {children.map((entry) => (
              <Poster key={entry.Id} item={entry} />
            ))}
          </Scroller>
        </section>
      ) : null}

      {similar && similar.length > 0 ? (
        <section className="detail-section">
          <h2>More like this</h2>
          <Scroller>
            {similar.map((entry) => (
              <Poster key={entry.Id} item={entry} />
            ))}
          </Scroller>
        </section>
      ) : null}

      <PeopleRow title="Cast" people={cast} />
      <PeopleRow title="Crew" people={crew} />
    </article>
  );
}

const CREW_ROLES = ["Director", "Writer", "Creator", "Producer", "Composer"];

function PeopleRow({ title, people }: { title: string; people: PersonCredit[] }) {
  const session = useSession();
  const navigate = useNavigate();
  if (people.length === 0) return null;
  return (
    <section className="detail-section cast">
      <h2>{title}</h2>
      <Scroller>
        {people.map((person, index) => (
          <button
            key={`${person.Id ?? person.Name}-${person.Type}-${index}`}
            className="person"
            disabled={!person.Id}
            onClick={() => person.Id && navigate(`/person/${person.Id}`)}
          >
            <span style={{ background: tile(person.Name || "?") }}>
              {person.Id && person.PrimaryImageTag ? (
                <img
                  src={primaryUrl(session, { Id: person.Id, Name: person.Name || "", Type: "Person", ImageTags: { Primary: person.PrimaryImageTag } })}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <b>{(person.Name || "?").slice(0, 1)}</b>
              )}
            </span>
            <strong>{person.Name}</strong>
            <small>{person.Role || (person.Type === "Actor" ? "" : person.Type)}</small>
          </button>
        ))}
      </Scroller>
    </section>
  );
}

function EpisodeRow({
  episode,
  played,
  current,
  className = "",
  onPlay,
  onOpen,
  onToggle,
}: {
  episode: BaseItem;
  played: boolean;
  current?: boolean;
  className?: string;
  onPlay: () => void;
  onOpen: () => void;
  onToggle?: (next: boolean, event: MouseEvent) => void;
}) {
  const session = useSession();
  const art = thumbUrl(session, episode);
  const watched = episode.UserData?.PlayedPercentage ?? 0;
  const info = [episodeCode(episode), formatRuntime(episode.RunTimeTicks), airDate(episode.PremiereDate)].filter(Boolean).join("  ·  ");
  return (
    <div className={`episode ${className} ${current ? "current" : ""}`}>
      <button className="episode-thumb" style={{ background: tile(episode.Name) }} onClick={onPlay} aria-label={`Play ${episode.Name}`}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : null}
        <span className="thumb-play">
          <IconPlay size={20} />
        </span>
        {played ? (
          <i className="badge-check">
            <IconCheck size={13} />
          </i>
        ) : null}
        {watched > 1 && !played ? (
          <span className="progress">
            <span style={{ width: `${Math.min(100, watched)}%` }} />
          </span>
        ) : null}
      </button>
      <div className="episode-copy" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => event.key === "Enter" && onOpen()}>
        <div className="episode-head">
          <strong>
            {episode.IndexNumber != null ? `${episode.IndexNumber}. ` : ""}
            {episode.Name}
          </strong>
          {onToggle ? (
            <button className={`mini-check ${played ? "on" : ""}`} onClick={(event) => onToggle(!played, event)} title={played ? "Mark unwatched" : "Mark watched"}>
              <IconCheck size={15} />
            </button>
          ) : null}
        </div>
        <small>{info}</small>
        {episode.Overview ? <p>{episode.Overview}</p> : null}
      </div>
    </div>
  );
}

function MediaChips({ source }: { source: MediaSource }) {
  const video = videoStream(source);
  const audio = audioStream(source);
  const subtitles = source.MediaStreams?.filter((stream) => stream.Type === "Subtitle").length ?? 0;
  const audios = source.MediaStreams?.filter((stream) => stream.Type === "Audio").length ?? 0;
  const chips = [
    [resolutionLabel(video?.Height), prettyCodec(video?.Codec)].filter(Boolean).join(" "),
    audio ? [prettyCodec(audio.Codec), channelLabel(audio.Channels)].filter(Boolean).join(" ") : "",
    audios > 1 ? `${audios} audio tracks` : "",
    subtitles ? `${subtitles} subtitle${subtitles === 1 ? "" : "s"}` : "",
    source.Container?.split(",")[0].toUpperCase() ?? "",
  ].filter(Boolean);
  if (!chips.length) return null;
  return (
    <div className="media-chips">
      {chips.map((chip) => (
        <span key={chip}>{chip}</span>
      ))}
    </div>
  );
}

function channelLabel(channels?: number) {
  if (!channels) return "";
  if (channels === 1) return "Mono";
  if (channels === 2) return "Stereo";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return `${channels}ch`;
}

function yearOf(date?: string) {
  if (!date) return undefined;
  const year = new Date(date).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

function yearsOf(item: BaseItem) {
  const start = item.ProductionYear ?? yearOf(item.PremiereDate);
  if (item.Type !== "Series") return item.Type === "Episode" ? airDate(item.PremiereDate) : start ? String(start) : "";
  if (!start) return "";
  if (item.Status === "Continuing") return `${start} – Present`;
  const end = yearOf(item.EndDate);
  return end && end !== start ? `${start} – ${end}` : String(start);
}

function airDate(date?: string) {
  if (!date) return "";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function endsAt(item: BaseItem, resume: boolean) {
  const total = (item.RunTimeTicks ?? 0) / 10_000_000;
  const done = resume ? ((item.UserData?.PlaybackPositionTicks ?? 0) / 10_000_000) : 0;
  const end = new Date(Date.now() + Math.max(0, total - done) * 1000);
  return `Ends at ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function factsOf(item: BaseItem, source: MediaSource | undefined, studioLink: (name: string) => ReactNode): [string, ReactNode][] {
  const people = (kind: string) =>
    (item.People ?? [])
      .filter((person) => person.Type === kind)
      .map((person) => person.Name)
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
  const facts: [string, ReactNode][] = [];
  const studios = (item.Studios ?? []).map((studio) => studio.Name).filter((name): name is string => Boolean(name)).slice(0, 3);
  if (studios.length) {
    facts.push([
      item.Type === "Series" ? "Network" : "Studio",
      studios.map((name, index) => (
        <span key={name}>
          {index ? ", " : ""}
          {studioLink(name)}
        </span>
      )),
    ]);
  }
  if (item.Type === "Series" && item.Status) facts.push(["Status", item.Status === "Continuing" ? "Returning series" : item.Status]);
  const directors = people("Director");
  if (directors) facts.push(["Director", directors]);
  const writers = people("Writer");
  if (writers) facts.push(["Writers", writers]);
  if (item.Type !== "Series" && item.PremiereDate) facts.push([item.Type === "Episode" ? "Aired" : "Released", airDate(item.PremiereDate)]);
  if (source?.Bitrate) facts.push(["Bitrate", `${(source.Bitrate / 1_000_000).toFixed(1)} Mbps`]);
  return facts;
}

function versionLabel(source: MediaSource) {
  const video = source.MediaStreams?.find((stream) => stream.Type === "Video");
  const height = video?.Height ? `${video.Height}p` : "";
  return [source.Name, source.Container?.toUpperCase(), height, video?.Codec?.toUpperCase()].filter(Boolean).join(" · ");
}
