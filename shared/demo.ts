import type { AdminServer, Config, ExchangeRates, HistoryPoint, LatencySample, LatencyTestPoint, Server } from "./types";
import { DEMO_CYCLE_SECONDS, DEMO_REFRESH_INTERVAL_MS, demoAdminServer as adminServerOf, historyFor, latencyHistoryFor, sampleServer as sampleAt } from "./sampling";
export { DEMO_CYCLE_SECONDS, DEMO_REFRESH_INTERVAL_MS };

export const demoConfig: Config = {
  site_name: "NodeFlare",
  site_description: "边缘节点与核心服务运行状态",
  site_announcement: "",
  logo_url: "",
  locale: "zh-CN",
  public_dashboard: true,
  offline_threshold_seconds: 180,
  history_retention_days: 30,
  default_theme: "system",
  active_theme_id: "builtin-nodeflare-glass",
  background_url: "",
  theme_options: {},
  show_search: true,
  show_groups: true,
  show_stats: true,
  show_assets: true,
  show_traffic: true,
  show_speed: true,
  show_price: true,
  show_expiry: true,
  show_latency: true,
  show_uptime: true,
  turnstile_enabled: false,
  turnstile_login_enabled: false,
  totp_login_enabled: false,
  turnstile_site_key: "",
};

export const demoExchangeRates: ExchangeRates = {
  base: "CNY",
  rates: {
    CNY: 1,
    USD: 0.139,
    CAD: 0.2086,
    EUR: 0.119,
    GBP: 0.103,
    JPY: 21.1,
    HKD: 1.09,
    RUB: 11.560694,
    CHF: 0.120661,
    INR: 14.248668,
    VND: 3875.968992,
    THB: 4.97107,
  },
  source: "demo",
  date: new Date().toISOString().slice(0, 10),
  fetched_at: Math.floor(Date.now() / 1000),
  stale: false,
};

// 注意：不要在模块顶层调用 Date.now()。
// Workers 在模块初始化阶段拿不到可信时钟（实测返回 0），会把 timestamp 写成 -12、
// 并且让 uptime 被算成 20000 天。种子数据只存相对量，绝对时间统一由采样函数补。

// 到期时间写成固定日期（2030 年后），不随部署时间漂移 —— 早期版本用 now + N 天，
// 而种子数据会固化进 KV，过一阵子就全部显示"已过期"。
const DAY = 86_400;
const EXPIRES = {
  "2030-03-31": Date.UTC(2030, 2, 31) / 1000,
  "2030-06-30": Date.UTC(2030, 5, 30) / 1000,
  "2031-01-31": Date.UTC(2031, 0, 31) / 1000,
  "2032-12-31": Date.UTC(2032, 11, 31) / 1000,
} as const;

const GB = 1024 ** 3;
const TB = 1024 ** 4;

// 延迟任务：探测目标按服务商命名，方便对照。
export const demoLatencyTasks: LatencyTestPoint[] = [
  { id: "ct-hk", name: "香港 TCP", task_type: "tcp", target: "hk-cn.aliyuncs.com", port: 443, interval_seconds: 60 },
  { id: "ct-tokyo", name: "东京 ICMP", task_type: "icmp", target: "ap-northeast-1.amazonaws.com", port: null, interval_seconds: 60 },
  { id: "ct-sg", name: "新加坡 TCP", task_type: "tcp", target: "asia-southeast1.gcp.cloud", port: 443, interval_seconds: 60 },
];

/**
 * 各地域到中国大陆的合理往返延迟（ms）与丢包率。
 * 数值参考真实链路：港澳台 & 日韩低、东南亚中、欧美高（含跨太平洋/欧亚陆缆）。
 */
const REGION_LATENCY: Record<string, { base: number; jitter: number; loss: number }> = {
  HK: { base: 22, jitter: 6, loss: 0 },      // 香港：同城/跨境专线
  TW: { base: 42, jitter: 8, loss: 0.1 },    // 台北：海峡光缆
  JP: { base: 58, jitter: 10, loss: 0.1 },   // 东京
  KR: { base: 62, jitter: 11, loss: 0.2 },   // 首尔
  SG: { base: 78, jitter: 14, loss: 0.3 },   // 新加坡
  US: { base: 152, jitter: 22, loss: 0.8 },  // 美西：跨太平洋
  DE: { base: 198, jitter: 26, loss: 1.2 },  // 法兰克福：欧亚陆缆
  CA: { base: 176, jitter: 24, loss: 1.0 },  // 多伦多：跨太平洋
};

