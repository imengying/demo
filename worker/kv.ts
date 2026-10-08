// KV 数据层：演示站的"数据库"。
//
// 说明：KV 存的是**目录数据**（配置、节点清单、延迟任务、告警规则、账号凭据、会话），
// 而 CPU/内存/网速这类波形是按秒实时算出来的 —— 把时序样本写进 KV 既没意义
// （KV 是最终一致的键值存储，不当时间序列用），也会让卡片失去实时感。
import { demoConfig, demoExchangeRates, demoLatencyTasks, demoServers } from "../shared/demo";
import type { AlertRule, Config, ExchangeRates, LatencyTestPoint, Server, Settings, TelegramSettings, WebhookSettingsView } from "../shared/types";

const CATALOG_KEY = "nodeflare:catalog";
const ADMIN_KEY = "nodeflare:admin";
const SESSION_PREFIX = "nodeflare:session:";
const SESSION_TTL_SECONDS = 86_400;

const SESSION_COOKIE = "nodeflare_demo_session";
/** 所有 API 响应都带这个头，前端据此判断"有没有真后端"，从而决定走 KV 还是本地模拟。 */
export const API_MARKER = "X-NodeFlare-API";

export interface Catalog {
  config: Config;
  servers: Server[];
  latency_tasks: LatencyTestPoint[];
  alert_rules: AlertRule[];
  telegram: TelegramSettings;
  webhooks?: WebhookSettingsView[];
  exchange_rates: ExchangeRates;
  settings: Settings;
  database: { kind: string; size_bytes: number; reclaimable_bytes: number; restart_required: boolean };
}

interface AdminRecord {
  username: string;
  /** 明文密码。演示站凭据存 KV 且只读，不追求密码学强度；
   *  之前存 PBKDF2 600k 派生值会在 Worker 里爆 CPU 时间限制（线上 error 1101）。 */
  password: string;
}

function seedCatalog(): Catalog {
  return {
    config: demoConfig,
    servers: demoServers,
    latency_tasks: demoLatencyTasks,
    alert_rules: [
      { id: "demo-cpu-alert", name: "CPU 持续高负载", metric: "cpu", threshold: 85, duration_minutes: 5, aggregation: "average", all_servers: true, enabled: true, server_ids: [] },
      { id: "demo-memory-alert", name: "内存使用率过高", metric: "memory", threshold: 90, duration_minutes: 10, aggregation: "continuous", all_servers: true, enabled: true, server_ids: [] },
    ],
    telegram: { enabled: false, bot_token: "", chat_id: "", message_thread_id: null, template: "{{title}}\n\n服务器：{{server}}\n{{message}}\n时间：{{time}}" },
    webhooks: [],
    exchange_rates: demoExchangeRates,
    settings: {
      ...demoConfig,
      admin_username: "admin",
      admin_password_configured: true,
      turnstile_secret_key: "",
      notification_enabled: true,
      offline_alert_minutes: 5,
      expiry_alert_days: 7,
      traffic_alert_percentage: 80,
    },
    database: { kind: "sqlite", size_bytes: 48 * 1024 ** 2, reclaimable_bytes: 3 * 1024 ** 2, restart_required: false },
  };
}

/** 读取目录；首次访问时用默认值播种，之后可以直接在 Cloudflare 控制台里改 KV。 */
export async function loadCatalog(env: Env): Promise<Catalog> {
  const cached = (await env.KV.get(CATALOG_KEY, "json")) as Catalog | null;
  if (cached) return cached;
  const seed = seedCatalog();
  await env.KV.put(CATALOG_KEY, JSON.stringify(seed));
  return seed;
}

export async function loadAdmin(env: Env): Promise<AdminRecord> {
  const cached = (await env.KV.get(ADMIN_KEY, "json")) as AdminRecord | null;
  if (cached) return cached;
  const record: AdminRecord = { username: "admin", password: "admin" };
  await env.KV.put(ADMIN_KEY, JSON.stringify(record));
  return record;
}

/** 定长比较，避免用 === 比较密钥时泄露时序信息。 */
export function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

export async function createSession(env: Env): Promise<string> {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  await env.KV.put(
    `${SESSION_PREFIX}${token}`,
    JSON.stringify({ created_at: Math.floor(Date.now() / 1000) }),
    { expirationTtl: SESSION_TTL_SECONDS },
  );
  return token;
}

function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

export async function hasSession(env: Env, request: Request): Promise<boolean> {
  const token = readSessionCookie(request);
  if (!token) return false;
  return (await env.KV.get(`${SESSION_PREFIX}${token}`)) !== null;
}

export async function destroySession(env: Env, request: Request): Promise<void> {
  const token = readSessionCookie(request);
  if (token) await env.KV.delete(`${SESSION_PREFIX}${token}`);
}

export function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
