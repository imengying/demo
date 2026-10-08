// 波形采样：纯函数，不依赖浏览器 API，前端与 Worker 共用。
//
// 为什么模拟数据不整个塞进 KV：CPU / 内存 / 网速是**按秒变化的时序波形**，
// 由这里的 sin/cos 函数实时算出来。KV 是最终一致的键值存储，既不适合存时序样本，
// 写进去也只会变成静态死数据，卡片不再跳动。KV 负责"档案数据"（节点清单、配置、
// 账号凭据、延迟任务等），波形在读取时计算。
import type { AdminServer, HistoryPoint, LatencySample, Server } from "./types";

export const DEMO_REFRESH_INTERVAL_MS = 1_000;
// A prime cycle keeps whole-minute history steps off the same waveform phase,
// so sampled history does not flatten into a repeating pattern.
export const DEMO_CYCLE_SECONDS = 97;

/** 演示用的离线节点：始终离线，用于展示离线样式与卡片状态。 */
export const OFFLINE_SERVER_ID = "toronto-ovh";

/** 由节点 id 派生稳定的伪随机种子，让各节点的流量曲线错开。 */
function periodSeed(id: string, salt: number) {
  return [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) * salt;
}

/**
 * 计费周期内的累计流量。
 *
 * 真实面板里该值由 Agent 上报并随周期重置，这里用确定性函数模拟：
 * 在 `billingCycle` 天内从基础值平滑增长到一个周期用量，周期一到归零重来。
 * 基础增长率由节点自身的日均流量（几十 GB 量级）决定，不会把配额撑爆。
 */
function monthlyTraffic(base: number, billingCycle: number, at: number, seed: number) {
  const cycleDays = billingCycle > 0 ? billingCycle : 30;
  const cycleSeconds = cycleDays * 86_400;
  const phase = ((at + seed) % cycleSeconds) / cycleSeconds; // 0..1
  // 周期内增长到基础值的 1.5 倍，月底回落到起点，形成自然的锯齿。
  return Math.round(base * (0.7 + phase * 0.8));
}

