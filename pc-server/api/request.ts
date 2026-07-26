// api/request.ts — HTTP 请求/响应辅助（json/error/readJson/mime）
// 纪律：纯辅助函数，不依赖业务状态。

import type { JsonValue } from "../foundation/types";

export function json(data: JsonValue | object, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function error(message: string, status = 400) {
  return json({ error: message, code: status }, { status });
}

/** 4-6:非空但不可解析的 body 抛出,routeApi 统一映射 400。此前静默返回 {},
 *  坏 body 让写端点拿默认值继续执行(如 s3/delete 收到坏 JSON 会当 fileName 为空)。 */
export class JsonBodyError extends Error {}

export async function readJson<T>(request: Request): Promise<T> {
  if (request.headers.get("content-length") === "0") return {} as T;
  const text = await request.text();
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new JsonBodyError("Malformed JSON body");
  }
}

export function mime(path: string) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}
