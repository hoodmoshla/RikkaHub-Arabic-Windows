import { JsonValue, Model, Provider, ProxyMode, ProxyConfig, Assistant, Message, MessageNode, WriteStrategy, Conversation, DailyStat, StoredFile, State, GlobalMemoryFile, AssistantMemoryFile, GitHubSkillInfo, GitHubSkillFile, ApiMessage, FontWeightFile, FontEntry, ManifestEntry, BuiltinManifest, StreamHooks, AuxiliaryTextOptions } from "./foundation/types";
import type { Settings } from "./foundation/types/settings";
import { id, uniqueStrings, cloneJson, textFromParts, renderTemplate, applyPlaceholders, localeDisplayName, estimateTokens, dateKey, getStringArray, isRecord, mergeById, extensionFromMime, message, reasoningFromParts } from "./foundation/utils";
import { executableDir, rootDir, dataDir, filesDir, skillsDir, customFontsDir, statePath, globalMemoryPath, assistantMemoryPath, pendingMemoryPath, deviceIdPath } from "./foundation/paths";
import { RUNNING_IN_CONTAINER } from "./foundation/platform";
import { applyEffectiveProxy, classifyProxyError, installProxyFetchInterceptor, resolveEffectiveProxy, setActualServingPort } from "./foundation/net";
import { CONVERSATIONS_SQLITE_MIGRATION, MEMORY_FILE_SPLIT_MIGRATION, saveState, setState, state, writeSlimStateJsonSync, writeSlimStateJsonSyncForMemory } from "./persistence/json-store";
import { GLOBAL_MEMORY_ID, buildMemoryPrompt, buildRecentChatsPrompt, memoryStore } from "./memory/index";
import { readZipEntries } from "./files/index";
import { APP_VERSION } from "./updates/index";
import { buildSearchContext, runScrapeWeb, runSearchWeb } from "./search/index";
import { asrRealtimeSessions, normalizeAsrProviders, sendAsrAudio, startAsrRealtimeSession, stopAsrRealtimeSession } from "./media/asr";
import { DEFAULT_SYSTEM_TTS_ID, defaultTtsProviders, normalizeTtsProviders } from "./media/tts";
import { normalizeS3Config, normalizeWebDavConfig } from "./backup/storage";
import { error, mime } from "./api/request";
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

const DEFAULT_LEARNING_MODE_ID = "b87eaf16-f5cd-4ac1-9e4f-b11ae3a61d74";
// 一次性下架的预置 TTS 供应商。留在 server.ts 是因为 normalizeState 仍需要它;
// 等 media/ 模块拆分后再迁走。
const SUNSET_TTS_PROVIDER_IDS = new Set<string>([
  "e36b22ef-ca82-40ab-9e70-60cad861911c", // AiHubMix (TTS)
]);
// Mirrors `MemoryRepository.kt:11` in the original RikkaHub project. Keeping the literal
// value identical means a `state.json` produced on one platform can be imported on the
// other without losing the global-scope memory records.
// ── Analytics (anonymous DAU tracking) ────────────────────────────────────
// One ping per app start + periodic updates during the session.  Sends only:
//   device UUID, date, version, OS, cumulative message count for the day.
// No user content, no IP storage, no model names, no file names.
//
// 设计准则:
//   - 完全静默:无网络/DNS 失败/防火墙拦截都不能让用户看到任何报错
//   - 不阻塞:fetch 出错只能被 Promise 链吞掉,绝不能冒泡成 UnhandledRejection
//   - 不持久错误状态:连续失败不退避、不停跳,因为我们根本不关心是否送达
const ANALYTICS_ENDPOINT = "https://rikkahub-desktop.pages.dev/ping";
let analyticsDeviceId = "";
let analyticsMsgCount = 0;
// 3.5c-4: 会话路由迁至 api/handlers/conversations.ts 后，经此函数递增计数（let 变量无法跨模块赋值）。
export function bumpAnalyticsMsgCount() { analyticsMsgCount++; }

function readOrCreateDeviceId(): string {
  try { return readFileSync(deviceIdPath, "utf-8").trim(); } catch { /* not found */ }
  const id = crypto.randomUUID();
  try { writeFileSync(deviceIdPath, id); } catch { /* best-effort */ }
  return id;
}

function localDateStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function analyticsOs(): string {
  // 区分 win / mac / linux —— Docker 容器内 process.platform === "linux",
  // 算 Linux 用户,合理(Docker 镜像也是基于 Linux 二进制)。
  if (process.platform === "darwin") return "mac";
  if (process.platform === "linux") return "linux";
  return "win";
}

function sendAnalyticsPing(): void {
  if (!analyticsDeviceId) return;
  const url = `${ANALYTICS_ENDPOINT}?id=${encodeURIComponent(analyticsDeviceId)}`
    + `&d=${localDateStr()}`
    + `&v=${encodeURIComponent(APP_VERSION)}`
    + `&os=${analyticsOs()}`
    + `&mc=${analyticsMsgCount}`;
  // 三重静默防御:
  //   (1) try/catch 包裹同步部分,防 fetch() 同步抛错(比如 URL 不合法)
  //   (2) AbortSignal.timeout 限制网络等待,DNS 失败/连接超时都会被吞
  //   (3) .then/.catch 双 noop 确保 promise 既不打印未捕获 reject,也不让
  //       响应体引起任何后续处理
  try {
    fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) })
      .then(() => {}, () => {});
  } catch { /* fire-and-forget — never block, never warn */ }
}

