// KV 数据层：演示站的"数据库"。
//
// 说明：KV 存的是**目录数据**（配置、节点清单、延迟任务、告警规则、账号凭据、会话），
// 而 CPU/内存/网速这类波形是按秒实时算出来的 —— 把时序样本写进 KV 既没意义
// （KV 是最终一致的键值存储，不当时间序列用），也会让卡片失去实时感。
import { demoConfig, demoExchangeRates, demoLatencyTasks, demoServers } from "../shared/demo";
import { derivePassword } from "../shared/password";
import type { AlertRule, Config, ExchangeRates, LatencyTestPoint, Server, Settings, TelegramSettings } from "../shared/types";

const CATALOG_KEY = "demo:catalog";
const ADMIN_KEY = "demo:admin";
const SESSION_PREFIX = "demo:session:";
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
  exchange_rates: ExchangeRates;
  settings: Settings;
  database: { kind: string; size_bytes: number; reclaimable_bytes: number; restart_required: boolean };
}

interface AdminRecord {
  username: string;
  /** PBKDF2-SHA256 派生值（十六进制），前端登录时提交同款派生值，明文密码从不上网。 */
  password_derived: string;
  salt: string;
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
    telegram: { bot_token: "", chat_id: "", message_thread_id: null, template: "NodeFlare 通知\n节点：{{server_name}}\n事件：{{message}}" },
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
  const cached = (await env.DEMO_KV.get(CATALOG_KEY, "json")) as Catalog | null;
  if (cached) return cached;
  const seed = seedCatalog();
  await env.DEMO_KV.put(CATALOG_KEY, JSON.stringify(seed));
  return seed;
}

export async function loadAdmin(env: Env): Promise<AdminRecord> {
  const cached = (await env.DEMO_KV.get(ADMIN_KEY, "json")) as AdminRecord | null;
  if (cached) return cached;
  const salt = demoConfig.password_client_salt;
  const record: AdminRecord = { username: "admin", password_derived: await derivePassword("admin", salt), salt };
  await env.DEMO_KV.put(ADMIN_KEY, JSON.stringify(record));
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
  await env.DEMO_KV.put(
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
  return (await env.DEMO_KV.get(`${SESSION_PREFIX}${token}`)) !== null;
}

export async function destroySession(env: Env, request: Request): Promise<void> {
  const token = readSessionCookie(request);
  if (token) await env.DEMO_KV.delete(`${SESSION_PREFIX}${token}`);
}

export function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
