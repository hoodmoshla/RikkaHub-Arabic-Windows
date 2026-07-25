import { JsonValue, Model, Provider, ProxyMode, ProxyConfig, Assistant, Message, MessageNode, WriteStrategy, Conversation, DailyStat, StoredFile, State, GlobalMemoryFile, AssistantMemoryFile, GitHubSkillInfo, GitHubSkillFile, ApiMessage, FontWeightFile, FontEntry, ManifestEntry, BuiltinManifest, StreamHooks, AuxiliaryTextOptions } from "./foundation/types";
import type { Settings } from "./foundation/types/settings";
import { id, uniqueStrings, cloneJson, textFromParts, renderTemplate, applyPlaceholders, localeDisplayName, estimateTokens, dateKey, getStringArray, isRecord, mergeById, extensionFromMime, message, reasoningFromParts } from "./foundation/utils";
import { executableDir, rootDir, dataDir, filesDir, skillsDir, customFontsDir, statePath, globalMemoryPath, assistantMemoryPath, pendingMemoryPath, deviceIdPath } from "./foundation/paths";
import { RUNNING_IN_CONTAINER } from "./foundation/platform";
import { applyEffectiveProxy, classifyProxyError, installProxyFetchInterceptor, resolveEffectiveProxy, setActualServingPort } from "./foundation/net";
import { CONVERSATIONS_SQLITE_MIGRATION, MEMORY_FILE_SPLIT_MIGRATION, flushSaveState, saveState, setState, state, writeSlimStateJsonSync, writeSlimStateJsonSyncForMemory } from "./persistence/json-store";
import { GLOBAL_MEMORY_ID, buildMemoryPrompt, buildRecentChatsPrompt, memoryStore } from "./memory/index";
import { readZipEntries } from "./files/index";
import { APP_VERSION } from "./updates/index";
import { buildSearchContext, runScrapeWeb, runSearchWeb } from "./search/index";
import { asrRealtimeSessions, normalizeAsrProviders, sendAsrAudio, startAsrRealtimeSession, stopAsrRealtimeSession } from "./media/asr";
import { DEFAULT_SYSTEM_TTS_ID, defaultTtsProviders, normalizeTtsProviders } from "./media/tts";
import { normalizeS3Config, normalizeWebDavConfig } from "./app-config/backup-config";
import { error, json, mime } from "./api/request";
import { startAnalytics } from "./app-config/analytics";
import { bootstrap } from "./bootstrap";
import { DEFAULT_COMPRESS_PROMPT, DEFAULT_OCR_PROMPT, DEFAULT_PROMPT_OPTIMIZE_PROMPT, DEFAULT_SUGGESTION_PROMPT, DEFAULT_TITLE_PROMPT, DEFAULT_TRANSLATION_PROMPT } from "./app-config/prompts";
import { attachOcrToImageParts, compressConversation, fetchAuxiliaryText, generateTitleForConversation, markOcrPendingParts } from "./conversations/auxiliary";
import { generateAnswer, resumeApprovedToolParts } from "./conversations/orchestrator";
import { generating } from "./conversations/generation-state";
import { updateSettings } from "./app-config";
import { abortConversationGeneration, appendTextPart, canResumeToolExecution, deleteConversationsById, ensureConversation, ensureUsage, estimatePromptTokensForConversation, findAssistant, finishInterruptedPendingToolsInConversation, finishMessage, hasPendingToolApproval, hasResumableToolParts, hasToolParts, presetMessageNodes, summaryAsText, toolApprovalType } from "./conversations/helpers";
import { executeToolCall, realizeToolResult, toolResultToParts } from "./tools/execution";
import { openAiLocalTools, openAiMcpTools, openAiSearchTools, openAiSkillTools } from "./tools/bound";
import { isEmptyAssistantPlaceholder } from "./inference-engine/parts";
import { buildGoogleRequestBody, conversationMessagesForApi, conversationResponseApiInput, conversationResponseApiInstructions, templateVariables } from "./inference-engine/conversation-encoding";
import { importSkillFromBuffer, importSkillFromGitHub } from "./tools/skills-import";
import { serveAIIcon } from "./assets/icons";
import { FONT_EXTENSIONS_SET, MAX_FONT_BYTES, fontCssName, fontExtension, isBareFileName, isFontFile, listBuiltinFonts, listCustomFonts, listSystemFonts, makeBundledFontEntry, resolveFontFile } from "./assets/fonts";
import { endpointFor, fetchProviderBalance, fetchProviderModels, runProviderCheck } from "./model-providers/checks";
import { handleAuthTokenRequest, isWebAuthAuthorized, warnIfExposedWithoutAuth } from "./api/auth";
import { routeStatic } from "./api/static";
import { addLog, defaultRequestStats, normalizeRequestStats } from "./api/logs";
import { routeApi } from "./api/router";
import { broadcastConversation, broadcastList, broadcastMemoryUpdate, broadcastNodeUpdate, broadcastSettings, conversationClients, scheduleNodeBroadcast } from "./api/sse";
import {
  applyCustomBody,
  applyRequestHeaders,
  builtinProviderRank,
  DEFAULT_AUTO_MODEL_ID,
  defaultProviders,
  enrichModel,
  findModel,
  inferModelAbilities,
  jsonBody,
  model,
  modelsEndpointFor,
  NA_API_PRESET_MODELS,
  NA_API_PROVIDER_ID,
  normalizeFetchedModels,
  providerHeaders,
  providerTestCorePassed,
  providerTestModel,
  SUNSET_PROVIDER_IDS,
  textBody,
  TENCENT_PROVIDER_ID,
} from "./model-providers";
import {
  apiToolCallFromPart,
  resolvedToolOutput,
  toolExecutionErrorPayload,
} from "./tools/format";
import {
  callMcpTool,
  listSkills,
  openAiLocalTools as openAiLocalToolsCore,
  openAiMcpTools as openAiMcpToolsCore,
  openAiSearchTools as openAiSearchToolsCore,
  openAiSkillTools as openAiSkillToolsCore,
  readSkillBody,
  runAskUserTool,
  runClipboardTool,
  runGetTimeInfoTool,
  runTextToSpeechTool,
  safeSkillDir,
  safeSkillFile,
  skillMetadataFromFile,
  parseSkillFrontmatter,
} from "./tools";
import {
  apiContentFromParts,
  apiContentText,
  appendAssistantApiMessages,
  claudeCacheControlEphemeral,
  claudeMessagesFromApiMessages,
  claudeSystemContent,
  claudeThinkingPayload,
  claudeToolsFromOpenAiTools,
  dataUrlForMessageUrl,
  googleContentsFromApiMessages,
  googleFunctionDeclarations,
  googleGenerationConfig,
  GOOGLE_SAFETY_SETTINGS,
  hasBuiltInTool,
  hostOfProvider,
  isModelAllowTemperature,
  openAiChatCompletionsModalities,
  parseDataUrl,
  reasoningLevelNormalized,
  reasoningPayloadForProvider,
  auxiliaryReasoningPayloadForProvider,
  responseApiBuiltInTools,
  responseApiIncludeForProvider,
  responseApiMessagesFromUiMessages,
  responseApiReasoningForProvider,
  supportsAbility,
  supportsInputModality,
  supportsOutputModality,
} from "./inference-engine/message-builder";
import {
  addStreamImage,
  addStreamText,
  appendReasoningDelta,
  finishReasoningParts,
  replaceLoadingReasoningWithTool,
  setMessageLoading,
  streamStartedMessages,
} from "./inference-engine/parts";
import type { GenerationEvent, GenerationEventSink, StreamHooksWithSink, ToolExecutor, ToolResult } from "./inference-engine/events";
import {
  appendUsageFromRaw,
  completionMessageText,
  deltaReasoningContent,
  deltaTextContent,
  fetchClaudeAuxiliaryStream,
  fetchClaudeTextWithTools,
  fetchGoogleAuxiliaryStream,
  fetchOpenAiAuxiliaryStream,
  fetchOpenAiText,
  fetchOpenAiTextStreaming,
  fetchText,
  fillContextLimit,
  loadModelsDev,
  parseSseChunks,
  responseEventToDelta,
  streamClaudeChatWithTools,
  streamGoogleChatWithTools,
} from "./inference-engine/providers";
import {
  checkpointConversationsDb,
  deletePcConversations,
  flushConvDirtyNow,
  getConversationsDb,
  getConversation,
  loadAllConversationsFromDb,
  markConversationRowDirty,
  markMessageNodeDirty,
  migrateConversationsIntoDb,
  openConversationsDb,
  persistConversation,
  scheduleThrottledConvFlush,
  selectedConversationMessages,
} from "./conversations";
import {
  activePromptInjections as activePromptInjectionsCore,
  applyMessageTemplateToParts,
  applyOutputTransforms,
  applyPromptInjectionsToMessages,
  defaultAssistant,
  findAssistant as findAssistantCore,
  templateVariables as templateVariablesCore,
} from "./assistants";

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { installProcessSafetyNet } from "./observability/app-errors";

