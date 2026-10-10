import { lazy, Suspense } from "react";
import { HashRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { SessionProvider, useSession } from "./session";
import { PlaybackProvider } from "./playback";
import { Shell } from "./components/Shell";
import { TitleBar } from "./components/TitleBar";
import { Home } from "./pages/Home";
import { Libraries } from "./pages/Libraries";
import { Library } from "./pages/Library";
import { Detail } from "./pages/Detail";
import { Playlists } from "./pages/Playlists";
import { Playlist } from "./pages/Playlist";
import { Search } from "./pages/Search";
import { Downloads } from "./pages/Downloads";
import { SyncPlayProvider } from "./syncplay";
import { RemoteProvider } from "./remote";
import { DownloadsProvider } from "./downloads";
import { Playing } from "./pages/Playing";

// Pages most sessions never open load on first visit, keeping startup parsing small.
const Login = lazy(() => import("./pages/Login").then((page) => ({ default: page.Login })));
const Discover = lazy(() => import("./pages/Discover").then((page) => ({ default: page.Discover })));
const DiscoverList = lazy(() => import("./pages/Discover").then((page) => ({ default: page.DiscoverList })));
const Stats = lazy(() => import("./pages/Stats").then((page) => ({ default: page.Stats })));
const Person = lazy(() => import("./pages/Person").then((page) => ({ default: page.Person })));
const Requests = lazy(() => import("./pages/Requests").then((page) => ({ default: page.Requests })));
const LiveTv = lazy(() => import("./pages/LiveTv").then((page) => ({ default: page.LiveTv })));
const Together = lazy(() => import("./pages/Together").then((page) => ({ default: page.Together })));
const Settings = lazy(() => import("./pages/Settings").then((page) => ({ default: page.Settings })));
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
      <TitleBar />
      <SessionProvider>
        <DownloadsProvider>
          <PlaybackProvider>
            <SyncPlayProvider>
              <RemoteProvider>
                <Suspense fallback={null}>
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
                        <Route path="/playlists" element={<Playlists />} />
                        <Route path="/playlist/:id" element={<Playlist />} />
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
                </Suspense>
              </RemoteProvider>
            </SyncPlayProvider>
          </PlaybackProvider>
        </DownloadsProvider>
      </SessionProvider>
    </HashRouter>
  );
}
