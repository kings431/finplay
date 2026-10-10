import { useNavigate, useParams } from "react-router-dom";
import { useIsAdmin } from "../admin";
import { LibrariesSection } from "../components/dashboard/Libraries";
import { DevicesSection, LogsSection, PluginsSection, UsersSection } from "../components/dashboard/Lists";
import { OverviewSection } from "../components/dashboard/Overview";
import { SessionsSection } from "../components/dashboard/Sessions";
import { TasksSection } from "../components/dashboard/Tasks";
import { useSession } from "../session";
import { tv } from "../tv";
import { Stats, WatchStats } from "./Stats";
import "../dashboard.css";

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "sessions", label: "Sessions" },
  { id: "libraries", label: "Libraries" },
  { id: "tasks", label: "Scheduled tasks" },
  { id: "stats", label: "Watch stats" },
  { id: "users", label: "Users" },
  { id: "devices", label: "Devices" },
  { id: "plugins", label: "Plugins" },
  { id: "logs", label: "Logs" },
] as const;

type Section = (typeof SECTIONS)[number]["id"];

/** Server administration for desktop admins. The TV keeps the simpler Stats page. */
export function Dashboard() {
  const isAdmin = useIsAdmin();
  const { server } = useSession();
  const navigate = useNavigate();
  const params = useParams();
  const section: Section = SECTIONS.some((entry) => entry.id === params.section) ? (params.section as Section) : "overview";

  if (tv) return <Stats />;

  if (!isAdmin) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>Dashboard</h1>
        </header>
        <p className="empty">The dashboard is only available to server administrators.</p>
      </div>
    );
  }

  const go = (next: string) => navigate(`/dashboard/${next}`);

  return (
    <div className="page dash-page">
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Manage {server.replace(/^https?:\/\//, "")}: who's watching, libraries, and server jobs.</p>
        </div>
      </header>
      <nav className="dash-tabs" aria-label="Dashboard sections">
        {SECTIONS.map((entry) => (
          <button key={entry.id} className={entry.id === section ? "on" : ""} aria-current={entry.id === section ? "page" : undefined} onClick={() => navigate(`/dashboard/${entry.id}`, { replace: true })}>
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="dash-body">
        {section === "overview" ? <OverviewSection go={go} /> : null}
        {section === "sessions" ? <SessionsSection /> : null}
        {section === "libraries" ? <LibrariesSection /> : null}
        {section === "tasks" ? <TasksSection /> : null}
        {section === "stats" ? <WatchStats /> : null}
        {section === "users" ? <UsersSection /> : null}
        {section === "devices" ? <DevicesSection /> : null}
        {section === "plugins" ? <PluginsSection /> : null}
        {section === "logs" ? <LogsSection /> : null}
      </div>
    </div>
  );
}
