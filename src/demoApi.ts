import { demoAdminServer, demoConfig, demoExchangeRates, demoHistory, demoLatencyHistory, demoLatencyTasks, demoServersAt } from "../shared/demo";
import type { AlertRule, DatabaseStats, LatencyTask, Settings, TelegramSettings, Theme, ThemeSettingsSchema } from "../shared/types";

const SESSION_KEY = "nodeflare-demo-session";
const READ_ONLY = "演示环境不支持修改。";
type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const settings: Settings = {
  ...demoConfig,
  admin_username: "admin",
  admin_password_configured: true,
  turnstile_secret_key: "",
  notification_enabled: true,
  offline_alert_minutes: 5,
  expiry_alert_days: 7,
  traffic_alert_percentage: 80,
};
const themes: Theme[] = [{
  id: demoConfig.active_theme_id, name: "NodeFlare", description: "内置主题", url: "",
  version: "1.0.0", builtin: true, active: true,
}];
const themeSettings: ThemeSettingsSchema = {
  schema: 1, source: "builtin",
  settings: [
    { key: "enableBlur", label: "背景模糊", type: "toggle", default: true },
    { key: "showCarrierLatency", label: "分线路延迟", type: "toggle", default: false },
  ],
};
const rules: AlertRule[] = [{
  id: "demo-cpu-alert", name: "CPU 持续高负载", metric: "cpu", threshold: 85,
  duration_minutes: 5, aggregation: "average", all_servers: true, enabled: true, server_ids: [],
}, {
  id: "demo-memory-alert", name: "内存使用率过高", metric: "memory", threshold: 90,
  duration_minutes: 10, aggregation: "continuous", all_servers: true, enabled: true, server_ids: [],
}];
const telegram: TelegramSettings = {
  bot_token: "", chat_id: "", message_thread_id: null,
  template: "NodeFlare 通知\n节点：{{server_name}}\n事件：{{message}}",
};
const database: DatabaseStats = {
  kind: "sqlite", size_bytes: 48 * 1024 ** 2, reclaimable_bytes: 3 * 1024 ** 2, restart_required: false,
};

// Only the login marker is stored. All data is generated locally and every
// unlisted operation is rejected, including read-looking backup endpoints.
export function createDemoRequest(store?: SessionStore) {
  let signedIn = false;
  const authenticated = () => {
    try { return store ? store.getItem(SESSION_KEY) === "admin" : signedIn; }
    catch { return signedIn; }
  };
  const setSession = (value: boolean) => {
    signedIn = value;
    try {
      if (value) store?.setItem(SESSION_KEY, "admin");
      else store?.removeItem(SESSION_KEY);
    } catch { /* Browsers that block storage can still view this session. */ }
  };

  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const url = new URL(path, "https://demo.invalid");
    const route = url.pathname;
    const fail = (error: string, status: number) => Response.json({ error }, { status });
    if (route === "/api/admin/login" && method === "POST") {
      // 演示站凭据为明文，直接比较（与 Worker 端行为一致）。
      let credentials: { username?: string; password?: string } | null = null;
      try { credentials = JSON.parse(String(init.body)); }
      catch { return fail("请输入账号和密码", 400); }
      if (credentials?.username !== "admin" || credentials?.password !== "admin") {
        return fail("账号或密码错误", 401);
      }
      setSession(true);
      return Response.json({ token: "demo-only" });
    }
    if (route === "/api/admin/logout" && method === "POST") {
      setSession(false);
      return new Response(null, { status: 204 });
    }
    if (route.startsWith("/api/admin/") && !authenticated()) return fail("登录状态已失效，请重新登录", 401);
    if (method !== "GET") return fail(READ_ONLY, 403);

    const servers = demoServersAt();
    switch (route) {
      case "/api/bootstrap": return Response.json({ config: demoConfig, access: "ok", servers, exchange_rates: demoExchangeRates });
      case "/api/exchange-rates": return Response.json(demoExchangeRates);
      case "/api/admin/servers": return Response.json({ servers: servers.map(demoAdminServer) });
      case "/api/admin/settings": return Response.json(settings);
      case "/api/admin/themes": return Response.json({ themes });
      case "/api/admin/theme-settings": return Response.json(themeSettings);
      case "/api/admin/2fa/status": return Response.json({ enabled: false, has_secret: false });
      case "/api/admin/latency-tasks": return Response.json({ tasks: demoLatencyTasks.map((task): LatencyTask => ({
        ...task, default_enabled: true, server_ids: servers.filter((server) => server.latency.length).map((server) => server.id),
      })) });
      case "/api/admin/alert-rules": return Response.json({ rules });
      case "/api/admin/telegram": return Response.json({ telegram });
      case "/api/admin/database": return Response.json(database);
      case "/api/admin/sessions": {
        const now = Math.floor(Date.now() / 1000);
        return Response.json({ sessions: [{
          id: "demo-session", ip_address: "192.0.2.1", user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          created_at: now - 300, last_seen_at: now, expires_at: now + 86400, current: true,
        }] });
      }
    }
    const history = route.match(/^\/api\/(history|latency)\/([^/]+)$/);
    if (history) {
      const id = decodeURIComponent(history[2]);
      const server = servers.find((server) => server.id === id);
      if (!server) return fail("节点不存在", 404);
      const hours = Math.min(720, Math.max(1, Number(url.searchParams.get("hours")) || 1));
      const tasks = demoLatencyTasks.filter((task) => server.latency.some((point) => point.task_id === task.id));
      return Response.json(history[1] === "history"
        ? { points: demoHistory(id, hours) }
        : { tasks, points: demoLatencyHistory(id, hours).filter((point) => tasks.some((task) => task.id === point.task_id)) });
    }
    return fail(READ_ONLY, 403);
  };
}

let store: SessionStore | undefined;
try { store = typeof window !== "undefined" ? window.sessionStorage : undefined; } catch { /* Optional. */ }
export const demoRequest = createDemoRequest(store);
