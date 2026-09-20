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

export function sampleServer(server: Server, at: number, startedAt: number): Server {
  const elapsed = Math.max(0, at - startedAt);
  const online = server.id !== "toronto-standby";
  // A shared, time-based waveform keeps cards and history in sync. Values loop,
  // while timestamps, uptime and traffic counters continue moving forward.
  const seed = [...server.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const phase = ((at % DEMO_CYCLE_SECONDS) / DEMO_CYCLE_SECONDS) * Math.PI * 2 + seed;
  const wave = Math.sin(phase);
  const pulse = Math.cos(phase * 2);
  return {
    ...server,
    timestamp: online ? at : at - 640,
    cpu: online ? Math.round(Math.max(2, Math.min(96, (server.cpu ?? 24) + wave * 15 + pulse * 4))) : 0,
    load1: Math.max(0.01, (server.load1 ?? 0.4) + wave * 0.25),
    load5: Math.max(0.01, (server.load5 ?? 0.35) + wave * 0.15),
    load15: Math.max(0.01, (server.load15 ?? 0.27) + pulse * 0.1),
    mem_used: Math.round((server.mem_used ?? 0) * (1 + wave * 0.12)),
    disk_used: Math.round((server.disk_used ?? 0) * (1 + pulse * 0.004)),
    net_in: online ? Math.round((server.net_in ?? 0) * (1 + wave * 0.65)) : 0,
    net_out: online ? Math.round((server.net_out ?? 0) * (1 + pulse * 0.55)) : 0,
    net_rx_total: (server.net_rx_total ?? 0) + Math.round(elapsed * (server.net_in ?? 0)),
    net_tx_total: (server.net_tx_total ?? 0) + Math.round(elapsed * (server.net_out ?? 0)),
    uptime: (server.uptime ?? 0) + (online ? elapsed : 0),
    processes: Math.round((server.processes ?? 126) + wave * 8),
    tcp_connections: Math.round((server.tcp_connections ?? 342) + pulse * 35),
    disk_read_bps: Math.round((server.disk_read_bps ?? 0) * (1 + wave * 0.4)),
    disk_write_bps: Math.round((server.disk_write_bps ?? 0) * (1 + pulse * 0.4)),
    latency: server.latency.map((point, index) => ({
      ...point,
      timestamp: online ? at : at - 640,
      latency_ms: Math.round((38 + index * 7 + Math.sin(phase + index) * 6) * 10) / 10,
      packet_loss: index === 1 ? Math.round((0.5 + wave * 0.4) * 10) / 10 : 0,
    })),
  };
}

// 演示后台展示的节点字段：公网 IP、网卡、上报间隔等在真实部署里由 Agent 上报，
// 演示环境用固定值补齐，保证后台表单有完整的可读字段。
export function demoAdminServer(server: Server, index: number): AdminServer {
  return {
    ...server,
    hidden: false,
    last_ip: `192.0.2.${index + 10}`,
    ip_v4: `192.0.2.${index + 10}`,
    ip_v6: `2001:db8::${index + 10}`,
    network_interface: "eth0",
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
