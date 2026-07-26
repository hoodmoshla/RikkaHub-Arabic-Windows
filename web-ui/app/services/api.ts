import ky, { type Options, HTTPError } from "ky";

interface ErrorResponse {
  error: string;
  code: number;
}

interface WebAuthTokenResponse {
  token: string;
  expiresAt: number;
}

interface WebAuthRequiredEventDetail {
  message: string;
  code: number;
}

export class ApiError extends Error {
  code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

const WEB_AUTH_STORAGE_KEY = "rikkahub:web-auth";
const WEB_AUTH_REQUIRED_EVENT = "rikkahub:web-auth-required";
const WEB_AUTH_EXPIRY_SKEW_MILLIS = 10_000;
const WEB_AUTH_QUERY_KEY = "access_token";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function readStoredWebAuth(): WebAuthTokenResponse | null {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem(WEB_AUTH_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<WebAuthTokenResponse>;
    if (typeof parsed.token !== "string" || typeof parsed.expiresAt !== "number") {
      return null;
    }
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function isWebAuthExpired(expiresAt: number): boolean {
  return Date.now() >= expiresAt - WEB_AUTH_EXPIRY_SKEW_MILLIS;
}

function getValidWebAuthToken(): string | null {
  const auth = readStoredWebAuth();
  if (!auth) return null;
  if (isWebAuthExpired(auth.expiresAt)) {
    clearWebAuthToken();
    return null;
  }
  return auth.token;
}

function dispatchWebAuthRequired(detail: WebAuthRequiredEventDetail) {
  if (!isBrowser()) return;
  window.dispatchEvent(
    new CustomEvent<WebAuthRequiredEventDetail>(WEB_AUTH_REQUIRED_EVENT, { detail }),
  );
}

const kyInstance = ky.create({
  prefixUrl: "/api",
  timeout: 30000,
  hooks: {
    beforeRequest: [
      (request) => {
        const token = getValidWebAuthToken();
        if (!token || request.headers.has("Authorization")) return;
        request.headers.set("Authorization", `Bearer ${token}`);
      },
    ],
  },
});

async function handleError(error: unknown): Promise<never> {
  if (error instanceof HTTPError) {
    const { response } = error;
    let errorData: ErrorResponse | undefined;
    try {
      errorData = await response.json();
    } catch {
      // Ignore JSON parse error
    }
    const code = errorData?.code ?? response.status;
    const message = errorData?.error ?? error.message;
    const isAuthTokenEndpoint = response.url.includes("/api/auth/token");
    if (code === 401 && !isAuthTokenEndpoint) {
      clearWebAuthToken();
      dispatchWebAuthRequired({ message, code });
    }
    throw new ApiError(message, code);
  }
  throw error;
}

export function setWebAuthToken(token: string, expiresAt: number): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(WEB_AUTH_STORAGE_KEY, JSON.stringify({ token, expiresAt }));
}

export function clearWebAuthToken(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(WEB_AUTH_STORAGE_KEY);
}

/** SharedWorker 事件通道用:worker 里没有 localStorage,由页面读出 token 随 hello 传入。 */
export function getWebAuthToken(): string | null {
  return getValidWebAuthToken();
}

/** SharedWorker 事件通道用:worker 收到 401 时由页面代为清 token 并触发密码闸门事件。 */
export function notifyWebAuthRequired(detail: WebAuthRequiredEventDetail): void {
  clearWebAuthToken();
  dispatchWebAuthRequired(detail);
}

export function onWebAuthRequired(
  listener: (detail: WebAuthRequiredEventDetail) => void,
): () => void {
  if (!isBrowser()) return () => {};

  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<WebAuthRequiredEventDetail>;
    listener(customEvent.detail);
  };
  window.addEventListener(WEB_AUTH_REQUIRED_EVENT, handler);

  return () => {
    window.removeEventListener(WEB_AUTH_REQUIRED_EVENT, handler);
  };
}

export function appendWebAuthQuery(url: string): string {
  if (!isBrowser() || !url.startsWith("/api/")) return url;

  const token = getValidWebAuthToken();
  if (!token) return url;

  const [pathWithQuery, hash = ""] = url.split("#", 2);
  const separator = pathWithQuery.includes("?") ? "&" : "?";
  const encodedToken = encodeURIComponent(token);
  const nextPath = `${pathWithQuery}${separator}${WEB_AUTH_QUERY_KEY}=${encodedToken}`;
  return hash ? `${nextPath}#${hash}` : nextPath;
}

/**
 * API client with unwrapped response data
 */
const api = {
  async get<T>(url: string, options?: Options): Promise<T> {
    try {
      return await kyInstance.get(url, options).json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
  async post<T>(url: string, data?: unknown, options?: Options): Promise<T> {
    try {
      return await kyInstance
        .post(url, data === undefined ? options : { ...options, json: data })
        .json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
  async postMultipart<T>(url: string, formData: FormData, options?: Options): Promise<T> {
    try {
      return await kyInstance.post(url, { ...options, body: formData }).json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
  async postBlob(url: string, data?: unknown, options?: Options): Promise<Response> {
    try {
      return await kyInstance.post(url, data === undefined ? options : { ...options, json: data });
    } catch (error) {
      return handleError(error);
    }
  },
  async put<T>(url: string, data?: unknown, options?: Options): Promise<T> {
    try {
      return await kyInstance
        .put(url, data === undefined ? options : { ...options, json: data })
        .json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
  async patch<T>(url: string, data?: unknown, options?: Options): Promise<T> {
    try {
      return await kyInstance
        .patch(url, data === undefined ? options : { ...options, json: data })
        .json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
  async delete<T>(url: string, options?: Options): Promise<T> {
    try {
      return await kyInstance.delete(url, options).json<T>();
    } catch (error) {
      return handleError(error);
    }
  },
};

export async function requestWebAuthToken(password: string): Promise<WebAuthTokenResponse> {
  const response = await api.post<WebAuthTokenResponse>("auth/token", { password });
  setWebAuthToken(response.token, response.expiresAt);
  return response;
}

export interface SSEEvent<T> {
  event: string;
  data: T;
  id?: string;
}

export interface SSECallbacks<T> {
  onMessage: (event: SSEEvent<T>) => void;
  /** 每次连接尝试失败时触发（自动重连模式下可能多次）。 */
  onError?: (error: Error) => void;
  /** 每次连接（含重连）成功时触发。后端所有流在连接时都会推初始快照/invalidate，重连即自动补齐断线期间的状态。 */
  onOpen?: () => void;
  /** 订阅彻底结束（abort、关闭重连或遇不可自愈错误）时触发一次。 */
  onClose?: () => void;
}

export interface SSEOptions extends Options {
  signal?: AbortSignal;
  /** 断线自动重连（指数退避 1s→30s，收到任何消息即重置计数）。默认开启；一次性流可显式关闭。 */
  reconnect?: boolean;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Create an SSE connection using ky (supports auth headers).
 *
 * 内建断线重连（N-8）：网络抖动或后端重启后按指数退避自动重连，四路长订阅
 * （settings/会话列表/会话详情/memory）统一受益，无需各自实现。由于后端每条流
 * 在连接时都主动推送初始快照，重连本身即完成状态补偿。不可自愈的 4xx
 * （401 由密码闸门接管整页 reload；404 资源已删除等）停止重连。
 */
async function sse<T>(
  url: string,
  callbacks: SSECallbacks<T>,
  options?: SSEOptions,
): Promise<void> {
  const { reconnect = true, ...requestOptions } = options ?? {};
  const signal = requestOptions.signal;
  let attempt = 0;

  /** 单次连接：返回 "retry"（可重连）或 "fatal"（终止订阅）。 */
  const connectOnce = async (): Promise<"retry" | "fatal"> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const response = await kyInstance.get(url, {
        ...requestOptions,
        headers: {
          ...requestOptions.headers,
          Accept: "text/event-stream",
        },
        timeout: false,
      });

      callbacks.onOpen?.();

      reader = response.body?.getReader();
      if (!reader) {
        throw new ApiError("Response body is not readable", 0);
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "message";
      let currentData = "";
      let currentId: string | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmedLine = line.replace(/\r$/, "");
          if (trimmedLine.startsWith("event:")) {
            currentEvent = trimmedLine.slice(6).trim();
          } else if (trimmedLine.startsWith("data:")) {
            // SSE 规范:data: 后只剥一个前导空格;整行 trim 会让多行 data 的空白失真
            const dataValue = trimmedLine.slice(5);
            currentData += (currentData ? "\n" : "") + (dataValue.startsWith(" ") ? dataValue.slice(1) : dataValue);
          } else if (trimmedLine.startsWith("id:")) {
            currentId = trimmedLine.slice(3).trim();
          } else if (trimmedLine === "") {
            if (currentData) {
              try {
                const data = JSON.parse(currentData) as T;
                attempt = 0;
                callbacks.onMessage({ event: currentEvent, data, id: currentId });
              } catch {
                // Ignore JSON parse error
              }
            }
            currentEvent = "message";
            currentData = "";
            currentId = undefined;
          }
        }
      }
      // 服务端正常关闭流（如后端重启）→ 可重连
      return "retry";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return "fatal";
      }
      try {
        await handleError(error);
      } catch (handledError) {
        callbacks.onError?.(
          handledError instanceof Error ? handledError : new Error(String(handledError)),
        );
        // 4xx 客户端错误重试不会自愈（408/429 除外）：401 已触发解锁闸门（解锁后整页
        // reload），404 表示订阅目标已不存在，继续重连只是空转。
        if (
          handledError instanceof ApiError &&
          handledError.code >= 400 &&
          handledError.code < 500 &&
          handledError.code !== 408 &&
          handledError.code !== 429
        ) {
          return "fatal";
        }
      }
      return "retry";
    } finally {
      reader?.releaseLock();
    }
  };

  try {
    while (true) {
      const outcome = await connectOnce();
      if (signal?.aborted || outcome === "fatal" || !reconnect) return;
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      attempt += 1;
      await abortableDelay(delay, signal);
      if (signal?.aborted) return;
    }
  } finally {
    callbacks.onClose?.();
  }
}

export { sse };
export default api;
