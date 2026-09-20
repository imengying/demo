import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, backendProbe } from "./api";
import { demoConfig, demoServersAt, DEMO_REFRESH_INTERVAL_MS } from "../shared/demo";
import {
  applyBatch,
  createLivePlayback,
  mergeServerLive,
  pruneLiveMetrics,
  type LiveMetrics,
  type LiveMetricsMap,
} from "./live";
import { isOnline } from "./format";
import { ui } from "./locale";
import { useFavicon, useStoredAppearance, useSystemDark } from "./hooks/useBrowserAppearance";
import { resolveBackground, themeToggle } from "./theme";
import {
  BOOTSTRAP_POLL_INTERVAL_MS,
  createRefreshQueue,
  LIVE_CARD_REFRESH_INTERVAL_MS,
  shouldSyncBootstrap,
} from "./refresh";
import { connectLive } from "./transport";
import type { Config, ExchangeRates, Server } from "../shared/types";

import { demoMode } from "./demoMode";

const search = new URLSearchParams(window.location.search);
const base = import.meta.env.BASE_URL;
const demoViewConfig: Config = demoMode && search.has("carrier")
  ? { ...demoConfig, theme_options: { ...demoConfig.theme_options, showCarrierLatency: true } }
  : demoConfig;
// 有 Worker 后端时由 bootstrap 提供真实配置；这个默认值只用于首帧与纯静态场景。
const defaultConfig: Config = { ...demoViewConfig, site_description: "", site_name: "" };

type Access = "ok" | "login" | "turnstile";

interface AppState {
  config: Config;
  configReady: boolean;
  servers: Server[];
  liveMetrics: LiveMetricsMap;
  liveConnected: boolean;
  /** 后端是 Worker（KV）还是纯静态托管。决定详情页走 /api/history 还是本地算。 */
  backendLive: boolean;
  exchangeRates: ExchangeRates | null;
  loading: boolean;
  error: string;
  setError: (message: string) => void;
  access: Access;
  dark: boolean;
  blur: boolean;
  background: string;
  carrierLatency: boolean;
  toggleTheme: () => void;
  selectedId: string | null;
  openServer: (server: Server) => void;
  goHome: () => void;
  reload: () => Promise<void>;
  login: (username: string, password: string, turnstileToken: string, totpCode: string) => Promise<void>;
  verify: (token: string) => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error("useApp must be used within AppProvider");
  return state;
}

