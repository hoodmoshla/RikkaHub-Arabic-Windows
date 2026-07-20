// tools/mcp.ts — MCP 客户端实现
// 纪律：负责 MCP SSE/streamable_http 会话、tools/list 同步、tools/call 调用；
//       不直接读写 state，日志与 mcpServers 通过参数注入。

import { id, isRecord } from "../foundation/utils";
import { jsonBody, textBody } from "../model-providers";
import type { Assistant, JsonValue, RequestLog } from "../foundation/types";
import { getStringArray } from "../foundation/utils";
import { isMcpToolEnabledForAssistant } from "./approval";

export type McpLogCallback = (log: RequestLog) => void;

function headersFromMcpServer(server: Record<string, JsonValue>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  const rawHeaders = Array.isArray(common.headers) ? common.headers : [];
  for (const header of rawHeaders) {
    if (Array.isArray(header)) {
      const [key, value] = header;
      if (key) headers[String(key)] = String(value ?? "");
    } else if (isRecord(header)) {
      const key = String(header.key ?? header.name ?? header.first ?? "").trim();
      const value = String(header.value ?? header.second ?? "");
      if (key) headers[key] = value;
    }
  }
  return headers;
}

function parseMcpResponseText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const dataLines = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, "").trim())
      .filter((line) => line && line !== "[DONE]");
    for (const line of dataLines.reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue scanning older SSE data frames.
      }
    }
    return { text };
  }
}

function resolveMcpSseEndpoint(baseUrl: string, endpoint: string) {
  const trimmed = endpoint.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return new URL(trimmed, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

const mcpSessionCache = new Map<string, { sessionId: string; protocolVersion?: string }>();
const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function mcpSessionCacheKey(server: Record<string, JsonValue>) {
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  const headers = Array.isArray(common.headers) ? common.headers : [];
  return JSON.stringify({
    id: String(server.id ?? ""),
    type: String(server.type ?? "streamable_http"),
    url: String(server.url ?? ""),
    headers,
  });
}

async function readMcpSseUntilEndpoint(response: Response, timeoutMs = 15000) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE MCP response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const started = Date.now();
  try {
    for (;;) {
      if (Date.now() - started > timeoutMs) throw new Error("SSE MCP endpoint event timeout");
      const read = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
          setTimeout(() => reject(new Error("SSE MCP endpoint event timeout")), 1000),
        ),
      ]);
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const events = buffer.split(/\n\n+/);
      buffer = events.pop() ?? "";
      for (const eventBlock of events) {
        const eventName = eventBlock.split(/\r?\n/).find((line) => line.startsWith("event:"))?.replace(/^event:\s*/, "").trim() ?? "";
        const data = eventBlock
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.replace(/^data:\s?/, ""))
          .join("\n")
          .trim();
        if (eventName === "endpoint" && data) return data;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors from the long-lived SSE stream.
    }
  }
  throw new Error("SSE MCP endpoint event was not received");
}

async function mcpSsePostEndpoint(server: Record<string, JsonValue>, log?: McpLogCallback) {
  const cached = String(server.ssePostEndpoint ?? "").trim();
  if (cached) return cached;
  const target = String(server.url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("MCP SSE server URL must be http(s)");
  const started = Date.now();
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(target, { headers: headersFromMcpServer(server), signal: ac.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    throw new Error(aborted ? "MCP SSE handshake timed out after 30s" : err instanceof Error ? err.message : String(err));
  }
  clearTimeout(timeoutId);
  const endpoint = resolveMcpSseEndpoint(target, await readMcpSseUntilEndpoint(response));
  log?.({
    id: id(),
    at: Date.now(),
    providerId: String(server.id ?? "mcp"),
    providerName: String(isRecord(server.commonOptions) ? server.commonOptions.name ?? "MCP Server" : "MCP Server"),
    url: target,
    ok: true,
    status: response.status,
    kind: "mcp:sse:endpoint",
    durationMs: Date.now() - started,
    responseBody: endpoint,
    toolName: "endpoint",
  });
  server.ssePostEndpoint = endpoint;
  return endpoint;
}

async function postMcpJsonRpc(
  server: Record<string, JsonValue>,
  method: string,
  params: Record<string, JsonValue> | undefined,
  extraHeaders: Record<string, string> = {},
  options: { notification?: boolean } = {},
  log?: McpLogCallback,
) {
  const target = String(server.type ?? "streamable_http") === "sse"
    ? await mcpSsePostEndpoint(server, log)
    : String(server.url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("MCP server URL must be http(s)");
  const body = options.notification
    ? { jsonrpc: "2.0", method, params: params ?? {} }
    : { jsonrpc: "2.0", id: id(), method, params: params ?? {} };
  const started = Date.now();
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), 30_000);
  let response: Response;
  let text: string;
  const requestHeaders = { ...headersFromMcpServer(server), ...extraHeaders };
  try {
    response = await fetch(target, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    text = await response.text();
  } catch (err) {
    clearTimeout(timeoutId);
    const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    const reason = aborted ? "MCP request timed out after 30s" : err instanceof Error ? err.message : String(err);
    log?.({
      id: id(),
      at: Date.now(),
      providerId: String(server.id ?? "mcp"),
      providerName: String(isRecord(server.commonOptions) ? server.commonOptions.name ?? "MCP Server" : "MCP Server"),
      url: target,
      ok: false,
      status: 0,
      kind: `mcp:${method}`,
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders,
      requestBody: jsonBody(body),
      responseBody: "",
      toolName: method,
      error: reason,
    });
    throw new Error(reason);
  }
  clearTimeout(timeoutId);
  const raw: any = parseMcpResponseText(text);
  log?.({
    id: id(),
    at: Date.now(),
    providerId: String(server.id ?? "mcp"),
    providerName: String(isRecord(server.commonOptions) ? server.commonOptions.name ?? "MCP Server" : "MCP Server"),
    url: target,
    ok: response.ok && !raw.error,
    status: response.status,
    kind: `mcp:${method}`,
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: textBody(text),
    toolName: method,
    error: response.ok && !raw.error ? undefined : jsonBody(raw.error ?? text),
  });
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
  if (raw.error) throw new Error(jsonBody(raw.error, 500));
  return {
    result: raw.result ?? raw,
    sessionId: response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id") ?? undefined,
    protocolVersion: typeof raw.result?.protocolVersion === "string" ? raw.result.protocolVersion : undefined,
  };
}

async function mcpSessionHeaders(server: Record<string, JsonValue>, log?: McpLogCallback) {
  const cacheKey = mcpSessionCacheKey(server);
  const cached = mcpSessionCache.get(cacheKey);
  if (cached?.sessionId) {
    return {
      "mcp-session-id": cached.sessionId,
      ...(cached.protocolVersion ? { "mcp-protocol-version": cached.protocolVersion } : {}),
    };
  }
  let init: Awaited<ReturnType<typeof postMcpJsonRpc>> | null = null;
  let lastError: unknown = null;
  for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
    try {
      init = await postMcpJsonRpc(server, "initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "RikkaHub PC", version: "pc-dev" },
      }, {}, {}, log);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!init) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "MCP initialize failed"));
  }
  if (init.sessionId) mcpSessionCache.set(cacheKey, { sessionId: init.sessionId, protocolVersion: init.protocolVersion });
  const headers = init.sessionId
    ? {
      "mcp-session-id": init.sessionId,
      ...(init.protocolVersion ? { "mcp-protocol-version": init.protocolVersion } : {}),
    }
    : {};
  await postMcpJsonRpc(server, "notifications/initialized", {}, headers, { notification: true }, log);
  return headers;
}

