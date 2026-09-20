// 演示站入口判定：决定 URL 形态与登录方式，不决定数据从哪来。
//
//   1. Worker 后端（`bun run preview` / 部署到 Cloudflare）→ 首页 /，后台 /admin
//   2. 纯静态托管（GitHub Pages 等）→ 后台入口是 admin.html#/admin/login（hash 路由）
//
// 数据来源（KV 后端 vs 前端内置模拟）由 src/api.ts 在运行时探测，因为同一份
// 构建产物既可能放在纯静态托管上，也可能跑在带 KV 的 Worker 上。
const staticDemo = import.meta.env?.VITE_DEMO === "true"
  && typeof window !== "undefined";

/** `bun run dev` 下带 ?demo 时也走演示入口，方便本地直接看演示版。 */
const previewDemo = import.meta.env?.DEV === true
  && typeof window !== "undefined"
  && new URLSearchParams(window.location.search).has("demo");

export const demoMode = staticDemo || previewDemo;

const demoBase = import.meta.env?.BASE_URL ?? "/";
const demoQuery = import.meta.env?.DEV ? "?demo=1" : "";

/** 部署在子路径（如 /demo/）时的首页与后台地址。 */
export const dashboardHref = demoMode ? `${demoBase}${demoQuery}` : "/";
export const adminHref = demoMode ? `${demoBase}admin.html${demoQuery}#/admin/login` : "/admin/login";
