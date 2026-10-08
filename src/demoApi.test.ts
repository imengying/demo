import { describe, expect, test } from "bun:test";
import { createDemoRequest } from "./demoApi";
import { demoDraftServer, demoHistory, demoServersAt } from "../shared/demo";
import { OFFLINE_SERVER_ID } from "../shared/sampling";

// A storage stub matching the Pick<Storage> surface the demo request accepts.
function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

function post(request: ReturnType<typeof createDemoRequest>, path: string, body: unknown) {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

describe("demo admin session", () => {
  test("accepts only the admin / admin credentials", async () => {
    const request = createDemoRequest(memoryStore());

    expect((await post(request, "/api/admin/login", { username: "admin", password: "admin123" })).status).toBe(401);
    expect((await post(request, "/api/admin/login", { username: "root", password: "admin" })).status).toBe(401);
    const ok = await post(request, "/api/admin/login", { username: "admin", password: "admin" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ token: "demo-only" });
  });

  test("serves admin reads only while signed in and rejects every write", async () => {
    const request = createDemoRequest(memoryStore());
    expect((await request("/api/admin/settings")).status).toBe(401);

    await post(request, "/api/admin/login", { username: "admin", password: "admin" });
    const settings = await request("/api/admin/settings");
    expect(settings.status).toBe(200);
    expect((await settings.json()).admin_username).toBe("admin");

    expect((await request("/api/admin/settings", { method: "PATCH", body: "{}" })).status).toBe(403);
    expect((await post(request, "/api/admin/servers", { name: "x" })).status).toBe(403);

    await post(request, "/api/admin/logout", {});
    expect((await request("/api/admin/settings")).status).toBe(401);
  });

  test("covers the admin tabs the demo UI renders", async () => {
    const request = createDemoRequest(memoryStore());
    await post(request, "/api/admin/login", { username: "admin", password: "admin" });
    for (const path of [
      "/api/admin/servers",
      "/api/admin/settings",
      "/api/admin/themes",
      "/api/admin/theme-settings",
      "/api/admin/2fa/status",
      "/api/admin/latency-tasks",
      "/api/admin/alert-rules",
      "/api/admin/telegram",
      "/api/admin/webhooks",
      "/api/admin/database",
      "/api/admin/sessions",
    ]) {
      expect((await request(path)).status).toBe(200);
    }
    const servers = (await (await request("/api/admin/servers")).json()).servers;
    expect(servers.length).toBeGreaterThan(0);
    const history = await request(`/api/history/${servers[0].id}?hours=1`);
    expect((await history.json()).points.length).toBeGreaterThan(0);
  });

  test("notification channels are readable but cannot send, save or delete anything", async () => {
    const request = createDemoRequest(memoryStore());
    expect((await request("/api/admin/webhooks")).status).toBe(401);
    await post(request, "/api/admin/login", { username: "admin", password: "admin" });
    expect(await (await request("/api/admin/webhooks")).json()).toEqual({ webhooks: [] });
    const telegram = (await (await request("/api/admin/telegram")).json()).telegram;
    expect(telegram.enabled).toBe(false);
    for (const [path, method] of [
      ["/api/admin/telegram", "PUT"],
      ["/api/admin/telegram/test", "POST"],
      ["/api/admin/webhooks", "PUT"],
      ["/api/admin/webhooks/bark/test", "POST"],
      ["/api/admin/webhooks/discord", "DELETE"],
    ]) {
      const response = await request(path, { method, body: "{}" });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "演示环境不支持修改。" });
    }
    expect(await (await request("/api/admin/webhooks")).json()).toEqual({ webhooks: [] });
  });

  test("node settings include UTC and disabled local remote control without an actual Agent", async () => {
    const request = createDemoRequest(memoryStore());
    await post(request, "/api/admin/login", { username: "admin", password: "admin" });
    const { servers } = await (await request("/api/admin/servers")).json();
    for (const server of servers) {
      expect(server.reset_timezone).toBe("UTC");
      expect(server.agent_remote_control).toBe(false);
      expect(server.remote_control).toBeNull();
      expect(server.collect_interval).toBe(3);
    }
    expect((await request(`/api/admin/servers/${servers[0].id}`, {
      method: "PATCH", body: JSON.stringify({ agent_remote_control: true }),
    })).status).toBe(403);
  });
});

describe("demo live waveform", () => {
  test("cycles metric values over the shared period and stays bounded", () => {
    const samples = [0, 60, 119].map((offset) => demoServersAt(1_800_000_000 + offset));
    const online = samples[0].filter((server) => server.id !== OFFLINE_SERVER_ID);
    expect(online.length).toBeGreaterThan(0);

    // Values actually move between samples for every online server...
    for (const { id } of online) {
      const values = samples.map((sample) => Math.round(sample.find((server) => server.id === id)?.cpu ?? 0));
      expect(new Set(values).size).toBeGreaterThan(1);
    }
    // ...stay within sane bounds...
    for (const sample of samples) {
      for (const server of sample) {
        expect(server.cpu ?? 0).toBeGreaterThanOrEqual(0);
        expect(server.cpu ?? 0).toBeLessThanOrEqual(100);
        expect(server.load1 ?? 0).toBeGreaterThan(0);
      }
    }
    // ...and the offline standby server reports zero traffic at every phase.
    for (const sample of samples) {
      const standby = sample.find((server) => server.id === OFFLINE_SERVER_ID);
      expect(standby?.net_in).toBe(0);
      expect(standby?.cpu).toBe(0);
    }
  });

  test("keeps history and current samples on the same waveform", () => {
    const at = Math.floor(Date.now() / 1000);
    const history = demoHistory("hk-aliyun", 1, at);
    expect(history.length).toBeGreaterThan(1);
    const latest = history[history.length - 1];
    const current = demoServersAt(at).find((server) => server.id === "hk-aliyun");
    expect(current).toBeDefined();
    // The last history point and the live card read the same timestamp, so
    // the values must match exactly.
    expect(latest.cpu).toBe(current?.cpu ?? -1);
    expect(latest.net_in).toBe(current?.net_in ?? -1);
  });

  test("samples the add-server dialog draft on the shared waveform", () => {
    const at = 1_800_000_000;
    const draft = demoDraftServer(at);
    // The draft is only shown by the dialog: it stays out of the monitored list
    // and carries the admin-only fields the form reads.
    expect(demoServersAt(at).some((server) => server.id === draft.id)).toBe(false);
    expect(draft.name).toBeTruthy();
    expect(draft.network_interface).toBe("eth0");
    expect(draft.ip_v6.startsWith("2001:db8::")).toBe(true);
    // Successive samples move the traffic counters the dialog displays.
    const later = demoDraftServer(at + 60);
    expect(later.net_rx_total ?? 0).toBeGreaterThan(draft.net_rx_total ?? 0);
    expect(later.tx_correction).toBe(0);
  });
});
