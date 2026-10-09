import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { clearCache } from "./cache";
import { ApiError, Jellyfin, normalizeServer, publicInfo } from "./jellyfin";
import type { BaseItem } from "./types";

const AUTH_KEY = "finplay.auth";
const ACCOUNTS_KEY = "finplay.accounts";
const DEVICE_KEY = "finplay.device";

export type StoredAuth = {
  server: string;
  token: string;
  userId: string;
  username: string;
  imageTag?: string;
  isAdmin?: boolean;
  /** Jellyfin signs out other users on the same device id, so each account keeps its own. */
  deviceId?: string;
  /** Address to prefer on the home network; the same token works on both. */
  localServer?: string;
  /** A home address only gets the token once it answers with this id. */
  serverId?: string;
};

const LOCAL_TIMEOUT = 1500;
const RECHECK_MS = 30_000;

/** The home address when it is reachable and really is this server, otherwise the saved one. */
async function pickAddress(account: StoredAuth) {
  if (!account.localServer || !account.serverId) return account.server;
  const info = await publicInfo(account.localServer, LOCAL_TIMEOUT);
  return info?.Id === account.serverId ? account.localServer : account.server;
}

type SignedIn = Awaited<ReturnType<typeof Jellyfin.login>>;

/** `offline` keeps the saved sign-in while the server cannot be reached. */
type Status = "loading" | "anon" | "ready" | "offline";

