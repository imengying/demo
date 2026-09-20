// /api/ws 实时推送：把采样后的指标按 gzip 压缩后推给前端，
// 与 NodeFlare 真实服务端的帧格式一致（transport.ts 负责解压）。
//
// 说明：Cloudflare 的 Durable Objects 才是"多连接共享定时器"的标准做法；
// 演示站每个连接自带一个 1 秒闹钟，成本与复杂度都更低，且实测足够稳定。
import { loadCatalog } from "./kv";
import { sampleServer } from "../shared/sampling";

const TICK_MS = 1_000;
/** 每个连接最多持有的节点数，避免有人订阅一个不存在的 id 时白跑采样。 */
const MAX_SERVERS = 64;

interface LiveSample {
  ts: number;
  data: Record<string, unknown>;
}

/** 只推变化的指标，去掉恒定不变的档案字段，压低每帧体积。 */
function samplePayload(server: Record<string, unknown>, at: number, startedAt: number): LiveSample {
  const sampled = sampleServer(server as never, at, startedAt);
  const data: Record<string, unknown> = {
    cpu: sampled.cpu,
    load1: sampled.load1,
    load5: sampled.load5,
    load15: sampled.load15,
    mem_used: sampled.mem_used,
    disk_used: sampled.disk_used,
    net_in: sampled.net_in,
    net_out: sampled.net_out,
    net_rx_total: sampled.net_rx_total,
    net_tx_total: sampled.net_tx_total,
    uptime: sampled.uptime,
    processes: sampled.processes,
    tcp_connections: sampled.tcp_connections,
    disk_read_bps: sampled.disk_read_bps,
    disk_write_bps: sampled.disk_write_bps,
    latency_results: sampled.latency.map((point) => ({
      task_id: point.task_id,
      timestamp: point.timestamp,
      latency_ms: point.latency_ms,
      packet_loss: point.packet_loss,
    })),
  };
  return { ts: sampled.timestamp ?? at, data };
}

async function gzip(payload: unknown): Promise<ArrayBuffer> {
  const stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

export async function handleLiveSocket(request: Request, env: Env, startedAt: number): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const serverId = new URL(request.url).searchParams.get("server_id");
  const catalog = await loadCatalog(env);
  const servers = (serverId ? catalog.servers.filter((server) => server.id === serverId) : catalog.servers)
    .slice(0, MAX_SERVERS);

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const tick = async () => {
    const at = Math.floor(Date.now() / 1000);
    const updates = servers.map((entry) => ({
      serverId: entry.id,
      samples: [samplePayload(entry as unknown as Record<string, unknown>, at, startedAt)],
    }));
    try {
      const frame = await gzip({ type: "batchUpdate", updates });
      server.send(frame);
    } catch {
      stop();
      try { server.close(1011, "encode failed"); } catch { /* already closed */ }
    }
  };

  server.addEventListener("message", (event) => {
    // transport.ts 每 30s 发一次 "ping"，必须回 "pong" 否则前端判定半开连接并重连。
    if (event.data === "ping") {
      try { server.send("pong"); } catch { /* closing */ }
    }
  });
  server.addEventListener("close", stop);
  server.addEventListener("error", stop);

  timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();

  return new Response(null, { status: 101, webSocket: client });
}