function demoLatestLatency(region: string, serverId: string): LatencySample[] {
  const profile = REGION_LATENCY[region] ?? { base: 90, jitter: 15, loss: 0.5 };
  return demoLatencyTasks.map((task, index) => ({
    task_id: task.id,
    server_id: serverId,
    name: task.name,
    task_type: task.task_type,
    target: task.target,
    port: task.port,
    timestamp: 0,
    // 同一节点对不同探测目标略有差异，但都围绕该地域的基准值。
    latency_ms: Math.round((profile.base + index * 3) * 10) / 10,
    packet_loss: index === 1 ? profile.loss : 0,
  }));
}

const baseServer: Server = {
  id: "",
  name: "",
  region: "",
  group_name: "默认",
  tags: "",
  expires_at: null,
  traffic_limit: 0,
  traffic_limit_type: "sum",
  price: 0,
  billing_cycle: 30,
  currency: "CNY",
  auto_renewal: false,
  reset_day: 1,
  timestamp: 0,
  cpu: 24,
  load1: 0.42,
  load5: 0.35,
  load15: 0.27,
  mem_used: 3.36 * GB,
  mem_total: 8 * GB,
  swap_used: 0,
  swap_total: 2 * GB,
  disk_used: 49.6 * GB,
  disk_total: 160 * GB,
  net_in: 5.8 * 1024 ** 2,
  net_out: 1.2 * 1024 ** 2,
  net_rx_total: 640 * GB,
  net_tx_total: 220 * GB,
  uptime: 182 * DAY,
  processes: 126,
  tcp_connections: 342,
  udp_connections: 18,
  cpu_cores: 4,
  cpu_model: "AMD EPYC 7B13",
  os: "Debian GNU/Linux 12",
  kernel: "6.1.0",
  arch: "x86_64",
  virtualization: "KVM",
  gpu_usage: 0,
  gpu_model: "",
  agent_version: "1.0.0",
  disk_read_bps: 6.4 * 1024 ** 2,
  disk_write_bps: 2.1 * 1024 ** 2,
  disk_read_iops: 128,
  disk_write_iops: 46,
  disk_await_ms: 1.2,
  disk_utilization: 8.4,
  disks: [],
  gpus: [],
  latency: [],
};

function node(input: Partial<Server> & Pick<Server, "id" | "name">): Server {
  const server = { ...baseServer, ...input };
  server.latency = input.latency ?? demoLatestLatency(server.region, server.id);
  return server;
}