type SessionContextValue = {
  status: Status;
  reconnect: () => void;
  /** The address in use right now: the home address when on the home network. */
  server: string;
  /** The address the account was saved with, which identifies it. */
  accountServer: string;
  localServer?: string;
  /** Saves or clears the home address; resolves false when it can't be reached right now. */
  setLocalServer: (address: string | null) => Promise<boolean>;
  token: string;
  userId: string;
  username: string;
  deviceId: string;
  imageTag?: string;
  isAdmin: boolean;
  views: BaseItem[];
  seerr: boolean;
  client: Jellyfin | null;
  accounts: StoredAuth[];
  login: (server: string, username: string, password: string) => Promise<void>;
  /** Finishes a Quick Connect sign-in started with `deviceFor`. */
  adopt: (server: string, signedIn: SignedIn, deviceId: string) => void;
  /** The device id to sign in with on this server and user. */
  deviceFor: (server: string, username?: string) => string;
  switchTo: (account: StoredAuth) => void;
  /** Leaves the current account saved and shows the sign-in screen. */
  addAccount: () => void;
  /** Returns to the last account after `addAccount`. */
  cancelAdd: () => void;
  forget: (account: StoredAuth) => void;
  logout: () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

function baseDevice() {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(DEVICE_KEY, created);
  return created;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const same = (a: StoredAuth, b: StoredAuth) => a.server === b.server && a.userId === b.userId;

function readAccounts() {
  const saved = read<StoredAuth[]>(ACCOUNTS_KEY) ?? [];
  const current = read<StoredAuth>(AUTH_KEY);
  if (current && !saved.some((account) => same(account, current))) saved.unshift(current);
  return saved;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const base = useMemo(baseDevice, []);
  const [status, setStatus] = useState<Status>("loading");
  const [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);
  const [auth, setAuth] = useState<StoredAuth | null>(null);
  const [address, setAddress] = useState("");
  const [accounts, setAccounts] = useState<StoredAuth[]>(readAccounts);
  const [views, setViews] = useState<BaseItem[]>([]);
  const [seerr, setSeerr] = useState(false);

  const saveAccounts = useCallback((update: (list: StoredAuth[]) => StoredAuth[]) => {
    setAccounts((current) => {
      const next = update(current);
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const remember = useCallback(
    (account: StoredAuth) => {
      localStorage.setItem(AUTH_KEY, JSON.stringify(account));
      saveAccounts((list) => {
        const index = list.findIndex((entry) => same(entry, account));
        return index < 0 ? [...list, account] : list.map((entry, at) => (at === index ? account : entry));
      });
    },
    [saveAccounts],
  );

  const reset = useCallback(() => {
    clearCache();
    setViews([]);
    setSeerr(false);
  }, []);

  const forget = useCallback(
    (account: StoredAuth) => {
      saveAccounts((list) => list.filter((entry) => !same(entry, account)));
      new Jellyfin({ server: account.server, token: account.token, userId: account.userId, deviceId: account.deviceId ?? base }, () => {})
        .signOut()
        .catch(() => {});
    },
    [saveAccounts, base],
  );

  const logout = useCallback(() => {
    const current = read<StoredAuth>(AUTH_KEY);
    localStorage.removeItem(AUTH_KEY);
    if (current) forget(current);
    reset();
    setAuth(null);
    setStatus("anon");
  }, [forget, reset]);

  const expired = useCallback(() => {
    const current = read<StoredAuth>(AUTH_KEY);
    localStorage.removeItem(AUTH_KEY);
    if (current) saveAccounts((list) => list.filter((entry) => !same(entry, current)));
    reset();
    setAuth(null);
    setStatus("anon");
  }, [saveAccounts, reset]);

  const deviceId = auth?.deviceId ?? base;
  const client = useMemo(() => {
    if (!auth) return null;
    return new Jellyfin({ server: address || auth.server, token: auth.token, userId: auth.userId, deviceId: auth.deviceId ?? base }, expired);
  }, [auth, address, base, expired]);

  useEffect(() => {
    let cancel = false;
    const stored = read<StoredAuth>(AUTH_KEY);
    if (!stored) {
      setStatus("anon");
      return;
    }
    void (async () => {
      const preferred = await pickAddress(stored);
      if (cancel) return;
      const signIn = (server: string) =>
        new Jellyfin({ server, token: stored.token, userId: stored.userId, deviceId: stored.deviceId ?? base }, () => {}).me().then((me) => ({ me, server }));
      try {
        const { me, server } = await signIn(preferred).catch((err: unknown) => {
          if (preferred === stored.server || (err instanceof ApiError && err.status === 401)) throw err;
          return signIn(stored.server);
        });
        if (cancel) return;
        const serverId = stored.serverId ?? (await publicInfo(server, 4000))?.Id;
        const next = { ...stored, username: me.Name, imageTag: me.PrimaryImageTag, isAdmin: me.Policy?.IsAdministrator === true, serverId };
        if (cancel) return;
        remember(next);
        setAddress(server);
        setAuth(next);
        setStatus("ready");
      } catch (err) {
        if (cancel) return;
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem(AUTH_KEY);
          saveAccounts((list) => list.filter((entry) => !same(entry, stored)));
          setStatus("anon");
          return;
        }
        setAddress(stored.server);
        setAuth(stored);
        setStatus("offline");
      }
    })();
    return () => {
      cancel = true;
    };
  }, [base, attempt, remember, saveAccounts]);

  useEffect(() => {
    if (!client || status !== "ready") return;
    let cancel = false;
    void client.capabilities().catch(() => {});
    client
      .seerrUserStatus()
      .then((status) => {
        if (!cancel) setSeerr(status.active && status.userFound);
      })
      .catch(() => {
        if (!cancel) setSeerr(false);
      });
    client
      .views()
      .then((list) => {
        if (!cancel) setViews(list.Items ?? []);
      })
      .catch(() => {
        if (!cancel) setViews([]);
      });
    return () => {
      cancel = true;
    };
  }, [client, status]);

  // Moving between home and away changes which address answers.
  useEffect(() => {
    if (!auth?.localServer || status !== "ready") return;
    let cancel = false;
    let last = Date.now();
    const check = () => {
      if (document.hidden || Date.now() - last < 5_000) return;
      last = Date.now();
      void pickAddress(auth).then((next) => {
        if (!cancel) setAddress(next);
      });
    };
    window.addEventListener("online", check);
    window.addEventListener("focus", check);
    const timer = window.setInterval(check, RECHECK_MS);
    return () => {
      cancel = true;
      window.removeEventListener("online", check);
      window.removeEventListener("focus", check);
      window.clearInterval(timer);
    };
  }, [auth, status]);

  const setLocalServer = useCallback(
    async (input: string | null) => {
      if (!auth) return false;
      if (!input?.trim()) {
        const next = { ...auth, localServer: undefined };
        remember(next);
        setAuth(next);
        setAddress(auth.server);
        return true;
      }
      const local = normalizeServer(input);
      const serverId = auth.serverId ?? (await publicInfo(address || auth.server, 4000))?.Id;
      const info = await publicInfo(local, 3000);
      if (info && serverId && info.Id !== serverId) throw new Error("That address answers as a different Jellyfin server.");
      const next = { ...auth, localServer: local, serverId: serverId ?? info?.Id };
      remember(next);
      setAuth(next);
      if (info) setAddress(local);
      return Boolean(info);
    },
    [auth, address, remember],
  );

  const deviceFor = useCallback(
    (server: string, username?: string) => {
      const known = accounts.find((account) => account.server === server && username && account.username.toLowerCase() === username.toLowerCase());
      if (known?.deviceId) return known.deviceId;
      if (known) return base;
      return accounts.some((account) => (account.deviceId ?? base) === base) ? crypto.randomUUID() : base;
    },
    [accounts, base],
  );

  const adopt = useCallback(
    (server: string, signedIn: SignedIn, device: string) => {
      const next: StoredAuth = {
        server,
        token: signedIn.token,
        userId: signedIn.userId,
        username: signedIn.username,
        imageTag: signedIn.imageTag,
        isAdmin: signedIn.isAdmin,
        deviceId: device,
      };
      reset();
      remember(next);
      setAddress(server);
      setAuth(next);
      setStatus("ready");
    },
    [remember, reset],
  );

  const login = useCallback(
    async (server: string, username: string, password: string) => {
      const normalized = normalizeServer(server);
      const device = deviceFor(normalized, username.trim());
      const signedIn = await Jellyfin.login(normalized, username.trim(), password, device);
      adopt(normalized, signedIn, device);
    },
    [deviceFor, adopt],
  );

  const switchTo = useCallback(
    (account: StoredAuth) => {
      localStorage.setItem(AUTH_KEY, JSON.stringify(account));
      reset();
      setAuth(null);
      setStatus("loading");
      reconnect();
    },
    [reset, reconnect],
  );

  const addAccount = useCallback(() => {
    localStorage.removeItem(AUTH_KEY);
    reset();
    setAuth(null);
    setStatus("anon");
  }, [reset]);

  const cancelAdd = useCallback(() => {
    const last = accounts[accounts.length - 1];
    if (last) switchTo(last);
  }, [accounts, switchTo]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      reconnect,
      server: auth ? address || auth.server : "",
      accountServer: auth?.server ?? "",
      localServer: auth?.localServer,
      setLocalServer,
      token: auth?.token ?? "",
      userId: auth?.userId ?? "",
      username: auth?.username ?? "",
      deviceId,
      imageTag: auth?.imageTag,
      isAdmin: auth?.isAdmin === true,
      views,
      seerr,
      client,
      accounts,
      login,
      adopt,
      deviceFor,
      switchTo,
      addAccount,
      cancelAdd,
      forget,
      logout,
    }),
    [status, reconnect, auth, address, setLocalServer, deviceId, views, seerr, client, accounts, login, adopt, deviceFor, switchTo, addAccount, cancelAdd, forget, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Session missing");
  return value;
}

export function useClient() {
  const { client } = useSession();
  if (!client) throw new Error("Not signed in");
  return client;
}