// 全面审查 4-2:进程级异常兜底必须最早安装,罩住后续启动期与运行期的一切
// 定时器/游离 Promise 顶层抛错(SIGINT/SIGTERM 的优雅停机在文件尾另行注册)。
installProcessSafetyNet();

// 全面审查 0-3/8-4/1-8:显式启动编排(状态装载+迁移链→代理拦截→会话运行时→SSE 接线
// →启动落盘)。必须在 resolvePreferredPort()(读 state.settings)与 Bun.serve 之前。
bootstrap();

const args = new Set(Bun.argv.slice(1));
const portIndex = Bun.argv.findIndex((arg) => arg === "--port");
const portEqualsArg = Bun.argv.find((arg) => arg.startsWith("--port="));
const portValue = portEqualsArg?.split("=")[1] ?? (portIndex >= 0 ? Bun.argv[portIndex + 1] : undefined);

if (process.platform === "linux") {
  const missing: string[] = [];
  const has = (cmd: string) => Bun.which(cmd) !== null;
  if (!has("unzip")) missing.push("unzip  (backup restore / skill import from ZIP / large DOCX streaming extract)");
  if (!has("zip")) missing.push("zip  (backup export)");
  if (!has("wl-copy") && !has("xclip")) missing.push("wl-clipboard or xclip  (clipboard tool)");
  if (!has("espeak-ng")) missing.push("espeak-ng  (system TTS)");
  if (missing.length > 0) {
    console.warn("[startup] Missing optional Linux tools — some features will not work:");
    for (const dep of missing) console.warn(`  - ${dep}`);
  }
}

