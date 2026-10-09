import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Poster } from "../components/Cards";
import { useCached } from "../cache";
import { IconBack } from "../icons";
import { primaryUrl, tile } from "../media";
import { useClient, useSession } from "../session";
import type { BaseItem } from "../types";

export function Person() {
  const { id = "" } = useParams();
  const client = useClient();
  const session = useSession();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const { data, error, loading } = useCached(`person:${id}`, async () => {
    const [person, credits] = await Promise.all([
      client.item(id),
      client.items({
        includeItemTypes: "Movie,Series",
        sortBy: "PremiereDate,ProductionYear,SortName",
        sortOrder: "Descending",
        limit: 300,
        extra: { PersonIds: id },
      }),
    ]);
    return { person, credits: credits.Items ?? [] };
  });

  useEffect(() => {
    setExpanded(false);
    document.querySelector(".main")?.scrollTo({ top: 0 });
  }, [id]);

  if (error) return <p className="empty">{error}</p>;
  if (!data) return <div className="page">{loading ? <p className="empty">Loading…</p> : null}</div>;

  const { person, credits } = data;
  const portrait = primaryUrl(session, person);
  const movies = credits.filter((item) => item.Type === "Movie");
  const shows = credits.filter((item) => item.Type === "Series");
  const facts = lifeFacts(person);

  return (
    <div className="page person-page">
      <button className="btn-round person-back" onClick={() => navigate(-1)} aria-label="Back">
        <IconBack size={18} />
      </button>
      <header className="person-head">
        <span className="person-portrait" style={{ background: tile(person.Name) }}>
          {portrait ? <img src={portrait} alt="" /> : <b>{person.Name.slice(0, 1)}</b>}
        </span>
        <div className="person-copy">
          <p className="eyebrow">{[movies.length ? `${movies.length} movie${movies.length === 1 ? "" : "s"}` : "", shows.length ? `${shows.length} show${shows.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "On your server"}</p>
          <h1>{person.Name}</h1>
          {facts ? <p className="person-facts">{facts}</p> : null}
          {person.Overview ? (
            <>
              <p className={`person-bio${expanded ? " open" : ""}`}>{person.Overview}</p>
              {person.Overview.length > 360 ? (
                <button className="text-btn" onClick={() => setExpanded((value) => !value)}>
                  {expanded ? "Show less" : "Read more"}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      <Filmography title="Movies" items={movies} />
      <Filmography title="Shows" items={shows} />
      {credits.length === 0 ? <p className="empty">Nothing with {person.Name} is on your server yet.</p> : null}
    </div>
  );
}

function Filmography({ title, items }: { title: string; items: BaseItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="person-section">
      <div className="row-head">
        <h2>{title}</h2>
      </div>
      <div className="poster-grid">
        {items.map((item) => (
          <Poster key={item.Id} item={item} subtitle={item.ProductionYear ? String(item.ProductionYear) : undefined} />
        ))}
      </div>
    </section>
  );
}

function lifeFacts(person: BaseItem) {
  const born = person.PremiereDate ? new Date(person.PremiereDate) : undefined;
  const died = person.EndDate ? new Date(person.EndDate) : undefined;
  const place = person.ProductionLocations?.[0];
  const format = (date: Date) => date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const parts: string[] = [];
  if (born && !Number.isNaN(born.getTime())) {
    const end = died && !Number.isNaN(died.getTime()) ? died : new Date();
    const age = Math.floor((end.getTime() - born.getTime()) / (365.25 * 86_400_000));
    parts.push(`Born ${format(born)}${place ? ` in ${place}` : ""}${died ? "" : ` (age ${age})`}`);
  } else if (place) {
    parts.push(`From ${place}`);
  }
  if (died && !Number.isNaN(died.getTime())) parts.push(`Died ${format(died)}`);
  return parts.join(" · ");
}