function startAnalytics(): void {
  // 同步部分(读 device-id、设置 interval)绝不可能抛错;唯一可能的失败点是
  // fetch,已在 sendAnalyticsPing 内部隔离。这里整体再加一层 try/catch 兜底,
  // 防御未来代码改动时引入意外异常 —— analytics 永远不应该让 server 启动失败。
  try {
    analyticsDeviceId = readOrCreateDeviceId();
    const today = localDateStr();
    let lastDate = today;
    sendAnalyticsPing(); // startup ping
    setInterval(() => {
      const now = localDateStr();
      if (now !== lastDate) { analyticsMsgCount = 0; lastDate = now; }
      sendAnalyticsPing();
    }, 10 * 60 * 1000); // every 10 minutes
  } catch { /* analytics must never break the app */ }
}

export function defaultSettings(): Settings {
  const assistant = defaultAssistant();
  return {
    dynamicColor: true,
    themeId: "default",
    developerMode: false,
    displaySetting: {
      userAvatar: { type: "dummy" },
      userNickname: "",
      showUserAvatar: true,
      showAssistantBubble: false,
      showModelIcon: true,
      showModelName: true,
      showTokenUsage: true,
      showThinkingContent: true,
      uiFontFamily: "Noto Sans SC",
      chatFontFamily: "",
      uiFontFamilyCss: "\"Noto Sans SC\", \"Microsoft YaHei\", sans-serif",
      chatFontFamilyCss: "",
      autoCloseThinking: true,
      codeBlockAutoWrap: false,
      codeBlockAutoCollapse: false,
      showLineNumbers: false,
      sendOnEnter: false,
      enableAutoScroll: true,
      fontSizeRatio: 1,
      // 界面字号缩放(建议 0.85–1.20)。null = 不缩放,根字号保持浏览器默认 16px。PC-only,
      // 已在 pcOnlyDisplayFields 清单里,导出备份时剥离,Android 不可见。
      uiFontSize: null,
      pasteLongTextAsFile: false,
      pasteLongTextThreshold: 1000,
      // User-resizable chat input height in px (null = default min). Persisted across
      // restarts via displaySetting. PC-only — stripped before syncing to Android.
      chatInputHeight: null,
    },
    enableWebSearch: false,
    favoriteModels: [],
    chatModelId: DEFAULT_AUTO_MODEL_ID,
    titleModelId: DEFAULT_AUTO_MODEL_ID,
    translateModeId: DEFAULT_AUTO_MODEL_ID,
    translateThinkingBudget: 0,
    suggestionModelId: DEFAULT_AUTO_MODEL_ID,
    imageGenerationModelId: "",
    ocrModelId: "",
    compressModelId: DEFAULT_AUTO_MODEL_ID,
    promptOptimizeModelId: "",
    promptOptimizePrompt: DEFAULT_PROMPT_OPTIMIZE_PROMPT,
    titlePrompt: DEFAULT_TITLE_PROMPT,
    translatePrompt: DEFAULT_TRANSLATION_PROMPT,
    suggestionPrompt: DEFAULT_SUGGESTION_PROMPT,
    ocrPrompt: DEFAULT_OCR_PROMPT,
    compressPrompt: DEFAULT_COMPRESS_PROMPT,
    asrProviders: [],
    selectedASRProviderId: null,
    ttsProviders: defaultTtsProviders(),
    selectedTTSProviderId: DEFAULT_SYSTEM_TTS_ID,
    assistantId: assistant.id,
    providers: defaultProviders(),
    assistants: [
      assistant,
      {
        ...defaultAssistant(),
        id: "3d47790c-c415-4b90-9388-751128adb0a0",
        systemPrompt:
          "You are a helpful assistant, called {{char}}, based on model {{model_name}}.\n\n## Info\n- Time: {{cur_datetime}}\n- Locale: {{locale}}\n- Timezone: {{timezone}}\n- Device Info: {{device_info}}\n- System Version: {{system_version}}\n- User Nickname: {{user}}\n\n## Hint\n- If the user does not specify a language, reply in the user's primary language.\n- Remember to use Markdown syntax for formatting, and use latex for mathematical expressions.\n\n## Search\n- You must use English keywords when searching to get higher quality sources.\n- Chinese sources are generally of low quality.",
      },
    ],
    assistantTags: [],
    searchServices: [
      { type: "bing_local", id: id(), name: "Bing" },
      { type: "rikkahub", id: id(), name: "RikkaHub", apiKey: "", depth: "standard" },
      { type: "tavily", id: id(), name: "Tavily", apiKey: "", depth: "advanced" },
      { type: "exa", id: id(), name: "Exa", apiKey: "" },
      { type: "zhipu", id: id(), name: "智谱", apiKey: "" },
      { type: "tinyfish", id: id(), name: "Tinyfish", apiKey: "" },
      { type: "perplexity", id: id(), name: "Perplexity", apiKey: "" },
      { type: "bocha", id: id(), name: "博查", apiKey: "" },
      { type: "linkup", id: id(), name: "LinkUp", apiKey: "", depth: "standard" },
      { type: "metaso", id: id(), name: "秘塔", apiKey: "" },
      { type: "ollama", id: id(), name: "Ollama", apiKey: "" },
      { type: "jina", id: id(), name: "Jina", apiKey: "" },
      { type: "firecrawl", id: id(), name: "Firecrawl", apiKey: "" },
      { type: "grok", id: id(), name: "Grok", apiKey: "", customUrl: "https://api.x.ai/v1/responses", model: "grok-4-fast" },
    ],
    searchCommonOptions: { resultSize: 10 },
    searchServiceSelected: 0,
    mcpServers: [],
    modeInjections: [
      {
        type: "mode",
        id: DEFAULT_LEARNING_MODE_ID,
        name: "Learning Mode",
        enabled: true,
        priority: 0,
        position: "after_system_prompt",
        content: "Use Socratic guidance. Ask questions, give hints, and help the user build understanding.",
        injectDepth: 4,
        role: "USER",
      },
    ],
    lorebooks: [],
    quickMessages: [],
    webDavConfig: {
      url: "",
      username: "",
      password: "",
      path: "rikkahub_backups",
      items: ["DATABASE", "FILES"],
    },
    s3Config: {
      endpoint: "",
      accessKeyId: "",
      secretAccessKey: "",
      bucket: "",
      region: "auto",
      pathStyle: true,
      items: ["DATABASE", "FILES"],
    },
    proxyConfig: {
      // 容器部署默认 env(docker 注入 HTTPS_PROXY); 桌面默认 auto(跟随系统代理)
      mode: RUNNING_IN_CONTAINER ? "env" : "auto",
      url: "",
      username: "",
      password: "",
      bypassRules: "",
    },
    webServerJwtEnabled: false,
    preferredPort: null,
    keybindings: {
      newConversation: { keys: ["Ctrl", "N"], enabled: true },
      prevConversation: { keys: ["Alt", "Up"], enabled: true },
      nextConversation: { keys: ["Alt", "Down"], enabled: true },
      renameConversation: { keys: ["F2"], enabled: true },
      searchConversations: { keys: ["Ctrl", "Shift", "F"], enabled: true },
      openSettings: { keys: ["Ctrl", ","], enabled: true },
      openImageGeneration: { keys: ["Ctrl", "I"], enabled: true },
      // 滚轮缩放:binding 固定为 Ctrl+Wheel,无法录制,只有 enabled 开关。
      zoomInOut: { enabled: true },
    },
    // 默认开启全局记忆层(叠加注入开箱可用)。老用户迁移时由 normalizeState 的 M1 逻辑
    // 推断:若所有助手 enableMemory=false,改为 false(避免被动注入全局记忆)。
    memorySettings: {
      globalEnabled: true,
      writeStrategy: "ask",
    },
  };
}

