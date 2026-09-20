// NodeFlare 演示站 Worker。
//
// 静态资源由 Workers Static Assets 托管，Worker 负责 /api/*：
//   - /api/ws  实时指标推送（WebSocket + gzip 帧）
//   - 其余 API 读接口由 KV 播种的数据提供服务，写接口一律拒绝
//
// 路由配置见 wrangler.jsonc：
//   - assets.not_found_handling = "single-page-application" → 未命中的路径回 index.html
//   - assets.html_handling = "none"                         → 保留 /admin.html 原样，不做 307
//   - public/_redirects 把 /admin 与 /admin/* 重写到 /admin.html
import { handleApi } from "./api";
import { API_MARKER } from "./kv";
import { handleLiveSocket } from "./live";

// 模块级初始化：Worker 冷启动时确定，同一 isolate 内复用，避免每次请求都重算。
const STARTED_AT = Math.floor(Date.now() / 1000);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/ws") {
      const response = await handleLiveSocket(request, env, STARTED_AT);
      response.headers.set(API_MARKER, "1");
      return response;
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const response = await handleApi(request, env, STARTED_AT);
      // 前端靠这个头判断"有真后端"，据此决定走 KV API 还是纯前端模拟。
      response.headers.set(API_MARKER, "1");
      return response;
    }

    // 其余请求（/、/instance/:id、/admin.html、/assets/*、/os-icons/*）交给静态资源。
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