export async function mcpJsonRpc(
  server: Record<string, JsonValue>,
  method: string,
  params?: Record<string, JsonValue>,
  log?: McpLogCallback,
) {
  const cacheKey = mcpSessionCacheKey(server);
  const headers = await mcpSessionHeaders(server, log);
  try {
    const response = await postMcpJsonRpc(server, method, params, headers, {}, log);
    return response.result;
  } catch (err) {
    if (!mcpSessionCache.has(cacheKey)) throw err;
    mcpSessionCache.delete(cacheKey);
    const retryHeaders = await mcpSessionHeaders(server, log);
    const response = await postMcpJsonRpc(server, method, params, retryHeaders, {}, log);
    return response.result;
  }
}

export async function fetchMcpTools(server: Record<string, JsonValue>, log?: McpLogCallback) {
  const result = await mcpJsonRpc(server, "tools/list", undefined, log);
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return tools.map((tool: any) => ({
    enable: true,
    name: String(tool.name ?? ""),
    description: tool.description ? String(tool.description) : null,
    inputSchema: tool.inputSchema ?? tool.input_schema ?? { type: "object", properties: {} },
    needsApproval: tool.needsApproval === true,
  })).filter((tool) => tool.name);
}

export async function syncMcpServerTools(server: Record<string, JsonValue>, log?: McpLogCallback) {
  const common = isRecord(server.commonOptions) ? server.commonOptions : {};
  const existingTools = Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
  const prefs = new Map<string, { enable: boolean; needsApproval: boolean }>();
  for (const t of existingTools) {
    const n = String(t.name ?? "");
    if (!n) continue;
    prefs.set(n, {
      enable: t.enable !== false,
      needsApproval: t.needsApproval === true,
    });
  }
  try {
    const fetched = await fetchMcpTools(server, log);
    const tools = fetched.map((tool) => {
      const pref = prefs.get(tool.name);
      return pref ? { ...tool, enable: pref.enable, needsApproval: pref.needsApproval } : tool;
    });
    return {
      ...server,
      commonOptions: {
        ...common,
        tools,
        lastSyncAt: Date.now(),
        lastSyncError: "",
        connected: true,
      },
    };
  } catch (err) {
    return {
      ...server,
      commonOptions: {
        ...common,
        lastSyncAt: Date.now(),
        lastSyncError: err instanceof Error ? err.message : String(err),
        connected: false,
      },
    };
  }
}

export async function callMcpTool(
  assistant: Assistant,
  toolName: string,
  args: Record<string, JsonValue>,
  mcpServers: JsonValue[],
  log?: McpLogCallback,
) {
  const selected = new Set(getStringArray(assistant.mcpServers));
  const servers = (mcpServers as Array<Record<string, JsonValue>>)
    .filter((server) => selected.has(String(server.id ?? "")) && isRecord(server.commonOptions) && server.commonOptions.enable !== false);
  for (const server of servers) {
    const common = server.commonOptions as Record<string, JsonValue>;
    const tools = Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
    const matched = tools.find((tool) =>
      isMcpToolEnabledForAssistant(assistant, String(server.id ?? ""), tool)
      && `mcp__${String(tool.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")}` === toolName,
    );
    if (!matched) continue;
    const result = await mcpJsonRpc(server, "tools/call", { name: String(matched.name), arguments: args }, log);
    return result;
  }
  throw new Error(`MCP tool '${toolName}' is not available for this assistant`);
}