// Resolve the preferred port by priority: explicit `--port` flag > `PORT` env > user setting
// > 8080. Containerized deploys skip the user setting — inside a container the port is fixed
// by the image / `docker -p` mapping, so honoring a UI change there would be misleading.
function resolvePreferredPort(): number {
  if (portValue) {
    const cli = Number(portValue);
    if (cli > 0 && cli <= 65535) return cli;
  }
  if (process.env.PORT) {
    const envPort = Number(process.env.PORT);
    if (envPort > 0 && envPort <= 65535) return envPort;
  }
  if (!RUNNING_IN_CONTAINER && state.settings.preferredPort) {
    return state.settings.preferredPort;
  }
  return 8080;
}

// 绑定地址：默认只监听 127.0.0.1，局域网内其他设备无法直接访问（服务器目前没有鉴权，
// 全网卡监听等于把全部会话与 API Key 暴露给同一网络的任何人）。容器场景必须 0.0.0.0
// 否则宿主机端口映射不通。确有局域网访问需求的用户可用 --host 0.0.0.0 或 RIKKAHUB_HOST
// 环境变量显式放开——这是有意识的选择，而不是默认暴露。
function resolveBindHostname(): string {
  const hostIndex = Bun.argv.findIndex((arg) => arg === "--host");
  const hostEqualsArg = Bun.argv.find((arg) => arg.startsWith("--host="));
  const cli = hostEqualsArg?.split("=")[1] ?? (hostIndex >= 0 ? Bun.argv[hostIndex + 1] : undefined);
  if (cli) return cli;
  if (process.env.RIKKAHUB_HOST) return process.env.RIKKAHUB_HOST;
  if (RUNNING_IN_CONTAINER) return "0.0.0.0";
  return "127.0.0.1";
}

const bindHostname = resolveBindHostname();
warnIfExposedWithoutAuth(bindHostname);