function defaultState(): State {
  return {
    settings: defaultSettings(),
    conversations: [],
    files: [],
    generatedImages: [],
    logs: [],
    stats: defaultRequestStats(),
    nextFileId: 1,
    nextGeneratedImageId: 1,
    launchCount: 0,
  };
}

export function normalizeState(input: Partial<State>): State {
  const fresh = defaultState();
  const parsedSettings = input.settings ?? fresh.settings;
  const normalized: State = {
    ...fresh,
    ...input,
    settings: {
      ...fresh.settings,
      ...parsedSettings,
    },
    conversations: Array.isArray(input.conversations)
      ? input.conversations.map((conversation) => ({
          ...conversation,
          systemPrompt: typeof conversation.systemPrompt === "string" ? conversation.systemPrompt : null,
        }))
      : [],
    files: Array.isArray(input.files) ? input.files : [],
    generatedImages: Array.isArray(input.generatedImages) ? input.generatedImages : [],
    logs: [],  // 内存态:启动清空,对齐移动端(performStateSave 写盘排除)
    stats: normalizeRequestStats(input.stats, Array.isArray(input.logs) ? input.logs : []),
    memories: Array.isArray(input.memories) ? input.memories.filter(isRecord).map((memory, index) => {
      const now = Date.now();
      // Pre-2026-05 PC builds saved global-scope memories under "global" (without underscores).
      // Migrate any legacy records so they continue to surface for assistants with
      // `useGlobalMemory: true`, matching the Android schema literal.
      const rawAssistantId = String(memory.assistantId ?? (memory as any).assistant_id ?? GLOBAL_MEMORY_ID);
      const assistantId = rawAssistantId === "global" ? GLOBAL_MEMORY_ID : rawAssistantId;
      return {
        id: Number(memory.id ?? index + 1),
        assistantId,
        content: String(memory.content ?? ""),
        createdAt: Number(memory.createdAt ?? (memory as any).created_at ?? now),
        updatedAt: Number(memory.updatedAt ?? (memory as any).updated_at ?? now),
      };
    }).filter((memory) => memory.content.trim()) : [],
    nextFileId: typeof input.nextFileId === "number" ? input.nextFileId : 1,
    nextMemoryId: typeof input.nextMemoryId === "number" ? input.nextMemoryId : 1,
    nextGeneratedImageId: typeof input.nextGeneratedImageId === "number" ? input.nextGeneratedImageId : 1,
    launchCount: typeof input.launchCount === "number" ? input.launchCount : 0,
  };
  const defaults = defaultSettings();
  normalized.settings.providers = mergeById(normalized.settings.providers ?? [], defaults.providers);
  normalized.settings.providers = normalized.settings.providers.map((providerItem) => ({
    ...providerItem,
    promptCaching: providerItem.type === "claude" ? providerItem.promptCaching === true : providerItem.promptCaching,
    promptCacheTtl: providerItem.promptCacheTtl === "1h" ? "1h" : "5m",
    models: (providerItem.models ?? []).map((item) => enrichModel(item)),
  }));
  normalized.settings.assistants = mergeById(normalized.settings.assistants ?? [], defaults.assistants);
  // Backfill mcpToolOverrides for assistants saved before this field existed. Default empty
  // object = inherit all globally-enabled tools, no per-assistant overrides applied.
  normalized.settings.assistants = normalized.settings.assistants.map((assistant) => ({
    ...assistant,
    mcpToolOverrides: isRecord(assistant.mcpToolOverrides)
      ? assistant.mcpToolOverrides as Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>>
      : {},
  }));
  // memorySettings 规范化 + M1 迁移推断:老用户首次升级(settings 无 memorySettings)时,
  // 若所有助手 enableMemory=false,globalEnabled 默认 false(避免被动注入全局,违背用户意愿);
  // 否则默认 true。用户设过 memorySettings(存在)则保留,仅校验 writeStrategy 合法性。
  {
    const userMs = (parsedSettings as unknown as Record<string, unknown>).memorySettings;
    if (isRecord(userMs)) {
      const ws = String((userMs as unknown as Record<string, unknown>).writeStrategy ?? "ask");
      normalized.settings.memorySettings = {
        globalEnabled: (userMs as unknown as Record<string, unknown>).globalEnabled !== false,
        writeStrategy: ws === "always_assistant" || ws === "always_global" || ws === "readonly"
          ? (ws as WriteStrategy)
          : "ask",
      };
    } else {
      const allDisabled = normalized.settings.assistants.length > 0
        && normalized.settings.assistants.every((a) => !a.enableMemory);
      normalized.settings.memorySettings = { globalEnabled: !allDisabled, writeStrategy: "ask" };
    }
  }
  normalized.settings.displaySetting = { ...defaults.displaySetting, ...(normalized.settings.displaySetting ?? {}) };
  // Backfill keybindings:以默认表为基底,逐 action 用用户保存的条目覆盖。保证新增 action 自动补
  // 默认、过滤未知 action、且每条 entry 字段完整(即使用户手改 state.json 造成残缺,默认值兜底)。
  const keybindingDefaults = defaults.keybindings as Record<string, JsonValue>;
  const userKeybindings = (normalized.settings.keybindings ?? {}) as Record<string, JsonValue>;
  const mergedKeybindings: Record<string, JsonValue> = {};
  for (const action of Object.keys(keybindingDefaults)) {
    const def = isRecord(keybindingDefaults[action]) ? keybindingDefaults[action] : {};
    const user = isRecord(userKeybindings[action]) ? userKeybindings[action] : {};
    mergedKeybindings[action] = { ...def, ...user };
  }
  normalized.settings.keybindings = mergedKeybindings;
  if (!String(normalized.settings.displaySetting.uiFontFamily ?? "").trim()) {
    normalized.settings.displaySetting.uiFontFamily = defaults.displaySetting.uiFontFamily;
    normalized.settings.displaySetting.uiFontFamilyCss = defaults.displaySetting.uiFontFamilyCss;
  }
  normalized.settings.titlePrompt = normalized.settings.titlePrompt || DEFAULT_TITLE_PROMPT;
  normalized.settings.translatePrompt = normalized.settings.translatePrompt || DEFAULT_TRANSLATION_PROMPT;
  normalized.settings.suggestionPrompt = normalized.settings.suggestionPrompt || DEFAULT_SUGGESTION_PROMPT;
  normalized.settings.ocrPrompt = normalized.settings.ocrPrompt || DEFAULT_OCR_PROMPT;
  normalized.settings.compressPrompt = normalized.settings.compressPrompt || DEFAULT_COMPRESS_PROMPT;
  normalized.settings.promptOptimizePrompt = normalized.settings.promptOptimizePrompt || DEFAULT_PROMPT_OPTIMIZE_PROMPT;
  normalized.settings.titlePrompt = normalized.settings.titlePrompt.replace(/not exceed 10 characters/gi, "not exceed 15 characters");
  normalized.settings.suggestionPrompt = normalized.settings.suggestionPrompt.replace(/not exceed 10 characters/gi, "not exceed 18 characters");
  // Backfill REASONING ability for previously-saved models (e.g. claude-opus-4-6) whose
  // abilities array was set before the inference regex covered them. Only adds — never removes.
  normalized.settings.providers = normalized.settings.providers.map((providerItem) => ({
    ...providerItem,
    models: (providerItem.models ?? []).map((modelItem) => {
      const inferred = inferModelAbilities(modelItem.modelId);
      const current = Array.isArray(modelItem.abilities) ? modelItem.abilities : [];
      const merged = uniqueStrings([...current, ...inferred]);
      return merged.length === current.length ? modelItem : { ...modelItem, abilities: merged };
    }),
  }));
  // 下架清理(见 SUNSET_PROVIDER_IDS):仅删老用户 state 里残留、且从未配置 apiKey 的。
  normalized.settings.providers = normalized.settings.providers.filter(
    (providerItem) => !SUNSET_PROVIDER_IDS.has(providerItem.id) || String(providerItem.apiKey ?? "").trim() !== "",
  );
  // 1.1.1 供应商迁移:
  // (a) 腾讯 Hunyuan 改名为"腾讯混元"(mergeById 保留老 name,这里强制按 id 改名,配置不变)。
  // (b) 钠API 给从未配置过的老用户(models 为空)补上预置模型;已自定义 models 的不覆盖。
  normalized.settings.providers = normalized.settings.providers.map((providerItem) => {
    if (providerItem.id === TENCENT_PROVIDER_ID) {
      return { ...providerItem, name: "腾讯混元" };
    }
    if (providerItem.id === NA_API_PROVIDER_ID && (providerItem.models ?? []).length === 0) {
      return { ...providerItem, models: NA_API_PRESET_MODELS.map((mid) => model(mid)) };
    }
    return providerItem;
  });
  // 1.1.1:按预置顺序重排内置供应商(老用户也生效)。用户新增的自定义供应商不在
  // BUILTIN_PROVIDER_ORDER 里,rank 都是 MAX_SAFE_INTEGER,稳定排序后仍按原相对顺序
  // 排在内置供应商之后,不会被重排打乱。这是一次性迁移——记录在 appliedMigrations,
  // 升级后用户的后续手动排序不会再被覆盖。
  const PROVIDER_REORDER_MIGRATION = "provider-reorder-1.1.1";
  const appliedMigrations = Array.isArray(normalized.appliedMigrations) ? normalized.appliedMigrations : [];
  if (!appliedMigrations.includes(PROVIDER_REORDER_MIGRATION)) {
    normalized.settings.providers = [...normalized.settings.providers].sort(
      (a, b) => builtinProviderRank(a) - builtinProviderRank(b),
    );
    normalized.appliedMigrations = [...appliedMigrations, PROVIDER_REORDER_MIGRATION];
  }
  normalized.settings.searchServices = normalized.settings.searchServices?.length
    ? normalized.settings.searchServices
    : defaults.searchServices;
  normalized.settings.webDavConfig = normalizeWebDavConfig(normalized.settings.webDavConfig);
  normalized.settings.s3Config = normalizeS3Config(normalized.settings.s3Config);
  normalized.settings.proxyConfig = normalizeProxyConfig(normalized.settings.proxyConfig);
  normalized.settings.preferredPort = normalizePreferredPort(normalized.settings.preferredPort);
  if (!normalized.settings.searchServices.some((service) => String((service as Record<string, JsonValue>).type ?? "").toLowerCase() === "tinyfish")) {
    normalized.settings.searchServices = [
      ...normalized.settings.searchServices,
      { type: "tinyfish", id: id(), name: "Tinyfish", apiKey: "" },
    ];
  }
  // Backfill 2026-05 search service additions for existing installs.
  if (!normalized.settings.searchServices.some((service) => String((service as Record<string, JsonValue>).type ?? "").toLowerCase() === "firecrawl")) {
    normalized.settings.searchServices = [
      ...normalized.settings.searchServices,
      { type: "firecrawl", id: id(), name: "Firecrawl", apiKey: "" },
    ];
  }
  if (!normalized.settings.searchServices.some((service) => String((service as Record<string, JsonValue>).type ?? "").toLowerCase() === "grok")) {
    normalized.settings.searchServices = [
      ...normalized.settings.searchServices,
      { type: "grok", id: id(), name: "Grok", apiKey: "", customUrl: "https://api.x.ai/v1/responses", model: "grok-4-fast" },
    ];
  }
  normalized.settings.asrProviders = normalizeAsrProviders(normalized.settings.asrProviders);
  normalized.settings.selectedASRProviderId = normalized.settings.asrProviders.some((provider) => provider.id === normalized.settings.selectedASRProviderId)
    ? normalized.settings.selectedASRProviderId
    : normalized.settings.asrProviders[0]?.id ?? null;
  normalized.settings.ttsProviders = normalizeTtsProviders(normalized.settings.ttsProviders);
  normalized.settings.ttsProviders = normalized.settings.ttsProviders.filter(
    (providerItem) => !SUNSET_TTS_PROVIDER_IDS.has(providerItem.id) || String(providerItem.apiKey ?? "").trim() !== "",
  );
  normalized.settings.selectedTTSProviderId = normalized.settings.ttsProviders.some((provider) => provider.id === normalized.settings.selectedTTSProviderId)
    ? normalized.settings.selectedTTSProviderId
    : normalized.settings.ttsProviders[0]?.id ?? null;
  normalized.nextFileId = Math.max(
    normalized.nextFileId,
    ...normalized.files.map((file) => file.id + 1),
    1,
  );
  normalized.nextMemoryId = Math.max(
    normalized.nextMemoryId,
    ...(normalized.memories ?? []).map((memory) => memory.id + 1),
    1,
  );
  normalized.nextGeneratedImageId = Math.max(
    normalized.nextGeneratedImageId,
    ...normalized.generatedImages.map((image) => Number(image.id) + 1).filter((value) => Number.isFinite(value)),
    1,
  );
  return normalized;
}