export function sampleServer(server: Server, at: number, startedAt: number): Server {
  // startedAt = 0 表示没有可信的起始时刻（KV 种子数据不存绝对时间），
  // 此时不把 uptime 继续往上加，避免算成几万天。
  const elapsed = startedAt > 0 ? Math.max(0, at - startedAt) : 0;
  const online = server.id !== OFFLINE_SERVER_ID;
  // A shared, time-based waveform keeps cards and history in sync. Values loop,
  // while timestamps, uptime and traffic counters continue moving forward.
  const seed = [...server.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const phase = ((at % DEMO_CYCLE_SECONDS) / DEMO_CYCLE_SECONDS) * Math.PI * 2 + seed;
  const wave = Math.sin(phase);
  const pulse = Math.cos(phase * 2);
  return {
    ...server,
    // 始终写成绝对时间（种子里的 timestamp 为 0，不能直接透传）。
    timestamp: online ? at : at - 640,
    cpu: online ? Math.round(Math.max(2, Math.min(96, (server.cpu ?? 24) + wave * 15 + pulse * 4))) : 0,
    load1: Math.max(0.01, (server.load1 ?? 0.4) + wave * 0.25),
    load5: Math.max(0.01, (server.load5 ?? 0.35) + wave * 0.15),
    load15: Math.max(0.01, (server.load15 ?? 0.27) + pulse * 0.1),
    mem_used: Math.round((server.mem_used ?? 0) * (1 + wave * 0.12)),
    disk_used: Math.round((server.disk_used ?? 0) * (1 + pulse * 0.004)),
    net_in: online ? Math.round((server.net_in ?? 0) * (1 + wave * 0.65)) : 0,
    net_out: online ? Math.round((server.net_out ?? 0) * (1 + pulse * 0.55)) : 0,
    // 累计流量按 "月" 重置（与 billing_cycle 一致），且用日均增量而不是瞬时速率：
    // 直接把当前速率（MB/s）乘以已运行秒数会算出几百 GB/天，很快超过配额。
    // 这里让累计量在一个计费周期内平滑增长到约日增几 GB。
    net_rx_total: online ? monthlyTraffic(server.net_rx_total ?? 0, server.billing_cycle, at, periodSeed(server.id, 1)) : server.net_rx_total ?? 0,
    net_tx_total: online ? monthlyTraffic(server.net_tx_total ?? 0, server.billing_cycle, at, periodSeed(server.id, 2)) : server.net_tx_total ?? 0,
    uptime: (server.uptime ?? 0) + (online ? elapsed : 0),
    processes: Math.round((server.processes ?? 126) + wave * 8),
    tcp_connections: Math.round((server.tcp_connections ?? 342) + pulse * 35),
    disk_read_bps: Math.round((server.disk_read_bps ?? 0) * (1 + wave * 0.4)),
    disk_write_bps: Math.round((server.disk_write_bps ?? 0) * (1 + pulse * 0.4)),
    // 围绕该节点自身的基准延迟波动（基准值按地域设定，见 shared/demo.ts）。
    latency: server.latency.map((point, index) => ({
      ...point,
      timestamp: online ? at : at - 640,
      latency_ms: Math.round(Math.max(1, (point.latency_ms || 40) + Math.sin(phase + index) * 5) * 10) / 10,
      packet_loss: Math.max(0, Math.round((point.packet_loss + wave * 0.3) * 10) / 10),
    })),
  };
}

// 演示后台展示的节点字段：公网 IP、网卡、上报间隔等在真实部署里由 Agent 上报，
// 演示环境用固定值补齐，保证后台表单有完整的可读字段。
export function demoAdminServer(server: Server, index: number): AdminServer {
  return {
    ...server,
    remote_control: null,
    agent_remote_control: false,
    hidden: false,
    last_ip: `192.0.2.${index + 10}`,
    ip_v4: `192.0.2.${index + 10}`,
    ip_v6: `2001:db8::${index + 10}`,
    network_interface: "eth0",
    reset_timezone: "UTC",
    report_interval: 60,
    collect_interval: 3,
    rx_correction: 0,
    tx_correction: 0,
    agent_mirror: "",
    offline_notify_disabled: false,
    auto_update: true,
  };
}

export function historyFor(server: Server, hours: number, at: number, startedAt: number): HistoryPoint[] {
  const count = Math.min(180, Math.max(30, hours * 6));
  const step = Math.max(60, Math.floor((hours * 3600) / count));
  return Array.from({ length: count }, (_, index) => {
    const timestamp = at - (count - index - 1) * step;
    const sampled = sampleServer(server, timestamp, startedAt);
    return {
      timestamp,
      cpu: sampled.cpu ?? 0,
      load1: sampled.load1 ?? 0, load5: sampled.load5 ?? 0, load15: sampled.load15 ?? 0,
      mem_used: sampled.mem_used ?? 0, mem_total: sampled.mem_total ?? 0,
      swap_used: sampled.swap_used ?? 0, swap_total: sampled.swap_total ?? 0,
      disk_used: sampled.disk_used ?? 0, disk_total: sampled.disk_total ?? 0,
      net_in: sampled.net_in ?? 0, net_out: sampled.net_out ?? 0,
      net_rx_total: sampled.net_rx_total ?? 0, net_tx_total: sampled.net_tx_total ?? 0,
      processes: sampled.processes ?? 0, tcp_connections: sampled.tcp_connections ?? 0,
      udp_connections: sampled.udp_connections ?? 0, gpu_usage: sampled.gpu_usage ?? 0,
      disk_read_bps: sampled.disk_read_bps ?? 0, disk_write_bps: sampled.disk_write_bps ?? 0,
      disk_read_iops: sampled.disk_read_iops ?? 0, disk_write_iops: sampled.disk_write_iops ?? 0,
      disk_await_ms: sampled.disk_await_ms ?? 0, disk_utilization: sampled.disk_utilization ?? 0,
    };
  });
}

export function latencyHistoryFor(server: Server, hours: number, at: number, startedAt: number): LatencySample[] {
  const count = Math.min(180, Math.max(30, hours * 6));
  const step = Math.max(60, Math.floor((hours * 3600) / count));
  return Array.from({ length: count }, (_, index) =>
    sampleServer(server, at - (count - index - 1) * step, startedAt).latency,
  ).flat();
}