// Origin 白名单：拦截恶意网页对本机服务的跨站请求（浏览器会自动带上 Origin，
// 而 localhost 服务默认不受同源策略保护——任意网页都能 fetch http://127.0.0.1:8080）。
// 规则：
// - 无 Origin 头 → 放行（同源导航/EventSource、curl、Tauri 原生请求都不带 Origin）
// - localhost / 127.0.0.1 / ::1 / tauri.localhost / tauri: 协议 → 放行（本机 UI、Vite dev、Tauri WebView）
// - Origin 与请求 Host 完全一致 → 放行（--host 放开局域网后用 IP 访问的同源请求）
// - 其余 → 403。只保护 /api（含 WebSocket 升级），静态资源无状态不拦。
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  // 沙箱 iframe / file:// 页面发 "null"，一律拒绝
  if (origin === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol === "tauri:") return true;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "tauri.localhost") return true;
  const requestHost = request.headers.get("host");
  if (requestHost && parsed.host.toLowerCase() === requestHost.trim().toLowerCase()) return true;
  return false;
}
const preferredPort = resolvePreferredPort();
// Try the preferred port first; on EADDRINUSE walk upward. Containers don't walk — a port
// collision inside a container is unexpected, and silently hopping would hide a real problem.
const MAX_PORT_ATTEMPTS = RUNNING_IN_CONTAINER ? 1 : 20;

const { server, port } = (() => {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const tryPort = preferredPort + attempt;
    if (tryPort > 65535) break;
    try {
      return {
        server: Bun.serve({
          hostname: bindHostname,
          port: tryPort,
          idleTimeout: 0,
          // Default is 128 MB — way too small. Users have reported backup zips of 10+ GB
          // (months of conversations + image attachments). The streaming `data/import` path
          // never holds the full body in memory anyway (pipes request.body directly to disk),
          // so this just acts as a sanity-check ceiling against truly absurd uploads.
          maxRequestBodySize: 64 * 1024 * 1024 * 1024,
          async fetch(request, server) {
            server.timeout(request, 0);
            const url = new URL(request.url);
            try {
              if (url.pathname.startsWith("/api/") && !isAllowedOrigin(request)) {
                return error("Forbidden: cross-origin request blocked", 403);
              }
              // 全面审查 8-2/1-1:优雅停机端点。Windows 上 Tauri 壳 kill=TerminateProcess,
              // SIGTERM 钩子不运行——壳退出前先 POST 本端点,服务端把全部状态刷盘后才返回
              // 200,壳收到即可放心硬杀,数据零丢失。仅接受本机回环调用(先于 Web 鉴权:
              // 壳不持有 token;局域网/远程客户端被 IP 拦住,不能停别人的服务)。
              if (url.pathname === "/api/app/shutdown" && request.method === "POST") {
                const ip = server.requestIP(request)?.address ?? "";
                if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
                  return error("Forbidden: shutdown is loopback-only", 403);
                }
                await flushAllStateBeforeExit();
                // 响应发出后再停服自退;100ms 让 200 先落到壳侧。
                setTimeout(() => {
                  try { server.stop(true); } catch { /* already stopping */ }
                  process.exit(0);
                }, 100);
                return json({ ok: true });
              }
              // Web 鉴权（阶段 5.2）：仅在配置了访问密码时生效。auth/token 端点先于
              // 鉴权检查处理（它就是换 token 的入口）；其余 /api/* 一律要求有效 token。
              if (url.pathname === "/api/auth/token" && request.method === "POST") {
                return await handleAuthTokenRequest(request);
              }
              if (url.pathname.startsWith("/api/") && !isWebAuthAuthorized(request, url)) {
                return error("Unauthorized", 401);
              }
              if (url.pathname === "/api/asr/realtime" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
                const upgraded = server.upgrade(request, { data: { kind: "asr" } as any });
                return upgraded ? undefined : error("WebSocket upgrade failed", 400);
              }
              if (url.pathname.startsWith("/api/")) return await routeApi(request, url);
              return await routeStatic(url);
            } catch (err) {
              console.error(err);
              return error(err instanceof Error ? err.message : String(err), 500);
            }
          },
          websocket: {
            message(ws, data) {
              if ((ws.data as { kind?: string } | undefined)?.kind !== "asr") return;
              if (typeof data === "string") {
                const payload = JSON.parse(data || "{}") as { type?: string; providerId?: string };
                if (payload.type === "start") startAsrRealtimeSession(ws, payload.providerId);
                if (payload.type === "stop") stopAsrRealtimeSession(ws);
                return;
              }
              const session = asrRealtimeSessions.get(ws);
              if (!session) return;
              const buffer = data instanceof ArrayBuffer
                ? data
                : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
              sendAsrAudio(session, buffer);
            },
            close(ws) {
              if ((ws.data as { kind?: string } | undefined)?.kind === "asr") stopAsrRealtimeSession(ws);
            },
          },
        }),
        port: tryPort,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Non-port-conflict errors (permission denied, bad config, etc.) must not silently hop
      // to the next port — surface them and stop.
      if (!/EADDRINUSE|address already in use|in use/i.test(message)) {
        console.error(`[rikkahub-server] Failed to start on port ${tryPort}: ${message}`);
        process.exit(1);
      }
      if (attempt === 0) {
        console.warn(
          `[startup] Port ${tryPort} busy, trying alternatives up to ${Math.min(preferredPort + MAX_PORT_ATTEMPTS - 1, 65535)}...`,
        );
      }
    }
  }
  // Exhausted the whole range. Emit the single-line marker the Tauri shell parses
  // (`port_in_use:<port>`) so it shows a friendly dialog instead of hanging silently.
  const top = Math.min(preferredPort + MAX_PORT_ATTEMPTS - 1, 65535);
  console.error(`[rikkahub-server] port_in_use:${preferredPort}`);
  console.error(
    `No available port in range ${preferredPort}-${top}. Close other apps using these ports, ` +
      `or change the preferred port in 设置 → 代理与端口.`,
  );
  process.exit(2);
})();