// ============================================================================
// 记忆存储层(1.3.2 引入)
//
// 记忆从 state.json 分离到 pc-data/memory/ 目录,三个 JSON 文件独立管理:
//   global_memory.json     全局记忆 + nextMemoryId 全局计数器
//   assistant_memory.json  所有助手记忆(按 assistantId 分组,带助手名快照)
//   pending_memory.json    待确认队列(阶段 3 启用,阶段 1 预留结构)
//
// 本层是所有记忆读写的唯一入口,屏蔽文件细节。设计要点:
//   - 全量内存缓存,写入双写(内存 + 原子落盘);读取走内存索引,零 IO
//   - 原子 temp-rename 写(复用 state.json 的 8 次重试模式),绝不直接覆盖
//   - 串行化写队列:同一时刻只有一个写操作进行,防 AI 写入与批量编辑/导入并发交错
//   - S1 不变式:nextMemoryId 启动重算 = max(已落盘记忆 id)+1,不信任持久化值。
//     addMemory 先自增计数器再写记忆(内存序),persistAll 先写 global(计数器)再写
//     assistant——崩在任意点,recompute 都能自愈,已落盘 id 永不重用。
// ============================================================================

function loadState(): State {
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  // 1.2.6:会话从 state.json 迁入 SQLite 活库(rikka_hub.db)。state.json 瘦身后只保留
  // settings/files/images/memories/stats 等非会话状态;conversations 启动时从活库读。
  openConversationsDb();

  // 读 state.json(旧版含 conversations / 新版瘦身 / 不存在)
  let parsed: Partial<State>;
  if (!existsSync(statePath)) {
    parsed = defaultState();
  } else {
    try {
      parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>;
    } catch (err) {
      // state.json 损坏:尝试 pre-sqlite 备份;都没有则默认状态。
      console.error("[loadState] state.json 解析失败,尝试 pre-sqlite.bak", err);
      const bakPath = join(dataDir, "state.json.pre-sqlite.bak");
      try {
        parsed = existsSync(bakPath)
          ? (JSON.parse(readFileSync(bakPath, "utf8")) as Partial<State>)
          : defaultState();
      } catch (err2) {
        console.error("[loadState] pre-sqlite.bak 也失败,用默认状态", err2);
        parsed = defaultState();
      }
    }
  }

  // 迁移 + 瘦身(首次升级)。返回 true=从活库读;false=迁移失败,本次用 parsed.conversations。
  const migrated = migrateConversationsIfNeeded(parsed);

  const conversations = migrated
    ? loadConversationsFromDbWithFallback()
    : (Array.isArray(parsed.conversations) ? parsed.conversations : []);

  const state = normalizeState(parsed);
  state.conversations = conversations;
  migrateMemoryFilesIfNeeded(state);
  return state;
}

