// api/auth.ts — Web 访问鉴权（阶段 5.2，解决 N-1 容器/局域网零鉴权）
//
// 启用条件：显式配置了访问密码（--password 或 RIKKAHUB_PASSWORD）。未配置时完全旁路，
// 桌面本机形态（127.0.0.1 + Origin 白名单）行为不变。容器/局域网部署配上密码后，
// 所有 /api/* 请求必须携带有效 token（Authorization: Bearer 或 access_token query——
// 后者供 <img>/<audio>/WebSocket 等无法设 header 的场景使用）。
//
// 契约对齐前端既有脚手架（web-ui/app/services/api.ts）：
//   POST /api/auth/token  body {password}  →  200 {token, expiresAt(epoch ms)} / 401 {error, code}
//   任意 /api/* 返回 401 时前端清 token 并弹出密码闸门（rikkahub:web-auth-required）。
//
// token 设计：HMAC-SHA256 无状态签名（v1.<过期毫秒>.<hmac hex>），密钥从密码派生。
// 无需服务端存储，重启依旧有效；改密码即令所有旧 token 失效。

import { createHmac, timingSafeEqual } from "node:crypto";
import { error, json, readJson } from "./request";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天，前端 localStorage 按 expiresAt 自行过期
const TOKEN_PREFIX = "v1";

function resolveWebPassword(): string | null {
  const eqArg = Bun.argv.find((arg) => arg.startsWith("--password="));
  if (eqArg) return eqArg.slice("--password=".length) || null;
  const flagIndex = Bun.argv.findIndex((arg) => arg === "--password");
  if (flagIndex >= 0 && Bun.argv[flagIndex + 1]) return Bun.argv[flagIndex + 1];
  return process.env.RIKKAHUB_PASSWORD || null;
}

const webPassword = resolveWebPassword();

export function webAuthEnabled(): boolean {
  return webPassword != null;
}

// 密钥从密码派生而非直接使用密码，避免把原文当 HMAC key 的习惯性风险，
// 同时让"改密码 → 全部旧 token 失效"成为天然属性。
function signingKey(): Buffer {
  return createHmac("sha256", "rikkahub-web-auth-v1").update(webPassword ?? "").digest();
}

function signPayload(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("hex");
}

function issueToken(): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${TOKEN_PREFIX}.${expiresAt}`;
  return { token: `${payload}.${signPayload(payload)}`, expiresAt };
}

function verifyToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return false;
  const expected = signPayload(`${parts[0]}.${parts[1]}`);
  const given = parts[2];
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

// 暴力破解节流：60 秒窗口内 5 次失败后拒绝（429），窗口滑动重置。
// 全局而非按 IP——本服务常部署在反代/容器后，remote address 不可靠；
// 全局限速对单用户自用场景无感，对脚本爆破足够致命（约 7,200 次/天）。
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 5;
let failureWindowStart = 0;
let failureCount = 0;

function registerFailure(): void {
  const now = Date.now();
  if (now - failureWindowStart > FAILURE_WINDOW_MS) {
    failureWindowStart = now;
    failureCount = 0;
  }
  failureCount += 1;
}

function throttled(): boolean {
  return Date.now() - failureWindowStart <= FAILURE_WINDOW_MS && failureCount >= MAX_FAILURES_PER_WINDOW;
}

function passwordMatches(given: string): boolean {
  const expected = Buffer.from(webPassword ?? "", "utf8");
  const actual = Buffer.from(given, "utf8");
  if (expected.length !== actual.length) return false;
  try {
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** POST /api/auth/token 处理器。未启用鉴权时也响应（明确告知无需密码），便于前端探测。 */
export async function handleAuthTokenRequest(request: Request): Promise<Response> {
  if (!webAuthEnabled()) {
    return error("Web authentication is not enabled on this server", 400);
  }
  if (throttled()) {
    return error("Too many failed attempts, try again later", 429);
  }
  const body = await readJson<{ password?: unknown }>(request);
  const given = typeof body.password === "string" ? body.password : "";
  if (!given || !passwordMatches(given)) {
    registerFailure();
    // 恒定延迟：拉平正确/错误路径的响应时间差，同时给爆破脚本加成本。
    await new Promise((resolve) => setTimeout(resolve, 250));
    return error("Invalid password", 401);
  }
  return json(issueToken());
}

/** /api/* 请求的鉴权检查。未启用时恒 true；auth/token 端点本身放行。 */
export function isWebAuthAuthorized(request: Request, url: URL): boolean {
  if (!webAuthEnabled()) return true;
  if (url.pathname === "/api/auth/token") return true;
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ") && verifyToken(authHeader.slice(7).trim())) return true;
  const queryToken = url.searchParams.get("access_token");
  if (queryToken && verifyToken(queryToken)) return true;
  return false;
}

/** 启动时提示：绑定了非回环地址却没配密码 → 全部数据对同网络裸奔，必须让用户知道。 */
export function warnIfExposedWithoutAuth(bindHostname: string): void {
  const loopback = bindHostname === "127.0.0.1" || bindHostname === "localhost" || bindHostname === "::1";
  if (loopback || webAuthEnabled()) return;
  console.warn(
    "[security] 服务绑定在 " + bindHostname + " 且未设置访问密码：同一网络内任何设备都能读取全部会话与 API Key。" +
    "强烈建议通过 --password <密码> 或环境变量 RIKKAHUB_PASSWORD 启用访问鉴权。",
  );
}