// Machine-readable marker parsed by the Tauri shell (src-tauri/src/lib.rs) to learn which port
// the sidecar actually bound to — the shell navigates the webview here when 8080 was taken.
// Keep it a single line with the exact `RIKKAHUB_PORT:<port>` prefix.
setActualServingPort(port);
console.log(`RIKKAHUB_PORT:${port}`);

console.log(`RikkaHub PC server running at http://localhost:${port}`);
console.log(`Data directory: ${dataDir}`);
// 懒加载 models.dev 模型目录(用于 context window 显示)。fire-and-forget,失败不影响启动。
void loadModelsDev();
console.log("Press Ctrl+C to stop RikkaHub PC.");

// Start anonymous analytics (DAU tracking).  Fire-and-forget — a failed ping
// must never block or crash the server.  The endpoint resolves to a Cloudflare
// Worker that stores only an anonymous device UUID + date + version.
startAnalytics();

let shutdownStarted = false;

/** 全面审查 1-1/8-11/2-0b:关停前的完整刷盘链。信号路径与 /api/app/shutdown 端点共用,
 *  幂等(双触发只跑一次)。顺序:state.json(saveState 清节流定时器并立即起写 +
 *  flushSaveState 循环追到最后一笔尾随写)→ 活库脏行 → 生成中会话全量 reconcile(2-0b)
 *  → WAL checkpoint(TRUNCATE 把 -wal 并入主库并截断)。 */
async function flushAllStateBeforeExit(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    saveState();
    await flushSaveState();
  } catch (err) {
    console.warn("[shutdown] state.json 刷盘失败", err);
  }
  try {
    flushConvDirtyNow();
    // 全面审查 2-0b:生成中的会话再做一次全量 reconcile——流式增量 flush 只补写脏节点,
    // 结构性变更(新增节点/截断/重排)要靠 persistConversation 的"删旧节点+按序重插"
    // 才完整落盘。生成中会话通常 0~2 个,同步全量写可承受。
    for (const convId of generating.keys()) {
      const conv = getConversation(convId);
      if (conv) persistConversation(conv);
    }
    checkpointConversationsDb();
  } catch (err) {
    console.warn("[conv-db] 关停刷库失败", err);
  }
}

async function shutdown() {
  server.stop(true);
  await flushAllStateBeforeExit();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (!args.has("--dev") && !args.has("--no-open")) {
  const opener = process.platform === "win32" ? "cmd" : "sh";
  const command = process.platform === "win32"
    ? ["/c", "start", `http://localhost:${port}`]
    : ["-c", `open http://localhost:${port} || xdg-open http://localhost:${port}`];
  Bun.spawn([opener, ...command], { stdout: "ignore", stderr: "ignore" });
}