/** 1.3.2 记忆迁移:把 state.memories 搬到 pc-data/memory/ 目录(三个 JSON 文件)。
 *  迁移完成后 state 不再持有 memories / nextMemoryId(归 memoryStore 管理)。
 *  S2 三道防线:(a) 备份 state.json → pre-memory-split.bak;(b) 迁移完成后立即同步写瘦
 *  state.json(绕过 throttle,标记 + 排除第一时间落盘);(c) memory/ 目录已有数据则不覆盖
 *  (上次半完成),改为从文件加载 + 补写标记,保留用户可能的新增数据。 */
function migrateMemoryFilesIfNeeded(stateObj: State): void {
  const appliedMigrations = Array.isArray(stateObj.appliedMigrations) ? stateObj.appliedMigrations : [];

  // 已迁移:从 memory/ 目录加载,state 不持有 memories/nextMemoryId。
  if (appliedMigrations.includes(MEMORY_FILE_SPLIT_MIGRATION)) {
    memoryStore.load(stateObj);
    delete stateObj.memories;
    delete stateObj.nextMemoryId;
    return;
  }

  // S2 防御(c):标记未写但 memory/ 已有数据——上次迁移半完成(写文件后、写标记前崩)。
  // 不覆盖!从已有文件加载 + 补写标记,保留用户可能的新增数据。
  if (existsSync(globalMemoryPath) || existsSync(assistantMemoryPath) || existsSync(pendingMemoryPath)) {
    const gmfTemp = memoryStore.readFile(globalMemoryPath, { version: 1, nextMemoryId: 1, memories: [] }) as GlobalMemoryFile;
    const amfTemp = memoryStore.readFile(assistantMemoryPath, { version: 1, assistants: [] }) as AssistantMemoryFile;
    const hasData = (Array.isArray(gmfTemp.memories) && gmfTemp.memories.length > 0)
      || (Array.isArray(amfTemp.assistants) && amfTemp.assistants.length > 0);
    if (hasData) {
      console.warn("[memory] 检测到上次迁移半完成,memory/ 已有数据,从文件加载(不覆盖)");
      memoryStore.load(stateObj);
      stateObj.appliedMigrations = [...appliedMigrations, MEMORY_FILE_SPLIT_MIGRATION];
      delete stateObj.memories;
      delete stateObj.nextMemoryId;
      writeSlimStateJsonSyncForMemory(stateObj);
      return;
    }
  }

  // 正常首次迁移。S2(a):备份 state.json → pre-memory-split.bak(防覆盖已有备份)。
  const bakPath = join(dataDir, "state.json.pre-memory-split.bak");
  if (existsSync(statePath) && !existsSync(bakPath)) {
    try {
      copyFileSync(statePath, bakPath);
    } catch (err) {
      console.warn("[memory] pre-memory-split 备份失败(继续迁移)", err);
    }
  }

  const memoriesToMigrate = Array.isArray(stateObj.memories) ? stateObj.memories : [];
  console.log(`[memory] 首次升级:迁移 ${memoriesToMigrate.length} 条记忆到 memory/ 目录...`);
  memoryStore.migrateFromStateMemories(memoriesToMigrate, stateObj.settings.assistants);

  stateObj.appliedMigrations = [...appliedMigrations, MEMORY_FILE_SPLIT_MIGRATION];
  delete stateObj.memories;
  delete stateObj.nextMemoryId;

  // S2(b):立即同步写瘦 state.json,把"标记已写 + memories 已排除"第一时间持久化,
  // 把"已迁移但标记未落盘"的崩溃窗口压到几乎为零(对齐 migrateConversationsIfNeeded 的纪律)。
  writeSlimStateJsonSyncForMemory(stateObj);
  console.log("[memory] 记忆迁移完成");
}

