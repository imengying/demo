# NodeFlare Demo

[NodeFlare](https://github.com/elysia62/NodeFlare) 的公开演示站：看板 + 管理面板，部署在 Cloudflare Workers 上。

演示站用于简单体验看板和管理面板，按需同步上游界面与浏览体验。本次参考上游 `42eff9e`（2026-09-28），更新后台布局和延迟显示，继续使用模拟数据与只读 API，历史范围最多 30 天。

后台演示账号和密码均为 `admin`；可以浏览节点配置，所有数据修改均被拒绝。

## 技术栈

| 层 | 说明 |
| --- | --- |
| 前端 | React 19 + Vite 8，纯静态 SPA |
| 静态资源 | Cloudflare Workers Static Assets |
| 后端 | Worker（`/api/*`），数据存在 Workers KV |
| 实时推送 | WebSocket（`/api/ws`），每秒推一帧 gzip 压缩的指标 |

## 目录结构

```
├── index.html            看板入口（Vite entry）
├── admin.html            管理面板入口（Vite entry）
├── src/                  前端源码
│   ├── components/          UI 组件（admin/ 为后台各标签页）
│   ├── hooks/               浏览器外观等 React hooks
│   ├── styles/              dashboard.css / admin.css
│   ├── api.ts               请求封装；运行时探测后端形态
│   ├── demoApi.ts           纯静态托管时的前端模拟实现
│   ├── demoMode.ts          入口判定（URL 形态）
│   └── transport.ts         /api/ws 客户端（重连、心跳、解压）
├── worker/               后端（Cloudflare Worker）
│   ├── index.ts             入口与路由分发
│   ├── api.ts               /api/* 只读接口
│   ├── live.ts              /api/ws 实时推送
│   └── kv.ts                KV 数据层（目录数据 + 会话）
├── shared/               前后端共用（纯函数，不依赖浏览器 API）
│   ├── types.ts             全部数据接口定义
│   ├── demo.ts              演示数据源（节点清单、配置、汇率…）
│   └── sampling.ts          波形采样：CPU / 内存 / 网速按秒生成
└── public/               Static Assets（原样发布）
    ├── os-icons/            系统图标
    ├── _redirects           /admin → /admin.html 重写
    └── _headers             静态资源缓存策略
```

## 本地开发

使用 Bun **1.4.2**（与 `package.json` 中的 `packageManager` 保持一致）。

```bash
bun install --frozen-lockfile
bun run dev          # Vite 开发服务器（HMR），默认走前端模拟；带 ?demo=1 看演示版
```

## 本地预览（真实 Worker 运行时）

```bash
bun run preview      # wrangler dev，含 KV、WebSocket，最接近线上
```

首次运行会自动往 KV 播种默认数据。想改数据，直接在 Cloudflare 控制台或本地
`.wrangler/state` 里改 KV，不用动代码。

### Cloudflare 网页连接 Git 仓库部署

在 Workers 项目中设置：

| 设置 | 值 |
| --- | --- |
| 根目录 | `/` |
| 构建命令 | `bun run build` |
| 部署命令 | `bunx wrangler deploy` |
| 构建变量 `BUN_VERSION` | `1.4.2` |

`BUN_VERSION` 需要添加到 **设置 → 构建 → 构建变量和机密**
（Settings → Build → Build Variables and Secrets），保存后重新部署。
这是构建环境变量，不是 Worker 运行时变量，也不要放到 `wrangler.jsonc` 的 `vars` 中。
`packageManager` 用来声明项目使用的版本，Cloudflare 构建环境仍需显式设置 `BUN_VERSION`。

Cloudflare 当前默认的 Bun 1.2.15 无法读取本项目的 `bun.lock`（`lockfileVersion: 2`），
会在自动执行 `bun install --frozen-lockfile` 时出现 `Unknown lockfile version`。
依赖安装早于构建命令，因此在构建命令里升级 Bun 无法解决这个错误；应通过构建变量指定版本，保留锁文件。
参见 [Cloudflare 构建镜像文档](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

`wrangler.jsonc` 已配置自动执行 `bun run build`，也可以将网页上的构建命令留空，避免重复构建。

## 命令

| 命令 | 作用 |
| --- | --- |
| `bun run dev` | Vite 开发服务器 |
| `bun run build` | 类型检查 + 构建到 `dist/` |
| `bun run preview` | 本地跑真实 Worker 运行时 |
| `bun run deploy` | 构建并部署 |
| `bun test` | 单元测试 |
| `bun run cf-typegen` | 改过 `wrangler.jsonc` 后重新生成类型 |
