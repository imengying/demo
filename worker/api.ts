// 演示站后端 API：凭据与配置来自 KV（worker/kv.ts 播种），波形数据实时计算。
//
// 路由与 NodeFlare 真实服务端保持一致，前端代码无需区分真假后端。
// 写操作一律拒绝 —— 演示站不落库，避免被当成真实面板使用。
import { createSession, destroySession, hasSession, loadAdmin, loadCatalog, sessionCookie, timingSafeEqual, type Catalog } from "./kv";
import { demoAdminServer, historyFor, latencyHistoryFor, sampleServer } from "../shared/sampling";
import type { LatencyTask, Settings } from "../shared/types";

const READ_ONLY = "演示环境不支持修改。";
const UNAUTHORIZED = "登录状态已失效，请重新登录";
const SESSION_MAX_AGE = 86_400;

function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function fail(error: string, status: number, extra?: HeadersInit): Response {
  return json({ error }, status, extra);
}

/** 按时刻采样全部节点；startedAt 让流量与在线时长随时间递增。 */
function serversAt(catalog: Catalog, at: number, startedAt: number) {
  return catalog.servers.map((server) => sampleServer(server, at, startedAt));
}

async function settingsFor(env: Env, catalog: Catalog): Promise<Settings> {
  const admin = await loadAdmin(env);
  // 凭据只读：这里只回报“存在且用户名是什么”，不泄露任何派生值或盐以外的信息。
  return {
    ...catalog.settings,
    admin_username: admin.username,
    admin_password_configured: true,
  };
}

export async function handleApi(request: Request, env: Env, startedAt: number): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname;
  const method = request.method.toUpperCase();
  const catalog = await loadCatalog(env);
  const now = Math.floor(Date.now() / 1000);

  if (route === "/api/admin/login" && method === "POST") {
    let credentials: { username?: string; password_derived?: string } | null = null;
    try { credentials = JSON.parse(await request.text()); }
    catch { return fail("请输入账号和密码", 400); }
    const admin = await loadAdmin(env);
    // 前端提交的是 PBKDF2 派生值，明文密码从不上网；比较用定长算法避免时序泄露。
    const username = String(credentials?.username ?? "");
    const derived = String(credentials?.password_derived ?? "");
    const okUsername = timingSafeEqual(username, admin.username);
    const okPassword = derived.length > 0 && timingSafeEqual(derived, admin.password_derived);
    if (!okUsername || !okPassword) return fail("账号或密码错误", 401);
    const token = await createSession(env);
    return json({ token: "demo-only" }, 200, { "Set-Cookie": sessionCookie(token, SESSION_MAX_AGE) });
  }

  if (route === "/api/admin/logout" && method === "POST") {
    await destroySession(env, request);
    return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie("", 0) } });
  }

  if (route.startsWith("/api/admin/") && !(await hasSession(env, request))) {
    return fail(UNAUTHORIZED, 401);
  }

  if (route === "/api/bootstrap") {
    return json({ config: catalog.config, access: "ok", servers: serversAt(catalog, now, startedAt), exchange_rates: catalog.exchange_rates });
  }

  if (route === "/api/exchange-rates") return json(catalog.exchange_rates);

  const history = route.match(/^\/api\/(history|latency)\/([^/]+)$/);
  if (history && method === "GET") {
    const id = decodeURIComponent(history[2]);
    const server = catalog.servers.find((server) => server.id === id);
    if (!server) return fail("节点不存在", 404);
    const hours = Math.min(720, Math.max(1, Number(url.searchParams.get("hours")) || 1));
    const sampled = sampleServer(server, now, startedAt);
    const tasks = catalog.latency_tasks.filter((task) => sampled.latency.some((point) => point.task_id === task.id));
    return json(history[1] === "history"
      ? { points: historyFor(server, hours, now, startedAt) }
      : { tasks, points: latencyHistoryFor(server, hours, now, startedAt).filter((point) => tasks.some((task) => task.id === point.task_id)) });
  }

  if (method !== "GET") return fail(READ_ONLY, 403);

  switch (route) {
    case "/api/admin/servers":
      return json({ servers: serversAt(catalog, now, startedAt).map(demoAdminServer) });
    case "/api/admin/settings": return json(await settingsFor(env, catalog));
    case "/api/admin/themes":
      return json({ themes: [{ id: catalog.config.active_theme_id, name: "NodeFlare", description: "内置主题", url: "", version: "1.0.0", builtin: true, active: true }] });
    case "/api/admin/theme-settings":
      return json({ schema: 1, source: "builtin", settings: [
        { key: "enableBlur", label: "背景模糊", type: "toggle", default: true },
        { key: "showCarrierLatency", label: "分线路延迟", type: "toggle", default: false },
      ] });
    case "/api/admin/2fa/status": return json({ enabled: false, has_secret: false });
    case "/api/admin/latency-tasks":
      return json({ tasks: catalog.latency_tasks.map((task): LatencyTask => ({
        ...task,
        default_enabled: true,
        server_ids: catalog.servers
          .filter((server) => server.latency.some((point) => point.task_id === task.id))
          .map((server) => server.id),
      })) });
    case "/api/admin/alert-rules": return json({ rules: catalog.alert_rules });
    case "/api/admin/telegram": return json({ telegram: catalog.telegram });
    case "/api/admin/database": return json(catalog.database);
    case "/api/admin/sessions":
      return json({ sessions: [{
        id: "demo-session", ip_address: "192.0.2.1",
        user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        created_at: now - 300, last_seen_at: now, expires_at: now + SESSION_MAX_AGE, current: true,
      }] });
  }

  // 未覆盖的 /api/* 一律按演示只读处理，避免前端误以为后端支持该操作。
  return fail(READ_ONLY, 403);
}