/** 同步 temp+rename 写瘦 state.json,记忆迁移后立即落盘用(S2-b)。
 *  排除 logs(始终内存态)、conversations(会话已迁移则不写,未迁移则保留——按标记判断)、
 *  memories/nextMemoryId(调用前已 delete,不出现)。 */

// Streaming path throttles disk writes: token deltas can arrive 30-50/s for fast providers, and
// serializing+writing the full state on every chunk turns smooth streams into stutter. We coalesce
// writes inside `touchStream` to ~5/s while still broadcasting every chunk to SSE clients in real
// time. A final saveState() at end-of-generation makes the persisted state authoritative.

setState(loadState());
state.launchCount += 1;

// 必须在首次 fetch 之前安装（Bun.serve 接受请求之前），否则首个请求触发 env 快照锁定。
// 清空 env（非容器）+ 拦截 globalThis.fetch，per-request 按当前代理状态显式传 proxy。
// 清空 env (非容器) + 拦截 globalThis.fetch, per-request 按当前代理状态显式传 proxy。
installProxyFetchInterceptor(() => state.settings.proxyConfig);
applyEffectiveProxy(state.settings.proxyConfig);

// Async write queue — serializes saves so two callers can't race the temp-file rename
// dance, but each write is non-blocking on the event loop so other HTTP handlers (image
// fetches, conversation GETs, streaming SSE) can continue while disk I/O is in flight.
// Before this change, `saveState()` was fully synchronous (writeFileSync + busy-wait retry
// + pretty-printed JSON.stringify of the entire state). On a state.json grown into the
// 100+ MB range after an Android backup import, a single save would block the event loop
// for seconds — every concurrent request queued behind it, eventually tripping ky's 30 s
// timeout. The user-visible symptom: a streaming reply freezes, then ALL conversation
// GETs fail with "Request timed out" and the app becomes unusable until restart.

