import { HashRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { SessionProvider, useSession } from "./session";
import { PlaybackProvider } from "./playback";
import { Shell } from "./components/Shell";
import { Login } from "./pages/Login";
import { Home } from "./pages/Home";
import { Libraries } from "./pages/Libraries";
import { Library } from "./pages/Library";
import { Detail } from "./pages/Detail";
import { Search } from "./pages/Search";
import { Discover, DiscoverList } from "./pages/Discover";
import { Downloads } from "./pages/Downloads";
import { Stats } from "./pages/Stats";
import { Person } from "./pages/Person";
import { Requests } from "./pages/Requests";
import { LiveTv } from "./pages/LiveTv";
import { Together } from "./pages/Together";
import { SyncPlayProvider } from "./syncplay";
import { RemoteProvider } from "./remote";
import { DownloadsProvider } from "./downloads";
import { Settings } from "./pages/Settings";
import { Playing } from "./pages/Playing";
import { Mark } from "./icons";

function Splash() {
  return (
    <div className="splash">
      <Mark size={52} />
    </div>
  );
}

function RequireAuth() {
  const { status } = useSession();
  if (status === "loading") return <Splash />;
  if (status !== "ready" && status !== "offline") return <Navigate to="/login" replace />;
  return <Outlet />;
}

function GuestOnly() {
  const { status } = useSession();
  if (status === "loading") return <Splash />;
  if (status === "ready" || status === "offline") return <Navigate to="/" replace />;
  return <Outlet />;
}

export function App() {
  return (
    <HashRouter>
      <SessionProvider>
        <DownloadsProvider>
          <PlaybackProvider>
            <SyncPlayProvider>
              <RemoteProvider>
                <Routes>
                  <Route element={<GuestOnly />}>
                    <Route path="/login" element={<Login />} />
                  </Route>
                  <Route element={<RequireAuth />}>
                    <Route element={<Shell />}>
                      <Route path="/" element={<Home />} />
                      <Route path="/libraries" element={<Libraries />} />
                      <Route path="/library/:id" element={<Library />} />
                      <Route path="/item/:id" element={<Detail />} />
                      <Route path="/search" element={<Search />} />
                      <Route path="/discover" element={<Discover />} />
                      <Route path="/discover/:slug" element={<DiscoverList />} />
                      <Route path="/requests" element={<Requests />} />
                      <Route path="/livetv" element={<LiveTv />} />
                      <Route path="/together" element={<Together />} />
                      <Route path="/downloads" element={<Downloads />} />
                      <Route path="/stats" element={<Stats />} />
                      <Route path="/person/:id" element={<Person />} />
                      <Route path="/settings" element={<Settings />} />
                      <Route path="/playing/:id" element={<Playing />} />
                    </Route>
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </RemoteProvider>
            </SyncPlayProvider>
          </PlaybackProvider>
        </DownloadsProvider>
      </SessionProvider>
    </HashRouter>
  );
}
