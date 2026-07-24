// api/static.ts — 内嵌 web-ui 静态文件服务（SPA fallback 与缓存策略）
// 纪律：只负责静态资源定位与 Cache-Control；API 路由在 server.ts / api/handlers。

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { executableDir, rootDir } from "../foundation/paths";
import { mime } from "./request";

export async function routeStatic(url: URL) {
  const candidates = [
    resolve(executableDir, "web-ui", "build", "client"),
    resolve(executableDir, "web-ui", "build"),
    resolve(rootDir, "web-ui", "build", "client"),
    resolve(rootDir, "web-ui", "build"),
    resolve(rootDir, "web-ui", "dist"),
  ];
  const staticRoot = candidates.find((candidate) => existsSync(join(candidate, "index.html")));
  if (!staticRoot) {
    return new Response("web-ui is not built. Run `cd web-ui && bun install && bun run build`.", { status: 200 });
  }
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const target = resolve(staticRoot, requested);
  if (target.startsWith(staticRoot) && existsSync(target)) {
    return new Response(Bun.file(target), {
      headers: { "Content-Type": mime(target), "Cache-Control": staticCacheControl(url.pathname, target) },
    });
  }
  // SPA fallback (index.html): 绝不缓存。覆盖安装后 WebView2 每次都拿最新的 index.html,
  // 它引用的 hash 化 css/js 会自然跟到新版本,彻底杜绝"装了新版还在跑旧前端"的缓存污染。
  return new Response(Bun.file(join(staticRoot, "index.html")), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// 静态资源 Cache-Control 策略,解决覆盖安装时 WebView2 缓存旧前端的问题:
//   index.html → no-store:唯一被直接请求的"无 hash"入口,只要它最新,引用的
//               /assets/*.<hash>.css|js 会自动指向新版本。
//   /assets/* → immutable + 1 年:Vite 按内容 hash 命名,内容变则文件名变,可安全永久缓存。
//   其余(favicon 等,无 hash)→ 1 小时短缓存兜底。
function staticCacheControl(pathname: string, target: string): string {
  if (target.endsWith("index.html") || pathname === "/") return "no-store";
  if (pathname.startsWith("/assets/") && /\.(css|js|mjs|woff2?|ttf|otf|wasm)$/i.test(target)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}