/** Used by graceful shutdown paths to ensure the final write completes on disk. */

// 顶层启动写盘：必须放在 activeSaveStatePromise / coalescedSaveRequested 这些 let
// 声明之后调用，否则会撞 TDZ 触发模块加载时的 ReferenceError，导致服务直接起不来。

export function computeStats() {
  const daily = new Map<string, DailyStat>();
  let userMessages = 0;
  let assistantMessages = 0;
  let characters = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const models = new Map<string, { id: string; name: string; providerName: string; count: number }>();
  const requestGroups = new Map<string, { ok: number; failed: number }>();
  const providers = new Map<string, { ok: number; failed: number }>();
  const modelLookup = new Map<string, { name: string; providerName: string }>();
  for (const provider of state.settings.providers) {
    for (const modelItem of provider.models ?? []) {
      modelLookup.set(modelItem.id, {
        name: modelItem.displayName || modelItem.modelId,
        providerName: provider.name,
      });
    }
  }

  for (const conversation of state.conversations) {
    const conversationDate = dateKey(conversation.createAt);
    const row = daily.get(conversationDate) ?? { date: conversationDate, messages: 0, conversations: 0, characters: 0 };
    row.conversations += 1;
    daily.set(conversationDate, row);

    for (const node of conversation.messages) {
      for (const msg of node.messages) {
        const msgDate = dateKey(msg.createdAt);
        const item = daily.get(msgDate) ?? { date: msgDate, messages: 0, conversations: 0, characters: 0 };
        const text = textFromParts(msg.parts);
        item.messages += 1;
        item.characters += text.length;
        daily.set(msgDate, item);
        characters += text.length;
        if (msg.role === "USER") userMessages += 1;
        if (msg.role === "ASSISTANT") assistantMessages += 1;
        if (msg.usage && typeof msg.usage === "object" && !Array.isArray(msg.usage)) {
          inputTokens += Number(msg.usage.promptTokens ?? msg.usage.inputTokens ?? 0);
          outputTokens += Number(msg.usage.completionTokens ?? msg.usage.outputTokens ?? 0);
        }
        if (msg.modelId) {
          const info = modelLookup.get(msg.modelId) ?? { name: msg.modelId, providerName: "" };
          const row = models.get(msg.modelId) ?? { id: msg.modelId, name: info.name, providerName: info.providerName, count: 0 };
          row.count += 1;
          models.set(msg.modelId, row);
        }
      }
    }
  }

  // 请求统计来自持久化累加器 state.stats(logs 已改内存态,不再遍历)。
  for (const [name, value] of Object.entries(state.stats.byProvider)) providers.set(name, { ...value });
  for (const [name, value] of Object.entries(state.stats.byGroup)) requestGroups.set(name, { ...value });

  return {
    totals: {
      conversations: state.conversations.length,
      messages: userMessages + assistantMessages,
      userMessages,
      assistantMessages,
      characters,
      inputTokens,
      outputTokens,
      launchCount: state.launchCount,
      requests: state.stats.totalRequests,
      failedRequests: state.stats.failedRequests,
    },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: [...models.values()].sort((a, b) => b.count - a.count),
    requestGroups: [...requestGroups.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => (b.ok + b.failed) - (a.ok + a.failed)),
    providers: [...providers.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => (b.ok + b.failed) - (a.ok + a.failed)),
  };
}


export function normalizeProxyConfig(value: unknown): ProxyConfig {
  const raw = isRecord(value) ? value : {};
  const url = String(raw.url ?? "").trim();
  const username = String(raw.username ?? "");
  const password = String(raw.password ?? "");
  const bypassRules = String(raw.bypassRules ?? "").trim();
  const rawMode = raw.mode;
  let mode: ProxyMode;
  if (rawMode === "auto" || rawMode === "manual" || rawMode === "direct" || rawMode === "env") {
    mode = rawMode;
  } else {
    // 旧 settings 无 mode 字段(或值非法)→ 按平台推断, 保证旧行为兼容:
    //   有 url → manual; 无 url + 容器 → env(docker 默认); 无 url + 桌面 → auto(跟随系统)
    if (url) mode = "manual";
    else if (RUNNING_IN_CONTAINER) mode = "env";
    else mode = "auto";
  }
  return { mode, url, username, password, bypassRules };
}

// Port setting: integer in [1, 65535] or null (auto). Anything out of range / wrong type
// normalizes back to null so a corrupt state.json can never wedge the server on an invalid port.
export function normalizePreferredPort(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    if (n >= 1 && n <= 65535) return n;
  }
  return null;
}

function hasJsonItemId(items: unknown, idValue: string) {
  return Array.isArray(items) && items.some((item) => isRecord(item) && String(item.id ?? "") === idValue);
}

export function validateKnownJsonIds(items: unknown, ids: unknown, fieldName: string) {
  const requested = getStringArray(ids);
  const unknownId = requested.find((itemId) => !hasJsonItemId(items, itemId));
  if (unknownId) throw new Error(`${fieldName} contains unknown id: ${unknownId}`);
  return requested;
}