// 节点清单：服务商与地域按真实部署常见组合填写。
export const demoServers: Server[] = [
  node({
    id: "hk-aliyun", name: "香港 阿里云", region: "HK", group_name: "边缘网络",
    tags: "主力,阿里云,BGP", price: 128, expires_at: EXPIRES["2030-06-30"],
    traffic_limit: 1 * TB, net_rx_total: 420 * GB, net_tx_total: 160 * GB,
  }),
  node({
    id: "taipei-hinet", name: "台北 中华电信", region: "TW", group_name: "边缘网络",
    tags: "主力,HiNet,固定IP", price: 199, currency: "CNY", expires_at: EXPIRES["2030-03-31"],
    cpu: 34, mem_total: 16 * GB, mem_used: 6.72 * GB, disk_total: 224 * GB, disk_used: 69.44 * GB,
    traffic_limit: 2 * TB, net_rx_total: 760 * GB, net_tx_total: 290 * GB,
  }),
  node({
    id: "tokyo-aws", name: "东京 AWS", region: "JP", group_name: "核心服务",
    tags: "主力,AWS,Premium", price: 9.9, currency: "USD", billing_cycle: 30, expires_at: EXPIRES["2030-06-30"],
    cpu: 31, mem_total: 16 * GB, mem_used: 6.72 * GB, disk_total: 224 * GB, disk_used: 69.44 * GB,
    traffic_limit: 1 * TB, net_rx_total: 450 * GB, net_tx_total: 170 * GB,
  }),
  node({
    id: "seoul-tencent", name: "首尔 腾讯云", region: "KR", group_name: "边缘网络",
    tags: "备用,腾讯云,BGP", price: 76, expires_at: EXPIRES["2030-03-31"],
    disk_total: 352 * GB, disk_used: 109.12 * GB, traffic_limit: 800 * GB,
    net_rx_total: 310 * GB, net_tx_total: 110 * GB,
  }),
  node({
    id: "singapore-gcp", name: "新加坡 Google", region: "SG", group_name: "数据服务",
    tags: "数据库,GCP,NVMe", price: 88, expires_at: EXPIRES["2030-06-30"],
    mem_total: 24 * GB, mem_used: 10.08 * GB, disk_total: 288 * GB, disk_used: 89.28 * GB,
    traffic_limit: 2 * TB, net_rx_total: 690 * GB, net_tx_total: 240 * GB,
  }),
  node({
    id: "frankfurt-netcup", name: "法兰克福 Netcup", region: "DE", group_name: "实验服务",
    tags: "Lab,Netcup,IPv6", price: 8.99, currency: "EUR", expires_at: EXPIRES["2030-03-31"],
    cpu: 52, mem_total: 16 * GB, mem_used: 6.72 * GB, disk_total: 512 * GB, disk_used: 148 * GB,
    traffic_limit: 2 * TB, net_rx_total: 500 * GB, net_tx_total: 190 * GB,
    uptime: 134 * DAY,
  }),
  node({
    id: "los-angeles-aws", name: "洛杉矶 AWS", region: "US", group_name: "边缘网络",
    tags: "备用,AWS,CN2", price: 24, currency: "USD", expires_at: EXPIRES["2031-01-31"],
    cpu: 45, disk_total: 352 * GB, disk_used: 109.12 * GB,
    traffic_limit: 1 * TB, net_rx_total: 380 * GB, net_tx_total: 140 * GB,
  }),
  node({
    id: "toronto-ovh", name: "多伦多 OVH", region: "CA", group_name: "备用节点",
    tags: "Standby,OVH", price: 16, currency: "CAD", expires_at: EXPIRES["2032-12-31"],
    traffic_limit: 1 * TB, net_rx_total: 300 * GB, net_tx_total: 110 * GB,
    timestamp: 0, cpu: 0, net_in: 0, net_out: 0,
  }),
];

// startedAt 表示"数据开始累计的时刻"；传 0 时由采样函数按当前时刻处理。
function sampleServer(server: Server, at: number): Server {
  return sampleAt(server, at, 0);
}

export function demoServersAt(at = Math.floor(Date.now() / 1000)): Server[] {
  return demoServers.map((server) => sampleServer(server, at));
}

export function demoAdminServer(server: Server, index: number): AdminServer {
  return adminServerOf(server, index);
}

// “添加节点”弹窗在演示模式下的样例：不在监控列表中，只用于展示配置表单和实时数值。
const draftServer: Server = {
  ...baseServer,
  id: "osaka-vultr",
  name: "大阪 Vultr",
  region: "JP",
  group_name: "边缘网络",
  tags: "备用,Vultr,BGP",
  price: 48,
  expires_at: EXPIRES["2030-06-30"],
  traffic_limit: 1 * TB,
  net_rx_total: 320 * GB,
  net_tx_total: 96 * GB,
  cpu: 28,
};

export function demoDraftServer(at = Math.floor(Date.now() / 1000)): AdminServer {
  draftServer.latency = demoLatestLatency(draftServer.region, draftServer.id);
  return demoAdminServer(sampleServer(draftServer, at), 14);
}

export function demoHistory(serverId: string, hours: number, at = Math.floor(Date.now() / 1000)): HistoryPoint[] {
  const server = demoServers.find((entry) => entry.id === serverId);
  return server ? historyFor(server, hours, at, 0) : [];
}

export function demoLatencyHistory(serverId: string, hours: number, at = Math.floor(Date.now() / 1000)): LatencySample[] {
  const server = demoServers.find((entry) => entry.id === serverId);
  return server ? latencyHistoryFor(server, hours, at, 0) : [];
}