function routeServerId() {
  const path = base !== "/" && window.location.pathname.startsWith(base)
    ? window.location.pathname.slice(base.length - 1)
    : window.location.pathname;
  const match = path.match(/^\/instance\/([^/]+)\/?$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState(defaultConfig);
  const [configReady, setConfigReady] = useState(demoMode);
  const [servers, setServers] = useState<Server[]>([]);
  const [liveMetrics, setLiveMetrics] = useState<LiveMetricsMap>({});
  const [liveConnected, setLiveConnected] = useState(false);
  const [backendLive, setBackendLive] = useState(false);
  const livePlayback = useRef(createLivePlayback());
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [exchangeRates, setExchangeRates] = useState<ExchangeRates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [access, setAccess] = useState<Access>("ok");
  const [selectedId, setSelectedId] = useState<string | null>(routeServerId);
  const [appearance, setAppearance] = useStoredAppearance("nodeflare-theme");
  const systemDark = useSystemDark();
  const liveConnectedRef = useRef(false);
  const serversRef = useRef<Server[]>([]);
  const cardCacheRef = useRef(new Map<string, {
    server: Server;
    live: LiveMetrics | undefined;
    online: boolean;
    result: Server;
  }>());
  const liveServersRef = useRef<Server[]>([]);
  const localeRef = useRef(config.locale);
  const reloadQueueRef = useRef<ReturnType<typeof createRefreshQueue> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  localeRef.current = config.locale;

  const dark = appearance ? appearance === "dark" : config.default_theme === "system" ? systemDark : config.default_theme === "dark";
  const background = resolveBackground(config.background_url, dark);
  const blur = themeToggle(config, "enableBlur");
  const carrierLatency = config.show_latency && themeToggle(config, "showCarrierLatency", false);
  useFavicon(configReady ? config.logo_url : undefined);

  // 纯静态托管时上游数据不会变，本地按秒重采样即可；有 Worker 时数据由 /api/ws 推送。
  const demoTickRef = useRef(0);
  useEffect(() => {
    if (!demoMode) return;
    let cancelled = false;
    void backendProbe.probe().then((mode) => {
      if (cancelled || mode === "live") return;
      const timer = window.setInterval(() => {
        if (document.hidden || navigator.onLine === false) return;
        const at = Math.floor(Date.now() / 1000);
        if (at === demoTickRef.current) return;
        demoTickRef.current = at;
        setServers(demoServersAt(at));
      }, DEMO_REFRESH_INTERVAL_MS);
      cleanupRef.current = () => window.clearInterval(timer);
    });
    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  if (!reloadQueueRef.current) {
    reloadQueueRef.current = createRefreshQueue(async (quiet) => {
      if (!quiet) setLoading(true);
      try {
        const result = await api.bootstrap();
        setConfig(result.config);
        setConfigReady(true);
        serversRef.current = result.servers;
        setServers(result.servers);
        setExchangeRates(result.exchange_rates);
        setAccess(result.access);
        if (result.access !== "ok") {
          setLiveMetrics({});
        }
        setError("");
      } catch (reason) {
        const status = reason instanceof ApiError ? reason.status : 0;
        if (status === 401 || status === 403) {
          setAccess(status === 401 ? "login" : "turnstile");
          serversRef.current = [];
          setServers([]);
          setLiveMetrics({});
          setError(status === 403 && reason instanceof Error ? reason.message : "");
        } else {
          setError(reason instanceof Error ? reason.message : ui(localeRef.current, "无法加载节点状态", "Unable to load server status"));
        }
      } finally {
        setLoading(false);
      }
    });
  }

  const reload = useCallback((quiet = false): Promise<void> => {
    return reloadQueueRef.current!(quiet);
  }, []);

  const login = useCallback(async (username: string, password: string, turnstileToken: string, totpCode: string) => {
    await api.login(username.trim(), password, turnstileToken, totpCode);
    setAccess("ok");
    await reload();
  }, [reload]);

  const verify = useCallback(async (token: string) => {
    await api.verifyTurnstile(token);
    setAccess("ok");
    await reload();
  }, [reload]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    serversRef.current = servers;
    setLiveMetrics((current) => pruneLiveMetrics(current, servers));
  }, [servers]);

  useEffect(() => {
    if (access !== "ok") return;
    let stopped = false;
    let timer: number | undefined;
    let lastSyncAt = Date.now();

    const canRefresh = () => !document.hidden && navigator.onLine !== false;
    const clearTimer = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
    const schedule = () => {
      clearTimer();
      if (!stopped && canRefresh()) {
        timer = window.setTimeout(run, BOOTSTRAP_POLL_INTERVAL_MS);
      }
    };
    const run = async () => {
      clearTimer();
      if (stopped || !canRefresh()) return;
      const now = Date.now();
      if (shouldSyncBootstrap(liveConnectedRef.current, now - lastSyncAt)) {
        await reload(true);
        lastSyncAt = Date.now();
      }
      schedule();
    };
    const refreshNow = () => {
      clearTimer();
      if (stopped || !canRefresh()) return;
      void reload(true).finally(() => {
        if (stopped) return;
        lastSyncAt = Date.now();
        schedule();
      });
    };
    const handleVisibility = () => {
      if (document.hidden) clearTimer();
      else refreshNow();
    };
    const handleOffline = () => clearTimer();

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", refreshNow);
    window.addEventListener("offline", handleOffline);
    schedule();
    return () => {
      stopped = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", refreshNow);
      window.removeEventListener("offline", handleOffline);
    };
  }, [access, reload]);

  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      setClockNow(Date.now());
      const batch = livePlayback.current.take(serversRef.current);
      if (!batch.length) return;
      setLiveMetrics((current) => applyBatch(current, batch, serversRef.current));
    };
    const sync = () => {
      window.clearInterval(timer);
      timer = undefined;
      if (document.hidden || navigator.onLine === false) {
        livePlayback.current.clear();
        return;
      }
      tick();
      timer = window.setInterval(tick, LIVE_CARD_REFRESH_INTERVAL_MS);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  useEffect(() => {
    if (!configReady || access !== "ok") return;
    let active = true;
    // 纯静态托管没有 /api/ws（也没有实时指标），只有 KV 后端才连实时推送。
    let disconnect: (() => void) | null = null;
    void backendProbe.probe().then((mode) => {
      if (!active) return;
      setBackendLive(mode === "live");
      if (mode !== "live") return;
      disconnect = connectLive({ serverId: selectedId }, {
        onBatch: (updates) => {
          livePlayback.current.enqueue(updates, serversRef.current);
        },
        onConnectedChange: (connected) => {
          liveConnectedRef.current = connected;
          setLiveConnected(connected);
          if (!connected) {
            livePlayback.current.clear();
          }
          if (active && !connected && !document.hidden && navigator.onLine !== false) {
            void reload(true);
          }
        },
      });
    });
    return () => {
      active = false;
      livePlayback.current.clear();
      disconnect?.();
    };
  }, [access, configReady, reload, selectedId]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.documentElement.dataset.blur = blur ? "on" : "off";
    document.documentElement.lang = config.locale;
  }, [blur, config.locale, dark]);

  useEffect(() => {
    const onPop = () => setSelectedId(routeServerId());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Merge live metrics into servers with identity preservation: a server's object
  // only changes when its own data or online status changes, and the array itself
  // stays referentially stable on quiet ticks. Memoized cards then skip re-renders
  // for nodes that reported nothing new, while a silent node still flips to
  // offline within a second of crossing the threshold.
  const liveServers = useMemo(() => {
    const nowSec = clockNow / 1000;
    const cache = cardCacheRef.current;
    const next = servers.map((server) => {
      const live = liveMetrics[server.id];
      const merged = mergeServerLive(server, live);
      const online = isOnline(merged, config.offline_threshold_seconds, nowSec);
      const cached = cache.get(server.id);
      if (cached && cached.server === server && cached.live === live) {
        if (cached.online === online) return cached.result;
        // Online status flipped without new data: mint a fresh object so the
        // card re-renders into the offline/online state.
        const result = { ...merged };
        cache.set(server.id, { server, live, online, result });
        return result;
      }
      cache.set(server.id, { server, live, online, result: merged });
      return merged;
    });
    if (cache.size > next.length) {
      const ids = new Set(next.map((server) => server.id));
      for (const id of cache.keys()) {
        if (!ids.has(id)) cache.delete(id);
      }
    }
    const previous = liveServersRef.current;
    const stable = previous.length === next.length
      && next.every((server, index) => server === previous[index]);
    liveServersRef.current = stable ? previous : next;
    return liveServersRef.current;
  }, [clockNow, config.offline_threshold_seconds, liveMetrics, servers]);

  useEffect(() => {
    if (!configReady) return;
    const selected = liveServers.find((server) => server.id === selectedId);
    document.title = selected ? `${selected.name} · ${config.site_name}` : config.site_name;
  }, [config.site_name, configReady, liveServers, selectedId]);

  const goHome = useCallback(() => {
    window.history.pushState({}, "", demoMode && import.meta.env.DEV ? "/?demo=1" : base);
    setSelectedId(null);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const openServer = useCallback((server: Server) => {
    window.history.pushState({}, "", `${base}instance/${encodeURIComponent(server.id)}${demoMode && import.meta.env.DEV ? "?demo=1" : ""}`);
    setSelectedId(server.id);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const toggleTheme = useCallback(() => {
    setAppearance((current) => {
      const resolved = current ?? (dark ? "dark" : "light");
      const next = resolved === "dark" ? "light" : "dark";
      return next;
    });
  }, [dark]);

  const value = useMemo<AppState>(() => ({
    config,
    configReady,
    servers: liveServers,
    liveMetrics,
    liveConnected,
    backendLive,
    exchangeRates,
    loading,
    error,
    setError,
    access,
    dark,
    blur,
    background,
    carrierLatency,
    toggleTheme,
    selectedId,
    openServer,
    goHome,
    reload: () => reload(),
    login,
    verify,
  }), [access, backendLive, background, blur, carrierLatency, config, configReady, dark, error, exchangeRates, goHome, liveConnected, liveMetrics, liveServers, loading, login, openServer, reload, selectedId, toggleTheme, verify]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