export function upsertById(items: JsonValue[], item: Record<string, JsonValue>) {
  const itemId = String(item.id ?? id());
  const nextItem = { ...item, id: itemId };
  const exists = items.some((entry) => isRecord(entry) && String(entry.id) === itemId);
  return {
    item: nextItem,
    items: exists ? items.map((entry) => (isRecord(entry) && String(entry.id) === itemId ? nextItem : entry)) : [...items, nextItem],
  };
}

export function deleteById(items: JsonValue[], idValue: string) {
  return items.filter((entry) => !(isRecord(entry) && String(entry["id"]) === idValue));
}

export function reorderByIds<T extends JsonValue>(items: T[], ids: string[]) {
  const byId = new Map(items.filter(isRecord).map((item) => [String(item["id"]), item as T]));
  const ordered = ids.map((itemId) => byId.get(itemId)).filter(Boolean) as T[];
  const rest = items.filter((item) => !isRecord(item) || !ids.includes(String(item["id"])));
  return [...ordered, ...rest];
}


/**
 * 首次升级到 SQLite 版:① 备份 .bak → ② 灌库 → ③ 写瘦 state.json。
 * @returns true=已迁移/迁移成功(从活库读);false=灌库失败(本次用 parsed.conversations 兜底,
 *          state.json 保持原样,下次启动重试)。
 */
function migrateConversationsIfNeeded(parsed: Partial<State>): boolean {
  const appliedMigrations = Array.isArray(parsed.appliedMigrations) ? parsed.appliedMigrations : [];
  if (appliedMigrations.includes(CONVERSATIONS_SQLITE_MIGRATION)) return true;

  let conversationsToMigrate = Array.isArray(parsed.conversations) ? parsed.conversations : [];
  const preSqliteBakPath = join(dataDir, "state.json.pre-sqlite.bak");

  // 方案 B(兜底):state.json 已无 conversations,但 pre-sqlite.bak 里有——说明上次迁移
  // 失败、saveState 把会话从 state.json 抹空了(此路径已被 performStateSave 的标记门闸堵住,
  // 这里是纵深防御,捕获任何把 state.json 抹空的未知途径)。从 .bak 救回重灌。
  // 仅在迁移标记未写时执行:已迁移用户的空活库是合法空状态(用户删光了),不能误复活。
  // 标记已写会在上面 L3888 早退,不会走到这里。
  if (conversationsToMigrate.length === 0) {
    const fromBak = recoverConversationsFromBak();
    if (fromBak.length > 0) {
      console.log(`[conv-db] 检测到迁移失败残留:从 pre-sqlite.bak 恢复 ${fromBak.length} 条会话`);
      conversationsToMigrate = fromBak;
    }
  }

  // ① 备份(只在有会话、state.json 存在、.bak 不存在时;防覆盖已有备份)
  if (conversationsToMigrate.length > 0 && existsSync(statePath) && !existsSync(preSqliteBakPath)) {
    try {
      copyFileSync(statePath, preSqliteBakPath);
    } catch (err) {
      console.warn("[conv-db] pre-sqlite 备份失败(继续迁移)", err);
    }
  }

  // ② 灌库(单事务,幂等)。巨量会话卡几秒——这是一次性的。
  if (conversationsToMigrate.length > 0) {
    console.log(`[conv-db] 首次升级:迁移 ${conversationsToMigrate.length} 条会话进 SQLite 活库...`);
    try {
      migrateConversationsIntoDb(getConversationsDb()!, conversationsToMigrate);
      console.log("[conv-db] 会话迁移完成");
    } catch (err) {
      console.error("[conv-db] 会话迁移失败,保留 state.json 原样,下次启动重试", err);
      return false;
    }
  }

  // ③ 写瘦 state.json(删 conversations + 加迁移标记)
  parsed.appliedMigrations = [...appliedMigrations, CONVERSATIONS_SQLITE_MIGRATION];
  delete (parsed as { conversations?: Conversation[] }).conversations;
  try {
    writeSlimStateJsonSync(parsed);
  } catch (err) {
    console.warn("[conv-db] 写瘦 state.json 失败(活库已迁移,内存继续)", err);
  }
  return true;
}

/** 同步 temp+rename 写瘦 state.json。loadState 启动阶段用(不能异步)。 */

/** 从 state.json.pre-sqlite.bak 读 conversations(活库损坏时的最后兜底)。 */
function recoverConversationsFromBak(): Conversation[] {
  const bakPath = join(dataDir, "state.json.pre-sqlite.bak");
  try {
    if (!existsSync(bakPath)) return [];
    const bakParsed = JSON.parse(readFileSync(bakPath, "utf8")) as Partial<State>;
    return Array.isArray(bakParsed.conversations) ? bakParsed.conversations : [];
  } catch (err) {
    console.error("[conv-db] pre-sqlite.bak 恢复失败", err);
    return [];
  }
}

function loadConversationsFromDbWithFallback(): Conversation[] {
  try {
    return loadAllConversationsFromDb(getConversationsDb()!);
  } catch (err) {
    console.error("[conv-db] 活库读取失败,从 state.json.pre-sqlite.bak 恢复", err);
    return recoverConversationsFromBak();
  }
}


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

function shutdown() {
  server.stop(true);
  // 1.2.6:关停前刷活库残余脏标记 + WAL checkpoint(TRUNCATE 把 -wal 并入主库并截断),
  // 确保活库数据完整落盘、下次启动读到最新。
  try {
    flushConvDirtyNow();
    checkpointConversationsDb();
  } catch (err) {
    console.warn("[conv-db] 关停刷库失败", err);
  }
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

