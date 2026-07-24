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
export const MAX_TOOL_STEPS = 256;
const TITLE_CHARACTER_LIMIT = 15;
const SUGGESTION_CHARACTER_LIMIT = 18;

export const DEFAULT_TITLE_PROMPT = `I will give you some dialogue content in the \`<content>\` block.
You need to summarize the conversation between user and assistant into a short title.
1. The title language should be consistent with the user's primary language
2. Do not use punctuation or other special symbols
3. Reply directly with the title
4. Summarize using {locale} language
5. The title should not exceed ${TITLE_CHARACTER_LIMIT} characters

<content>
{content}
</content>`;

export const DEFAULT_SUGGESTION_PROMPT = `I will provide you with some chat content in the \`<content>\` block, including conversations between the User and the AI assistant.
You need to act as the **User** to reply to the assistant, generating 3~5 appropriate and contextually relevant responses to the assistant.

Rules:
1. Reply directly with suggestions, do not add any formatting, and separate suggestions with newlines, no need to add markdown list formats.
2. Use {locale} language.
3. Ensure each suggestion is valid.
4. Each suggestion should not exceed ${SUGGESTION_CHARACTER_LIMIT} characters.
5. Imitate the user's previous conversational style.
6. Act as a User, not an Assistant!

<content>
{content}
</content>`;

export const DEFAULT_TRANSLATION_PROMPT = `You are a translation expert, skilled in translating various languages, and maintaining accuracy, faithfulness, and elegance in translation.
Next, I will send you text. Please translate it into {target_lang}, and return the translation result directly, without adding any explanations or other content.

Please translate the <source_text> section:

<source_text>
{source_text}
</source_text>`;

export const DEFAULT_OCR_PROMPT = `You are an OCR assistant.

Extract all visible text from the image and also describe any non-text elements (icons, shapes, arrows, objects, symbols, or emojis).

For each element, specify:
- The exact text (for text) or a short description (for non-text).
- For document-type content, please use markdown and latex format.
- If there are objects like buildings or characters, try to identify who they are.
- Its approximate position in the image (e.g., 'top left', 'center right', 'bottom middle').
- Its spatial relationship to nearby elements (e.g., 'above', 'below', 'next to', 'on the left of').

Keep the original reading order and layout structure as much as possible.
Do not interpret or translate—only transcribe and describe what is visually present.`;

export const DEFAULT_COMPRESS_PROMPT = `You are a conversation compression assistant. Compress the following conversation into a concise summary.

Requirements:
1. Preserve key facts, decisions, and important context that would be needed to continue the conversation
2. Keep the summary in the same language as the original conversation
3. Target approximately {target_tokens} tokens
4. Output the summary directly without any explanations or meta-commentary
5. Format the summary as context information that can be used to continue the conversation
6. Use {locale} language
7. Start the output with a clear indicator that this is a summary (e.g., "[Summary of previous conversation]" or equivalent in the target language)

{additional_context}

<conversation>
{content}
</conversation>`;

// 提示词优化 meta-prompt —— 用户在对话界面点"优化提示词"时,把输入框原文(+可选的最近几轮
// 对话背景)+ 本提示词一起发给"提示词优化模型"。模型返回的优化版直接替换输入框,所以
// 输出必须纯净(无前言/解释/引号)。设计目标:把口语化、混乱的草稿打磨成清晰专业的版本,
// 同时严格不改原意、不膨胀简单请求、保留占位符和固定内容。开头明确"不限于某个领域"防止
// 模型默认偏向任何场景(如 coding)。上下文是可选的——首条消息或无对话时省略,且注入时
// 明确告诉模型"只在提示词承接对话时才用,否则忽略",防止无关上下文污染独立提示词。
export const DEFAULT_PROMPT_OPTIMIZE_PROMPT = `你是一位资深的提示词优化专家。下面会给你一段用户准备发给 AI 助手的话(提示词草稿),你的任务是把它打磨成清晰、得体、表达专业的版本,让 AI 更容易准确理解、给出更好的回复。这段话可能是提问、写作请求、修改要求、闲聊,或任何日常诉求——不限于某个领域。

## 优化原则

1. **严格保留原意,不要无中生有** —— 只能基于用户实际写出的内容来优化,不增加用户没有提出的诉求,不删减已表达的内容,不擅自改变核心意图。不要替用户补充他没有提供的具体信息(比如他说"帮我写封邮件",你不能擅自编造收件人、事由、语气);某处信息缺失或含糊时,就让表达更清楚、更有条理,但不要凭空捏造细节。你的职责是打磨表达,不是替用户重新定义需求。如果原文已经清晰得体,原样输出即可,不要为了优化而画蛇添足。

2. **消除歧义** —— 用户常用模糊或笼统的表述("弄一下""优化一下""帮我处理那个")。如果下方附带了对话背景、且提示词明显在承接它(出现"那个""上面说的""再…一下"等指代),请结合背景理解这些指代具体指向什么;如果没有背景或仍无法确定,保留原表述,不要凭空猜测后替换——错误的猜测比模糊更糟。

3. **让表达更清楚、更有条理** —— 把口语化、啰嗦、跳跃的表述梳理得通顺连贯。如果诉求包含多个要点(背景、需求、约束、期望的输出格式或语气),用分节或编号列表清晰组织;如果只是一句话的简单请求,保持简洁,不要用多余的框架稀释重点——简洁本身就是专业。

4. **用词得体专业** —— 在不改变原意的前提下,把模糊、随意的说法换成更准确、更得体的表达,让模糊的动词变成具体的动作。例如:"帮我弄个东西" → 点明具体要做什么;"写个东西给老板" → 明确是邮件 / 汇报 / 请示中的哪一种;"弄好看点" → 指明是调整措辞 / 优化排版 / 精简结构;"翻译一下" → 点明源语言、目标语言、要保留的风格。注意保持原文的语域——正式的保持规整,轻松的别写得僵硬。

5. **必要时点明隐含期望** —— 如果提示词隐含了目标读者、语气、篇幅、输出格式(如希望分点回答、举例、简短)或希望 AI 扮演的角色,且能从上下文或常识中合理推断,将其显式写出。无法合理推断的不要编造,也不要强加用户没有暗示的要求。

6. **保持原文语言** —— 中文保持中文,英文保持英文,不要翻译,不要自行添加用户未要求的外语。

7. **原样保留特殊内容** —— 原文中的模板占位符(如 {{name}}、{topic}、<url>、[日期])、代码块、数据、公式、引用原样保留,不修改、不"改进"。只优化这些固定内容之外的说明性文字。

## 输出要求

只输出优化后的那段话本身。不要写任何前言、解释、"以下是优化版本"之类的引导语,不要用引号包裹结果,不要在末尾追加说明。用户会把你的输出直接读进输入框——任何提示词以外的文字都是干扰。`;

// 运行平台（用于自动更新：Windows 走 Tauri NSIS 安装器，Linux 走二进制原地替换）。
// 与 analyticsOs() 的划分保持一致 —— Docker 容器内 process.platform 也是 "linux"，
// 这是对的：Docker 镜像就是 Linux 二进制，只是它的更新路径不同（见下）。

// 容器化部署检测。Docker 内即使替换了 /app/rikkahub-pc，容器一旦重建就会回到镜像里的
// 旧版本，原地更新没有意义 —— 这类部署应当 docker pull 新镜像。检测 /.dockerenv（Docker
// 标准标记）或显式注入的环境变量（兼容其他容器运行时）。

// 应用内更新下载源:Cloudflare R2 镜像,与官网(rikkahub-desktop.pages.dev)同源,国内/全球

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

function abortConversationGeneration(conversationId: string) {
  const wasGenerating = generating.has(conversationId);
  generating.get(conversationId)?.abort();
  generating.delete(conversationId);
  // Mirror completeConversationGeneration: when the user manually stops generation,
  // the sidebar's per-conversation streaming indicator also needs to flip off, and
  // since broadcastNodeUpdateNow no longer calls broadcastList on every chunk we
  // have to refresh the list explicitly here.
  if (wasGenerating) broadcastList();
  // 1.2.6:用户中止也要 reconcile 活库——abort 提前 delete 了 generating,后续
  // completeConversationGeneration 的 if 会失败而跳过 reconcile,所以这里补一次全量
  // persistConversation。流式中删会话(deleteConversationsById 先调本函数)时
  // getConversation 仍返回会话(filter 删除在后),persist 后由 deletePcConversations 清掉,幂等无害。
  flushConvDirtyNow();
  const conv = getConversation(conversationId);
  if (conv) persistConversation(conv);
}

export function deleteConversationsById(ids: Set<string>) {
  for (const conversationId of ids) {
    abortConversationGeneration(conversationId);
    conversationClients.delete(conversationId);
  }
  // 先删内存,再删活库——避免删活库后残余脏标记 flush 又把节点 upsert 回来
  // (flushConvDirty 检查 state.conversations 存在性,内存没了就跳过)。
  state.conversations = state.conversations.filter((item) => !ids.has(item.id));
  deletePcConversations(Array.from(ids));
  saveState();
  broadcastList();
}

export function findAssistant(idValue = state.settings.assistantId) {
  return findAssistantCore(state.settings.assistants, idValue);
}

export function ensureConversation(idValue: string) {
  let conversation = getConversation(idValue);
  if (!conversation) {
    const now = Date.now();
    const assistant = findAssistant(state.settings.assistantId);
    conversation = {
      id: idValue,
      assistantId: assistant.id,
      systemPrompt: null,
      title: "",
      messages: presetMessageNodes(assistant),
      truncateIndex: -1,
      chatSuggestions: [],
      isPinned: false,
      createAt: now,
      updateAt: now,
    };
    state.conversations.unshift(conversation);
    // 1.2.6:新建会话 persist 进活库(建会话行),否则后续流式 upsert 该会话的节点时
    // FK 失败(pc_message_node.conversation_id 引用 pc_conversation.id),且流式中崩溃
    // 会丢会话行。
    persistConversation(conversation);
  }
  return conversation;
}

function roleFromPreset(value: unknown): Message["role"] {
  const role = String(value ?? "USER").toUpperCase();
  if (role === "ASSISTANT" || role === "SYSTEM" || role === "TOOL") return role;
  return "USER";
}

function partsFromPreset(value: unknown): JsonValue[] {
  if (Array.isArray(value)) return value as JsonValue[];
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (isRecord(value) && Array.isArray(value.parts)) return value.parts;
  if (isRecord(value) && typeof value.content === "string") return [{ type: "text", text: value.content }];
  return [];
}

function presetMessageNodes(assistant: Assistant): MessageNode[] {
  return (Array.isArray(assistant.presetMessages) ? assistant.presetMessages : [])
    .map((preset) => {
      if (!isRecord(preset)) return null;
      const msg = message(roleFromPreset(preset.role), partsFromPreset(preset), String(preset.modelId ?? "") || null);
      if (typeof preset.id === "string") msg.id = preset.id;
      if (typeof preset.createdAt === "string") msg.createdAt = preset.createdAt;
      if (typeof preset.finishedAt === "string" || preset.finishedAt === null) msg.finishedAt = preset.finishedAt as string | null;
      return { id: id(), messages: [msg], selectIndex: 0 };
    })
    .filter(Boolean) as MessageNode[];
}

function finishMessage(msg: Message, parts: JsonValue[], usage: JsonValue | null = msg.usage) {
  msg.parts = parts;
  msg.finishedAt = new Date().toISOString();
  msg.usage = usage;
}

function appendTextPart(msg: Message, text: string) {
  const last = msg.parts[msg.parts.length - 1];
  if (last && typeof last === "object" && !Array.isArray(last) && last.type === "text") {
    last.text = String(last.text ?? "") + text;
  } else {
    msg.parts.push({ type: "text", text });
  }
}

function summaryAsText(msg: Message) {
  return `[${msg.role}]: ${textFromParts(msg.parts)}`;
}
function estimatePromptTokensForConversation(conversation: Conversation) {
  return selectedConversationMessages(conversation)
    .filter((msg) => msg.role !== "ASSISTANT")
    .reduce((sum, msg) => sum + estimateTokens(textFromParts(msg.parts)), 0);
}

function ensureUsage(msg: Message, conversation?: Conversation) {
  const existing = msg.usage;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) return;
  const completionTokens = estimateTokens(textFromParts(msg.parts) || reasoningFromParts(msg.parts));
  const promptTokens = conversation ? estimatePromptTokensForConversation(conversation) : 0;
  msg.usage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedTokens: 0,
    estimated: true,
  };
  fillContextLimit(msg);
}

function toolApprovalType(part: JsonValue) {
  return isRecord(part) && isRecord(part.approvalState) ? String(part.approvalState.type ?? "auto") : "auto";
}

function hasToolParts(msg: Message) {
  return msg.parts.some((part) => isRecord(part) && part.type === "tool");
}

export function hasPendingToolApproval(msg: Message) {
  return msg.parts.some((part) => isRecord(part) && part.type === "tool" && toolApprovalType(part) === "pending");
}

function canResumeToolExecution(part: JsonValue) {
  const type = toolApprovalType(part);
  return type === "approved" || type === "denied" || type === "answered";
}

function hasResumableToolParts(msg: Message) {
  return msg.parts.some((part) =>
    isRecord(part) &&
    part.type === "tool" &&
    (!Array.isArray(part.output) || part.output.length === 0) &&
    canResumeToolExecution(part)
  );
}

// 是否为"正在生成"的空 ASSISTANT 占位:没有任何可发送内容(文本/思维链/工具/媒体),
// 只有 loading 占位或完全为空。组装上下文时它不是历史消息,不应占用 contextMessageSize
// 名额——否则 size=1 时 slice 只取到它(空内容随后被 appendAssistantApiMessages 过滤),
// 把用户真正的输入挤出上下文,模型只收到 system prompt(issue #16)。
// 注意:工具恢复场景下尾部 ASSISTANT 已带 tool 部分与结果(模型续轮必须看到),故必须靠
// "有无内容"判定,而不是 finishedAt——恢复消息 finishedAt 同样为 null 但不能剔除。

// 把上一条 ASSISTANT 消息里所有处于 pending 状态的工具（典型场景：ask_user
// 没等用户点选项，用户直接发了下一条消息或要求重生成）标记为"用户已取消"，
// 让本轮生成能干净地接续——对齐安卓 commit 05c12488 的 finishInterruptedPendingTools。
// 返回 true 表示发生了修改，调用方需要广播状态变更。
export function finishInterruptedPendingToolsInConversation(conversation: Conversation): boolean {
  const lastNode = conversation.messages[conversation.messages.length - 1];
  if (!lastNode) return false;
  const lastMessage = lastNode.messages[lastNode.selectIndex] ?? lastNode.messages[0];
  if (!lastMessage || lastMessage.role !== "ASSISTANT") return false;
  let changed = false;
  lastMessage.parts = lastMessage.parts.map((part) => {
    if (!isRecord(part) || part.type !== "tool") return part;
    if (toolApprovalType(part) !== "pending") return part;
    changed = true;
    return {
      ...part,
      approvalState: {
        type: "denied",
        reason: "User cancelled by sending a new message",
      },
      output: Array.isArray(part.output) && part.output.length > 0 ? part.output : [
        { type: "text", text: "Tool execution cancelled by user (new message sent)." },
      ],
    };
  });
  if (!changed) return false;
  if (!lastMessage.finishedAt) lastMessage.finishedAt = new Date().toISOString();
  // 清理 loading 占位符（如果旧 generation 留下了）
  lastMessage.parts = lastMessage.parts.filter((part) =>
    !(isRecord(part) && part.type === "loading"),
  );
  return true;
}

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



/** save_memory 工具执行(1.3.2)。模型只提议 content,应用按 writeStrategy 决定落地方式:
 *  - always_assistant + 助手层启用 → 直接存助手层
 *  - always_global + 全局层启用 → 直接存全局层
 *  - ask(默认)、或 always_* 但对应层未启用(M3 矛盾组合降级)→ 进待确认队列
 *  ★ 返回值不含 pending: true —— 生成不在此暂停(区别于 ask_user 的审批挂起机制,§6.2)。 */
async function runSaveMemoryTool(
  assistant: Assistant,
  args: Record<string, JsonValue>,
  context?: { conversationId?: string; conversationTitle?: string; messageNodeId?: string },
): Promise<Record<string, JsonValue>> {
  const content = String(args.content ?? "").trim();
  if (!content) throw new Error("content is required");
  const ms = state.settings.memorySettings;
  const strategy = ms.writeStrategy;

  if (strategy === "always_assistant" && assistant.enableMemory) {
    const mem = memoryStore.addMemory({ scope: "assistant", assistantId: assistant.id, content, source: "ai" });
    broadcastMemoryUpdate();
    return { status: "saved", scope: "assistant", content: mem.content };
  }
  if (strategy === "always_global" && ms.globalEnabled) {
    const mem = memoryStore.addMemory({ scope: "global", content, source: "ai" });
    broadcastMemoryUpdate();
    return { status: "saved", scope: "global", content: mem.content };
  }

  // 进待确认队列。context 从 executeToolCall 透传(流式路径含当前会话 + 节点),用于前端确认
  // 面板标注来源会话(标题快照)。非流式路径 context 缺失 → conversationId 留空(仅丧失来源追溯,
  // 不影响核心入队/确认流程)。
  const result = await memoryStore.enqueuePending({
    conversationId: context?.conversationId ?? "",
    conversationTitle: context?.conversationTitle,
    assistantId: assistant.id,
    assistantName: assistant.name,
    content,
    messageNodeId: context?.messageNodeId,
  });
  broadcastMemoryUpdate();
  if (result === null) return { status: "deduped" };       // M7:与现有 pending 完全相同,跳过
  if (result === "overflow") return { status: "overflow" }; // M7:队列已满,徽章变体高亮提醒
  return { status: "queued", pendingId: result.pendingId };
}

async function executeToolCall(
  toolCall: any,
  assistant: Assistant,
  context?: { conversationId?: string; conversationTitle?: string; messageNodeId?: string },
) {
  const name = String(toolCall.function?.name ?? "");
  let args: Record<string, JsonValue> = {};
  try {
    const parsedArgs = JSON.parse(String(toolCall.function?.arguments ?? "{}").trim() || "{}");
    if (!isRecord(parsedArgs) || Array.isArray(parsedArgs)) {
      throw new Error("tool arguments must be a JSON object");
    }
    args = parsedArgs as Record<string, JsonValue>;
  } catch (err) {
    throw new Error(`Invalid tool arguments JSON for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (name === "save_memory") return runSaveMemoryTool(assistant, args, context);
  // 联网搜索是可关闭的工具(全局 enableWebSearch 开关)。关闭后,tools 数组里不再声明
  // search_web,但历史消息里残留的 search tool_call 仍会诱导模型再次调用——而本函数原本
  // 无条件执行真搜索,造成"关了搜索 AI 照样搜"的 bug。加守卫与 use_skill(6266) /
  // callMcpTool(5912) 的"本轮未启用则拒绝执行"语义对齐(安卓等价:未注册到本轮 tools 表
  // 的工具根本查不到 execute)。throw 经调用方 catch 转成 tool_result 回灌,模型看到
  // "已禁用"即停止。
  if (name === "search_web") {
    if (!state.settings.enableWebSearch) {
      throw new Error(
        "Web search is currently disabled. Stop calling search_web and answer from your own knowledge, or ask the user to re-enable web search.",
      );
    }
    return runSearchWeb(args);
  }
  if (name === "scrape_web") {
    if (!state.settings.enableWebSearch) {
      throw new Error("Web search is currently disabled. Stop calling scrape_web.");
    }
    return runScrapeWeb(args);
  }
  if (name === "get_time_info") return runGetTimeInfoTool();
  if (name === "clipboard_tool") return runClipboardTool(args);
  if (name === "text_to_speech") return runTextToSpeechTool(args);
  if (name === "ask_user") return runAskUserTool(args);
  if (name === "use_skill") {
    const skillName = String(args.name ?? "").trim();
    if (!getStringArray(assistant.enabledSkills).includes(skillName)) {
      throw new Error(`Skill '${skillName}' is not available. Available skills: ${getStringArray(assistant.enabledSkills).join(", ")}`);
    }
    const path = String(args.path ?? "").trim();
    const content = path ? (() => {
      const target = safeSkillFile(skillName, path);
      if (!target || !existsSync(target)) throw new Error(`File '${path}' not found in skill '${skillName}'`);
      return readFileSync(target, "utf8");
    })() : readSkillBody(skillName);
    if (!content) throw new Error(`Skill '${skillName}' not found`);
    return { name: skillName, content };
  }
  if (name.startsWith("mcp__")) {
    return callMcpTool(assistant, name, args, state.settings.mcpServers, addLog);
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function safeDataFilePath(relativePath: string) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!decoded || decoded.split("/").some((part) => part === "..")) return null;
  const roots = [resolve(dataDir), resolve(filesDir)];
  const separator = process.platform === "win32" ? "\\" : "/";
  const candidates = [resolve(dataDir, decoded), resolve(filesDir, decoded)];
  return candidates.find((candidate) =>
    roots.some((root) => (candidate === root || candidate.startsWith(`${root}${separator}`))) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  ) ?? null;
}

async function saveToolBinaryContent(data: string, mime: string, prefix: string) {
  const fileId = state.nextFileId++;
  const fileName = `${prefix}-${Date.now()}-${fileId}${extensionFromMime(mime)}`;
  const target = join(filesDir, fileName);
  await Bun.write(target, Buffer.from(data, "base64"));
  const fileEntry: StoredFile = { id: fileId, path: target, fileName, mime, size: statSync(target).size };
  state.files.push(fileEntry);
  saveState();
  return `/api/files/${fileId}/content`;
}

/** 把各种工具原始返回值归一化为 ToolResult。
 *  特别地，MCP 返回的图片不再直接落盘，而是以 fileCreations 描述符交给协调器处理，
 *  避免工具执行层直接修改 state.files。 */
async function toolResultToParts(toolResult: unknown): Promise<ToolResult> {
  if (isRecord(toolResult) && Array.isArray(toolResult.output)) {
    const fileCreations: Array<{ data: string; mime: string; prefix: string }> = [];
    if (Array.isArray(toolResult.fileCreations)) {
      for (const fc of toolResult.fileCreations) {
        if (isRecord(fc)) {
          fileCreations.push({
            data: String(fc.data ?? ""),
            mime: String(fc.mime ?? ""),
            prefix: String(fc.prefix ?? ""),
          });
        }
      }
    }
    return { output: toolResult.output as JsonValue[], ...(fileCreations.length ? { fileCreations } : {}) };
  }
  if (typeof toolResult === "string") return { output: [{ type: "text", text: toolResult }] };
  if (isRecord(toolResult) && Array.isArray(toolResult.content)) {
    const parts: JsonValue[] = [];
    const fileCreations: Array<{ data: string; mime: string; prefix: string }> = [];
    for (const item of toolResult.content) {
      if (!isRecord(item)) continue;
      const type = String(item.type ?? "").toLowerCase();
      if (type === "text") {
        parts.push({ type: "text", text: String(item.text ?? "") });
        continue;
      }
      if (type === "image") {
        const data = String(item.data ?? item.base64 ?? "");
        const mime = String(item.mimeType ?? item.mime_type ?? "image/png");
        if (data) {
          // 不直接保存文件，把描述符交给协调器，由它统一写盘并生成 /api/files/{id}/content URL。
          fileCreations.push({ data, mime, prefix: "mcp-image" });
        }
        continue;
      }
      if (type === "resource" && isRecord(item.resource)) {
        const resource = item.resource;
        const text = String(resource.text ?? "");
        if (text) parts.push({ type: "text", text });
        else parts.push({ type: "text", text: JSON.stringify(item) });
        continue;
      }
      parts.push({ type: "text", text: JSON.stringify(item) });
    }
    return { output: parts, ...(fileCreations.length ? { fileCreations } : {}) };
  }
  return { output: [{ type: "text", text: JSON.stringify(toolResult) }] };
}

/** 将 ToolResult 中的 fileCreations 落盘，并补充对应的 image parts。 */
async function realizeToolResult(result: ToolResult): Promise<JsonValue[]> {
  const extra: JsonValue[] = [];
  if (result.fileCreations) {
    for (const fc of result.fileCreations) {
      const url = await saveToolBinaryContent(fc.data, fc.mime, fc.prefix);
      extra.push({ type: "image", url, metadata: { source: "mcp", mime: fc.mime } });
    }
  }
  return [...result.output, ...extra];
}


export function markProviderTestResult(providerItem: Provider, checks: Array<{ mode: string; ok: boolean }>) {
  if (!providerTestCorePassed(checks)) return;
  updateSettings({
    ...state.settings,
    providers: state.settings.providers.map((item) =>
      item.id === providerItem.id
        ? { ...item, testPassed: true, testPassedAt: Date.now() }
        : item,
    ),
  });
}

async function callProvider(
  conversation: Conversation,
  signal?: AbortSignal,
  hooks?: StreamHooksWithSink,
) {
  const assistant = findAssistant(conversation.assistantId);
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const providerItem = picked.provider;
  const selectedModel = picked.model.modelId === "auto" ? "gpt-4o-mini" : picked.model.modelId;
  const url = endpointFor(providerItem);
  const headers = applyRequestHeaders({ "Content-Type": "application/json" }, assistant, providerItem, picked.model);
  // 对齐 e63d017：OpenAI 路径才让 includeHistoryReasoning 生效；
  // claude/google 不走 OpenAI assistant 序列化，一律保持 true。
  const includeHistoryReasoning =
    providerItem.type === "openai" ? providerItem.includeHistoryReasoning !== false : true;
  const messagesForApi = conversationMessagesForApi(conversation, assistant, includeHistoryReasoning);
  let body: Record<string, any>;

  if (providerItem.type === "google") {
    // Gemini 鉴权：API key 走 query param（与安卓非 Vertex 路径的 x-goog-api-key 等价，
    // 这里沿用既有 query 形式以兼容各类兼容网关）。
    const apiKey = providerItem.apiKey;
    const baseUrl = providerItem.baseUrl;
    body = buildGoogleRequestBody(messagesForApi, picked.model, assistant);
    const finalBody = applyCustomBody(body, assistant, picked.model);
    // 有 hooks（来自会话）时走 SSE 流式 + 工具循环；辅助调用无 hooks 时退回非流式。
    if (hooks?.message != null) {
      return streamGoogleChatWithTools(baseUrl, headers, apiKey, selectedModel, finalBody, providerItem, assistant, signal, hooks);
    }
    const googleUrl = `${baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
    return fetchText(googleUrl, headers, finalBody, providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? "").join("") ?? "", signal);
  }

  if (providerItem.type === "claude") {
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const messages = messagesForApi;
    const systemContent = messages.find((item) => item.role === "system")?.content;
    const functionTools = supportsAbility(picked.model, "TOOL")
      ? [...openAiSearchTools(), ...openAiLocalTools(assistant), ...openAiSkillTools(assistant), ...openAiMcpTools(assistant)]
      : [];
    const claudeTools = claudeToolsFromOpenAiTools(functionTools, providerItem);
    const normalizedReasoning = reasoningLevelNormalized(assistant.reasoningLevel);
    const reasoningActive = supportsAbility(picked.model, "REASONING") && normalizedReasoning !== "off";
    // Always stream when invoked from a conversation (hooks present). The streaming path handles
    // text + thinking + tool_use deltas live, matching Android (ClaudeProvider.streamText). The
    // non-streaming fallback only runs for auxiliary calls without hooks (title/translate, etc.).
    const canStream = hooks?.message != null;
    body = {
      model: selectedModel,
      max_tokens: assistant.maxTokens ?? 64_000,
      stream: canStream,
      system: claudeSystemContent(systemContent, providerItem),
      messages: claudeMessagesFromApiMessages(messages, providerItem),
      // 顶层 cache_control: 让 Anthropic 自动管理缓存断点
      // 对齐安卓 ClaudeProvider.kt:275-278 (commit d2e52106)
      ...(providerItem.promptCaching === true
        ? { cache_control: claudeCacheControlEphemeral(providerItem) }
        : {}),
      ...(assistant.temperature != null && !reasoningActive ? { temperature: assistant.temperature } : {}),
      ...(assistant.topP != null ? { top_p: assistant.topP } : {}),
      // thinking + output_config：DeepSeek 走 Claude 格式时用 display:"raw" 展示原始思维链
      ...claudeThinkingPayload(picked.model, assistant.reasoningLevel),
      ...(claudeTools.length ? { tools: claudeTools } : {}),
    };
    if (canStream) {
      return streamClaudeChatWithTools(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks!);
    }
    return fetchClaudeTextWithTools(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks);
  }

  headers.Authorization = `Bearer ${providerItem.apiKey}`;
  if (providerItem.useResponseApi) {
    const functionTools = supportsAbility(picked.model, "TOOL") ? [...openAiSearchTools(), ...openAiLocalTools(assistant), ...openAiSkillTools(assistant), ...openAiMcpTools(assistant)] : [];
    const builtInTools = responseApiBuiltInTools(picked.model);
    const systemContent = conversationResponseApiInstructions(conversation, assistant);
    const reasoning = responseApiReasoningForProvider(providerItem, picked.model, assistant.reasoningLevel);
    const include = responseApiIncludeForProvider(providerItem, picked.model);
    body = {
      model: selectedModel,
      stream: false,
      store: false,
      ...(systemContent ? { instructions: systemContent } : {}),
      input: conversationResponseApiInput(conversation, assistant),
      ...(isModelAllowTemperature(picked.model) ? { temperature: assistant.temperature ?? undefined } : {}),
      ...(isModelAllowTemperature(picked.model) ? { top_p: assistant.topP ?? undefined } : {}),
      ...(assistant.maxTokens != null ? { max_output_tokens: assistant.maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(include ? { include } : {}),
      tools: [
        ...functionTools.map((tool: any) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
        ...builtInTools,
      ].filter(Boolean),
    };
    if (!body.tools.length) delete body.tools;
    return fetchText(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, (raw) => raw.output_text ?? raw.output?.flatMap((item: any) => item.content ?? []).map((item: any) => item.text ?? "").join("\n"), signal);
  }
  const tools = supportsAbility(picked.model, "TOOL") ? [...openAiSearchTools(), ...openAiLocalTools(assistant), ...openAiSkillTools(assistant), ...openAiMcpTools(assistant)] : [];
  body = {
    model: selectedModel,
    messages: messagesForApi,
    temperature: isModelAllowTemperature(picked.model) ? assistant.temperature ?? undefined : undefined,
    top_p: isModelAllowTemperature(picked.model) ? assistant.topP ?? undefined : undefined,
    max_tokens: assistant.maxTokens ?? undefined,
    ...(providerItem.type === "openai" ? { modalities: openAiChatCompletionsModalities(picked.model, providerItem) } : {}),
    ...reasoningPayloadForProvider(providerItem, picked.model, assistant.reasoningLevel),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
  };
  return fetchOpenAiText(url, headers, applyCustomBody(body, assistant, picked.model), providerItem, assistant, signal, hooks);
}

export function touchStream(hooks?: StreamHooksWithSink) {
  if (!hooks?.conversation || !hooks.node) return;
  // 事件流模式下，副作用（updateAt、标脏、SSE、持久化）由协调器统一处理，
  // 这里直接返回，避免推理引擎直接触发广播/SQLite 写入。
  if (hooks.sink) return;
  hooks.conversation.updateAt = Date.now();
  // 1.2.6:流式增量写活库——只标脏当前在长的会话行(updateAt)+ 节点,200ms 合并 upsert
  // 进 SQLite。不再全量重写 state.json(会话已迁出 state.json)。N 路流式并发时各自标脏,
  // flush 时逐行 upsert,SQLite WAL 串行化。流式结束(complete/abort)再全量 reconcile。
  markConversationRowDirty(hooks.conversation.id);
  markMessageNodeDirty(hooks.conversation.id, hooks.node.id);
  scheduleThrottledConvFlush();
  scheduleNodeBroadcast(hooks.conversation, hooks.node);
}

/** 从 StreamHooks 抽取 save_memory 等工具需要的会话上下文(透传给 pending 队列做来源追溯)。
 *  hooks 在非流式路径(如 executeApprovedToolPart)可能缺失 → 返回 undefined,runSaveMemoryTool
 *  入队时降级为空 conversationId(仅丧失来源追溯,不影响核心流程)。
 *  conversationTitle 取入队时快照(与会话后续改名/删除解耦),空标题不传。 */
async function callProviderStreaming(
  conversation: Conversation,
  assistantMessage: Message,
  assistantNode: MessageNode,
  ctx: { signal?: AbortSignal; sink: GenerationEventSink; executeTool: ToolExecutor },
): Promise<string> {
  const assistant = findAssistant(conversation.assistantId);
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  const providerItem = picked.provider;
  const selectedModel = picked.model.modelId === "auto" ? "gpt-4o-mini" : picked.model.modelId;
  const url = endpointFor(providerItem);
  const headers = applyRequestHeaders(
    { "Content-Type": "application/json", Authorization: `Bearer ${providerItem.apiKey}` },
    assistant,
    providerItem,
    picked.model,
  );
  const messagesForApi = conversationMessagesForApi(
    conversation,
    assistant,
    // 对齐 e63d017：OpenAI 类型 provider 才尊重 includeHistoryReasoning 选项；
    // 默认 true，仅当用户显式关闭时才不回传历史 reasoning_content。
    providerItem.type === "openai" ? providerItem.includeHistoryReasoning !== false : true,
  );
  const tools = supportsAbility(picked.model, "TOOL") ? [...openAiSearchTools(), ...openAiLocalTools(assistant), ...openAiSkillTools(assistant), ...openAiMcpTools(assistant)] : [];
  const hooks: StreamHooksWithSink = {
    message: assistantMessage,
    conversation,
    node: assistantNode,
    sink: ctx.sink,
    executeTool: ctx.executeTool,
  };
  if (providerItem.type !== "openai") {
    return callProvider(conversation, ctx.signal, hooks);
  }
  if (providerItem.useResponseApi) {
    const responseTools = [
      ...tools.map((tool: any) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
      ...responseApiBuiltInTools(picked.model),
    ];
    const systemContent = conversationResponseApiInstructions(conversation, assistant);
    const reasoning = responseApiReasoningForProvider(providerItem, picked.model, assistant.reasoningLevel);
    const include = responseApiIncludeForProvider(providerItem, picked.model);
    const body = applyCustomBody({
      model: selectedModel,
      stream: true,
      store: false,
      ...(systemContent ? { instructions: systemContent } : {}),
      input: conversationResponseApiInput(conversation, assistant),
      ...(isModelAllowTemperature(picked.model) ? { temperature: assistant.temperature ?? undefined } : {}),
      ...(isModelAllowTemperature(picked.model) ? { top_p: assistant.topP ?? undefined } : {}),
      ...(assistant.maxTokens != null ? { max_output_tokens: assistant.maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(include ? { include } : {}),
      tools: responseTools.length ? responseTools : undefined,
    }, assistant, picked.model);
    return fetchOpenAiTextStreaming(url, headers, body, providerItem, assistant, hooks, ctx.signal);
  }
  const body = applyCustomBody({
    model: selectedModel,
    messages: messagesForApi,
    temperature: isModelAllowTemperature(picked.model) ? assistant.temperature ?? undefined : undefined,
    top_p: isModelAllowTemperature(picked.model) ? assistant.topP ?? undefined : undefined,
    max_tokens: assistant.maxTokens ?? undefined,
    ...(providerItem.type === "openai" ? { modalities: openAiChatCompletionsModalities(picked.model, providerItem) } : {}),
    ...reasoningPayloadForProvider(providerItem, picked.model, assistant.reasoningLevel),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    stream: true,
    stream_options: hostOfProvider(providerItem) === "api.mistral.ai" ? undefined : { include_usage: true },
  }, assistant, picked.model);
  return fetchOpenAiTextStreaming(url, headers, body, providerItem, assistant, hooks, ctx.signal);
}


async function executeApprovedToolPart(part: Record<string, JsonValue>, assistant: Assistant) {
  const approvalType = toolApprovalType(part);
  if (approvalType === "answered") return String((part.approvalState as Record<string, JsonValue>)?.answer ?? "");
  if (approvalType === "denied") {
    const reason = String((part.approvalState as Record<string, JsonValue>)?.reason ?? "").trim() || "No reason provided";
    return { error: `Tool execution denied by user. Reason: ${reason}` };
  }
  return executeToolCall(apiToolCallFromPart(part), assistant);
}

async function resumeApprovedToolParts(
  conversation: Conversation,
  assistant: Assistant,
  assistantMessage: Message,
  assistantNode: MessageNode,
  useResponseInput: boolean,
) {
  const toolMessages: ApiMessage[] = [];
  let changed = false;
  for (const part of assistantMessage.parts) {
    if (!isRecord(part) || part.type !== "tool") continue;
    if (Array.isArray(part.output) && part.output.length > 0) continue;
    if (!canResumeToolExecution(part)) continue;
    let toolResult: unknown;
    try {
      toolResult = await executeApprovedToolPart(part, assistant);
    } catch (err) {
      toolResult = toolExecutionErrorPayload(err);
    }
    const normalized = await toolResultToParts(toolResult);
    part.output = await realizeToolResult(normalized);
    changed = true;
    toolMessages.push(
      useResponseInput
        ? { type: "function_call_output", call_id: String(part.toolCallId ?? ""), output: resolvedToolOutput(part) }
        : { role: "tool", tool_call_id: String(part.toolCallId ?? ""), content: resolvedToolOutput(part) },
    );
  }
  if (changed) {
    conversation.updateAt = Date.now();
    saveState();
    touchStream({ message: assistantMessage, conversation, node: assistantNode });
  }
  return toolMessages;
}

function cleanAuxiliaryText(text: string, fallback = "") {
  const cleaned = text.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
  if (!cleaned || cleaned === "(empty response)") {
    if (fallback) return fallback;
    throw new Error("Auxiliary model returned empty response");
  }
  return cleaned;
}

function firstAuxiliaryLine(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function limitAuxiliaryText(text: string, limit: number) {
  return Array.from(text).slice(0, limit).join("");
}

export async function generateTitleForConversation(conversation: Conversation) {
  const summary = conversationSummary(conversation, 4).trim();
  const firstText = textFromParts(conversation.messages[0]?.messages[0]?.parts ?? []).trim();
  const content = summary || firstText;
  if (!content) return "New Conversation";
  const prompt = applyPlaceholders(state.settings.titlePrompt || DEFAULT_TITLE_PROMPT, {
    locale: localeDisplayName(),
    content: selectedConversationMessages(conversation).slice(-4).map(summaryAsText).join("\n\n"),
  });
  const text = await fetchAuxiliaryText(state.settings.titleModelId, prompt, "title", {
    reasoningLevel: "off",
  });
  return limitAuxiliaryText(
    firstAuxiliaryLine(cleanAuxiliaryText(text, limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation")),
    TITLE_CHARACTER_LIMIT,
  ) || "New Conversation";
}

function shouldAutoGenerateTitle(conversation: Conversation) {
  const firstText = textFromParts(conversation.messages[0]?.messages[0]?.parts ?? []).trim();
  const title = String(conversation.title ?? "").trim();
  if (!title || title === "New Conversation") return true;
  if (firstText && title === limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT)) return true;
  return false;
}

function conversationSummary(conversation: Conversation, takeLast = 8) {
  return conversation.messages
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean)
    .slice(-takeLast)
    .map((msg) => summaryAsText(msg))
    .filter((line) => line.trim().length > 6)
    .join("\n\n");
}

export function isQwenMtModel(modelId: string) {
  const normalized = modelId.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.includes("qwen") && tokens.includes("mt");
}

export function englishLanguageName(locale: string) {
  const language = locale.trim() || Intl.DateTimeFormat().resolvedOptions().locale;
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    return displayNames.of(language) || displayNames.of(language.split(/[-_]/)[0]) || language;
  } catch {
    return language.split(/[-_]/)[0] || language;
  }
}

export async function fetchAuxiliaryText(modelId: string, prompt: string, kind: string, options: AuxiliaryTextOptions = {}) {
  const picked = findModel(modelId || state.settings.chatModelId);
  const providerItem = picked.provider;
  const modelItem = picked.model;
  const selectedModel = modelItem.modelId === "auto" ? "gpt-4o-mini" : modelItem.modelId;
  const maxTokens = options.maxTokens ?? null;
  const reasoningLevel = options.reasoningLevel ?? null;
  const stream = options.stream === true;
  const pushDelta = (text: string) => {
    if (text) options.onDelta?.(text);
  };
  const assistant = {
    ...findAssistant(state.settings.assistantId),
    chatModelId: modelItem.id,
    systemPrompt: "",
    temperature: options.temperature ?? null,
    topP: null,
    maxTokens,
    streamOutput: false,
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
    customBodies: options.customBody
      ? Object.entries(options.customBody).map(([key, value]) => ({ key, value }))
      : [],
  } as Assistant;
  const headers = applyRequestHeaders({ "Content-Type": "application/json" }, assistant, providerItem, modelItem);
  let endpoint = endpointFor(providerItem);
  let body: Record<string, any>;
  if (providerItem.type === "google") {
    endpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent?key=${encodeURIComponent(providerItem.apiKey)}`;
    body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
        ...(options.temperature != null ? { temperature: options.temperature } : {}),
      },
    };
    if (stream && options.onDelta) {
      const streamEndpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:streamGenerateContent?key=${encodeURIComponent(providerItem.apiKey)}`;
      try {
        return cleanAuxiliaryText(await fetchGoogleAuxiliaryStream(streamEndpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, pushDelta));
      } catch {
        // Fall back to non-streaming auxiliary calls; some compatible gateways do not expose Gemini streaming.
      }
    }
    return fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.[0]?.text);
  }
  if (providerItem.type === "claude") {
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: selectedModel,
      max_tokens: maxTokens ?? 64_000,
      messages: [{ role: "user", content: prompt }],
      stream,
      ...(options.temperature != null && (!reasoningLevel || !reasoningEnabled(reasoningLevel)) ? { temperature: options.temperature } : {}),
      // 与主路径一致：thinking + output_config，DeepSeek 走 Claude 格式时 display:"raw"
      ...(reasoningLevel ? claudeThinkingPayload(modelItem, reasoningLevel) : {}),
    };
    if (stream && options.onDelta) {
      try {
        return cleanAuxiliaryText(await fetchClaudeAuxiliaryStream(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, pushDelta));
      } catch {
        body.stream = false;
      }
    }
    return fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.content?.map((item: { text?: string }) => item.text ?? "").join("\n"));
  }
  headers.Authorization = `Bearer ${providerItem.apiKey}`;
  body = providerItem.useResponseApi
    ? {
        model: selectedModel,
        input: [{ role: "user", content: prompt }],
        stream,
        store: false,
        ...(maxTokens != null ? { max_output_tokens: maxTokens } : {}),
        ...(reasoningLevel && supportsAbility(modelItem, "REASONING")
          ? { reasoning: { summary: "auto", ...(reasoningLevelNormalized(reasoningLevel) !== "auto" ? { effort: reasoningLevelNormalized(reasoningLevel) === "off" ? "none" : reasoningLevelNormalized(reasoningLevel) } : {}) } }
          : {}),
      }
    : {
        model: selectedModel,
        messages: [{ role: "user", content: prompt }],
        stream,
        ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
        ...(options.temperature != null && isModelAllowTemperature(modelItem) ? { temperature: options.temperature } : {}),
        ...(options.topP != null && isModelAllowTemperature(modelItem) ? { top_p: options.topP } : {}),
        ...auxiliaryReasoningPayloadForProvider(providerItem, modelItem, reasoningLevel),
      };
  if (stream && options.onDelta) {
    try {
      const text = await fetchOpenAiAuxiliaryStream(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, pushDelta);
      if (!text || text === "(empty response)") throw new Error(`${kind} model returned empty response`);
      return text;
    } catch {
      body.stream = false;
    }
  }
  const text = await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, completionMessageText);
  if (!text || text === "(empty response)") throw new Error(`${kind} model returned empty response`);
  return text;
}

function reasoningEnabled(level: string | null | undefined) {
  return reasoningLevelNormalized(level) !== "off";
}

function modelExists(modelId: string | null | undefined) {
  if (!modelId) return false;
  if (modelId === DEFAULT_AUTO_MODEL_ID || modelId === "auto") return true;
  return state.settings.providers.some((providerItem) =>
    providerItem.models.some((modelItem) => modelItem.id === modelId || modelItem.modelId === modelId)
  );
}

async function fetchAuxiliaryOcrText(imageUrl: string) {
  if (!modelExists(state.settings.ocrModelId)) return "";
  const picked = findModel(state.settings.ocrModelId);
  const providerItem = picked.provider;
  const modelItem = picked.model;
  const selectedModel = modelItem.modelId === "auto" ? "gpt-4o-mini" : modelItem.modelId;
  const assistant = {
    ...findAssistant(state.settings.assistantId),
    chatModelId: modelItem.id,
    systemPrompt: "",
    temperature: 0,
    topP: null,
    maxTokens: 2048,
    streamOutput: false,
    enabledSkills: [],
    mcpServers: [],
    localTools: [],
  } as Assistant;
  const prompt = state.settings.ocrPrompt || DEFAULT_OCR_PROMPT;
  const dataUrl = dataUrlForMessageUrl(imageUrl);
  const headers = applyRequestHeaders({ "Content-Type": "application/json" }, assistant, providerItem, modelItem);
  let endpoint = endpointFor(providerItem);
  let body: Record<string, any>;

  if (providerItem.type === "google") {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return "";
    endpoint = `${providerItem.baseUrl.replace(/\/+$/, "")}/models/${selectedModel}:generateContent?key=${encodeURIComponent(providerItem.apiKey)}`;
    body = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: parsed.mime, data: parsed.data } },
        ],
      }],
    };
    return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.candidates?.[0]?.content?.parts?.[0]?.text));
  }

  if (providerItem.type === "claude") {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return "";
    headers["x-api-key"] = providerItem.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: selectedModel,
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", source: { type: "base64", media_type: parsed.mime, data: parsed.data } },
        ],
      }],
    };
    return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, (raw) => raw.content?.map((item: { text?: string }) => item.text ?? "").join("\n")));
  }

  headers.Authorization = `Bearer ${providerItem.apiKey}`;
  body = providerItem.useResponseApi
    ? {
        model: selectedModel,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl },
          ],
        }],
        max_output_tokens: 2048,
      }
    : {
        model: selectedModel,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        max_tokens: 2048,
        temperature: isModelAllowTemperature(modelItem) ? 0 : undefined,
      };
  return cleanAuxiliaryText(await fetchText(endpoint, headers, applyCustomBody(body, assistant, modelItem), providerItem, completionMessageText));
}

function shouldOcrForModel(modelItem: Model) {
  return !supportsInputModality(modelItem, "IMAGE") && modelExists(state.settings.ocrModelId);
}

export async function attachOcrToImageParts(parts: JsonValue[], modelItem: Model) {
  if (!shouldOcrForModel(modelItem)) return parts;
  const next = [...parts];
  for (let index = 0; index < next.length; index += 1) {
    const part = next[index];
    if (!isRecord(part) || part.type !== "image") continue;
    const metadata = isRecord(part.metadata) ? part.metadata : {};
    if (String(metadata.ocrText ?? "").trim()) continue;
    const url = String(part.url ?? "");
    if (!url) continue;
    try {
      const ocrText = await fetchAuxiliaryOcrText(url);
      if (ocrText) {
        next[index] = { ...part, metadata: { ...metadata, ocrText, ocrStatus: "done" } };
      }
    } catch (err) {
      next[index] = {
        ...part,
        metadata: {
          ...metadata,
          ocrStatus: "failed",
          ocrError: err instanceof Error ? err.message : String(err),
        },
      };
      console.warn("OCR failed:", err);
    }
  }
  return next;
}

export function markOcrPendingParts(parts: JsonValue[], modelItem: Model) {
  if (!shouldOcrForModel(modelItem)) return parts;
  return parts.map((part) => {
    if (!isRecord(part) || part.type !== "image") return part;
    const metadata = isRecord(part.metadata) ? part.metadata : {};
    if (String(metadata.ocrText ?? "").trim()) return part;
    return { ...part, metadata: { ...metadata, ocrStatus: "pending" } };
  });
}

async function generateSuggestionsForConversation(conversation: Conversation) {
  const content = conversationSummary(conversation, 8);
  if (!content) return [];
  const prompt = applyPlaceholders(state.settings.suggestionPrompt || DEFAULT_SUGGESTION_PROMPT, {
    locale: localeDisplayName(),
    content: selectedConversationMessages(conversation).slice(-8).map(summaryAsText).join("\n\n"),
  });
  const text = await fetchAuxiliaryText(state.settings.suggestionModelId, prompt, "suggestion", {
    reasoningLevel: "off",
  });
  return uniqueStrings(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "").trim())
      .filter(Boolean)
      .map((line) => limitAuxiliaryText(line, SUGGESTION_CHARACTER_LIMIT))
      .filter(Boolean),
  ).slice(0, 10);
}

export async function compressConversation(conversation: Conversation, additionalPrompt = "", targetTokens = 2000, keepRecentMessages = 32) {
  const allMessages = selectedConversationMessages(conversation);
  if (allMessages.length === 0) throw new Error("当前会话没有可压缩的消息");

  let messagesToCompress: Message[];
  let messagesToKeep: Message[];
  if (keepRecentMessages > 0 && allMessages.length > keepRecentMessages) {
    messagesToCompress = allMessages.slice(0, -keepRecentMessages);
    messagesToKeep = allMessages.slice(-keepRecentMessages);
  } else if (keepRecentMessages > 0) {
    throw new Error("消息数量不足，无法在保留最近消息的同时压缩历史");
  } else {
    messagesToCompress = allMessages;
    messagesToKeep = [];
  }

  const splitMessages = (messages: Message[]): Message[][] => {
    if (messages.length <= 256) return [messages];
    const mid = Math.floor(messages.length / 2);
    return [...splitMessages(messages.slice(0, mid)), ...splitMessages(messages.slice(mid))];
  };

  const chunks = splitMessages(messagesToCompress);
  const summaries: string[] = [];
  for (const chunk of chunks) {
    const prompt = applyPlaceholders(state.settings.compressPrompt || DEFAULT_COMPRESS_PROMPT, {
      content: chunk.map(summaryAsText).join("\n\n"),
      target_tokens: String(targetTokens),
      additional_context: additionalPrompt.trim() ? `Additional instructions from user: ${additionalPrompt.trim()}` : "",
      locale: localeDisplayName(),
    });
    summaries.push(cleanAuxiliaryText(await fetchAuxiliaryText(state.settings.compressModelId || state.settings.chatModelId, prompt, "compression", {
      stream: true,
      onDelta: (delta) => {
        if (!delta) return;
        conversation.chatSuggestions = [`正在压缩对话历史... ${Math.min(summaries.length + 1, chunks.length)}/${chunks.length}`];
        conversation.updateAt = Date.now();
        persistConversation(conversation);
        saveState();
        broadcastConversation(conversation);
      },
    })));
  }

  conversation.messages = [
    ...summaries.filter(Boolean).map((summary) => ({ id: id(), messages: [message("USER", [{ type: "text", text: summary }])], selectIndex: 0 })),
    ...messagesToKeep.map((msg) => ({ id: id(), messages: [JSON.parse(JSON.stringify(msg))], selectIndex: 0 })),
  ];
  conversation.truncateIndex = 0;
  conversation.chatSuggestions = [];
  conversation.updateAt = Date.now();
  persistConversation(conversation);
  saveState();
  broadcastConversation(conversation);
  return summaries;
}

export const generating = new Map<string, AbortController>();

function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

function completeConversationGeneration(conversationId: string, controller: AbortController) {
  if (generating.get(conversationId) !== controller) return;
  generating.delete(conversationId);
  // The generating Map drives the sidebar's per-conversation streaming indicator
  // (rendered via the conversations-list SSE). Now that broadcastNodeUpdateNow no
  // longer pings the list on every chunk (see comment at server.ts:1495), we have
  // to explicitly refresh on the false→true and true→false transitions so the
  // indicator turns on/off. Caller `generateAnswer` calls broadcastConversation
  // at start which already touches broadcastList, and we cover the end transition
  // right here.
  broadcastList();
  // 1.2.6:流式结束,全量 reconcile 活库——刷残余脏标记 + persistConversation,把流式
  // 期间增量 upsert 的节点和任何新增/删除的节点统一对齐(清孤立节点行)。幂等
  // (INSERT OR REPLACE 会话行 + 删旧节点 + 重插)。会话已被并发删除时跳过;flushConvDirty
  // 也会跳过已删会话的脏标记。
  flushConvDirtyNow();
  const conv = getConversation(conversationId);
  if (conv) persistConversation(conv);
}

function conversationStillExists(conversationId: string) {
  return state.conversations.some((item) => item.id === conversationId);
}

async function runPostGenerationTasks(conversationId: string, snapshot: Conversation, assistantMessageId: string) {
  const liveConversation = () => getConversation(conversationId);
  if (shouldAutoGenerateTitle(snapshot) && modelExists(state.settings.titleModelId)) {
    try {
      const title = await generateTitleForConversation(snapshot);
      const live = liveConversation();
      if (live && shouldAutoGenerateTitle(live)) {
        live.title = title;
        persistConversation(live);
        broadcastConversation(live);
      }
    } catch (titleError) {
      addLog({
        providerId: "",
        providerName: "RikkaHub PC",
        url: "conversation:title",
        ok: false,
        status: 0,
        kind: "aux:title",
        error: titleError instanceof Error ? titleError.message : String(titleError),
      });
      // Title generation failed → fall back to first user message text (Android parity).
      const live = liveConversation();
      if (live && shouldAutoGenerateTitle(live)) {
        const firstText = textFromParts(live.messages[0]?.messages[0]?.parts ?? []).trim();
        const fallback = limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation";
        live.title = fallback;
        persistConversation(live);
        broadcastConversation(live);
      }
    }
  } else if (shouldAutoGenerateTitle(snapshot)) {
    // No title model configured at all → still give it a sensible name from the first user message.
    const live = liveConversation();
    if (live && shouldAutoGenerateTitle(live)) {
      const firstText = textFromParts(live.messages[0]?.messages[0]?.parts ?? []).trim();
      const fallback = limitAuxiliaryText(firstText, TITLE_CHARACTER_LIMIT) || "New Conversation";
      if (fallback !== live.title) {
        live.title = fallback;
        persistConversation(live);
        broadcastConversation(live);
      }
    }
  }

  if (modelExists(state.settings.suggestionModelId)) {
    try {
      const suggestions = await generateSuggestionsForConversation(snapshot);
      const live = liveConversation();
      const lastNode = live?.messages[live.messages.length - 1];
      const lastMessage = lastNode?.messages[lastNode.selectIndex] ?? lastNode?.messages[0];
      if (live && lastMessage?.id === assistantMessageId && !generating.has(live.id)) {
        live.chatSuggestions = suggestions;
        live.updateAt = Date.now();
        persistConversation(live);
        broadcastConversation(live);
      }
    } catch {
      // Suggestions are auxiliary;正文生成状态不应受影响。
    }
  }
}

/** 纯生成逻辑：驱动 Provider 流式/非流式调用，并通过 sink 发出生成事件。
 *  本函数不直接写 state.json、不直接广播 SSE、不直接落盘 SQLite——这些副作用由
 *  协调器 generateAnswer 统一处理。 */
async function runGeneration(
  conversation: Conversation,
  assistantMessage: Message,
  assistantNode: MessageNode,
  deps: {
    assistant: Assistant;
    providerItem: Provider;
    selectedModel: Model;
    executeTool: ToolExecutor;
  },
  sink: GenerationEventSink,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  return callProviderStreaming(conversation, assistantMessage, assistantNode, {
    signal,
    sink,
    executeTool: deps.executeTool,
  });
}

export async function generateAnswer(conversation: Conversation, regenerateAtNodeId?: string) {
  const controller = new AbortController();
  generating.set(conversation.id, controller);
  const assistant = findAssistant(conversation.assistantId);
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // 重新生成 ASSISTANT:调用方已在该 node 追加空占位 message 并把 selectIndex 指向它,
  // 直接复用,绕开 ensureAssistantGenerationNode(它会复用末尾 assistant 或新建 node,
  // 都不是"在指定 node 上新增分支")。find 不到时安全回退到默认逻辑。
  let assistantNode: MessageNode;
  if (regenerateAtNodeId) {
    const found = conversation.messages.find((n) => n.id === regenerateAtNodeId);
    assistantNode = found ?? ensureAssistantGenerationNode(conversation, picked.model.id);
  } else {
    assistantNode = ensureAssistantGenerationNode(conversation, picked.model.id);
  }
  const currentMessage = assistantNode.messages[assistantNode.selectIndex];
  const resumingApprovedTools = hasResumableToolParts(currentMessage);
  currentMessage.finishedAt = null;
  // Allow createdAt to be re-stamped on the first content chunk of this generation pass —
  // supports regenerate, which reuses the same message object.
  streamStartedMessages.delete(currentMessage);
  if (!resumingApprovedTools) {
    // Show a loading placeholder immediately so the UI has visual feedback during the
    // upstream first-token wait. addStreamText / replaceLoadingReasoningWithTool will
    // strip this placeholder as soon as the first real delta arrives.
    setMessageLoading(currentMessage);
  }
  conversation.updateAt = Date.now();
  saveState();
  broadcastNodeUpdate(conversation, assistantNode);
  try {
    if (resumingApprovedTools) {
      await resumeApprovedToolParts(conversation, assistant, currentMessage, assistantNode, false);
    }
    // 工具执行闭包：把 server.ts 里的 executeToolCall 包装成 ToolExecutor 接口。
    // 这里保留对全局 state 的读写（如 saveToolBinaryContent），因为协调器仍然是唯一拥有
    // state 写权限的层；后续 Phase 会再把文件落盘拆到 files/ 模块。
    const executeTool: ToolExecutor = async (toolCall, context) => {
      const raw = await executeToolCall(toolCall, assistant, context);
      // ask_user / MCP 审批等 pending 状态直接作为单 part 返回，让协调器走暂停路径。
      if (isRecord(raw) && "pending" in raw) {
        return { output: [raw as JsonValue] };
      }
      const normalized = await toolResultToParts(raw);
      const output = await realizeToolResult(normalized);
      return { output };
    };
    const applyEvent = (event: GenerationEvent) => {
      const streamHooks: StreamHooks = { message: currentMessage, conversation, node: assistantNode };
      switch (event.kind) {
        case "text_delta":
          addStreamText(streamHooks, event.text);
          break;
        case "reasoning_delta":
          appendReasoningDelta(streamHooks as StreamHooksWithSink, event.text, event.metadata);
          break;
        case "image_delta":
          addStreamImage(streamHooks, event.url, event.metadata);
          break;
        case "tool_call_created":
          finishReasoningParts(currentMessage);
          replaceLoadingReasoningWithTool(currentMessage, {
            type: "tool",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            output: [],
            approvalState: event.approvalState,
          });
          touchStream(streamHooks as StreamHooksWithSink);
          break;
        case "tool_input_delta":
          currentMessage.parts = currentMessage.parts.map((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== event.toolCallId) return part;
            return { ...part, input: event.input };
          });
          touchStream(streamHooks as StreamHooksWithSink);
          break;
        case "tool_result":
          currentMessage.parts = currentMessage.parts.map((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== event.toolCallId) return part;
            return { ...part, output: event.output };
          });
          touchStream(streamHooks as StreamHooksWithSink);
          break;
        case "usage":
          currentMessage.usage = event.usage;
          break;
      }
    };
    const sink: GenerationEventSink = (event) => applyEvent(event);
    const content = await runGeneration(
      conversation,
      currentMessage,
      assistantNode,
      { assistant, providerItem: picked.provider, selectedModel: picked.model, executeTool },
      sink,
      controller.signal,
    );
    if (controller.signal.aborted) throw new DOMException("Generation stopped", "AbortError");
    applyOutputTransforms(currentMessage, assistant);
    finishReasoningParts(currentMessage);
    if (hasPendingToolApproval(currentMessage)) {
      currentMessage.finishedAt = null;
      ensureUsage(currentMessage, conversation);
      conversation.updateAt = Date.now();
      saveState();
      completeConversationGeneration(conversation.id, controller);
      broadcastNodeUpdate(conversation, assistantNode);
      broadcastConversation(conversation);
      return;
    }
    if (currentMessage.parts.length === 0) {
      finishMessage(currentMessage, [{ type: "text", text: content }]);
    } else {
      const hasText = textFromParts(currentMessage.parts).trim().length > 0;
      if (!hasText && content && content !== "(empty response)") {
        appendTextPart(currentMessage, content);
      }
      currentMessage.finishedAt = new Date().toISOString();
    }
    ensureUsage(currentMessage, conversation);
    conversation.updateAt = Date.now();
    saveState();
    completeConversationGeneration(conversation.id, controller);
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
    const snapshot = cloneConversation(conversation);
    void runPostGenerationTasks(conversation.id, snapshot, currentMessage.id);
  } catch (err) {
    if (!conversationStillExists(conversation.id)) {
      completeConversationGeneration(conversation.id, controller);
      return;
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      applyOutputTransforms(currentMessage, assistant);
      finishReasoningParts(currentMessage);
      currentMessage.finishedAt = new Date().toISOString();
      ensureUsage(currentMessage, conversation);
      conversation.updateAt = Date.now();
      saveState();
      completeConversationGeneration(conversation.id, controller);
      broadcastNodeUpdate(conversation, assistantNode);
      broadcastConversation(conversation);
      return;
    }
    const rawContent = err instanceof Error ? err.message : String(err);
    const proxyHint = classifyProxyError(err, state.settings.proxyConfig);
    const failureText = proxyHint ?? `请求失败：${rawContent}`;
    applyOutputTransforms(currentMessage, assistant);
    finishReasoningParts(currentMessage);
    if (currentMessage.parts.length === 0) {
      finishMessage(currentMessage, [{ type: "text", text: failureText }]);
    } else {
      appendTextPart(currentMessage, `\n\n${failureText}`);
      currentMessage.finishedAt = new Date().toISOString();
    }
    ensureUsage(currentMessage, conversation);
    conversation.updateAt = Date.now();
    saveState();
    completeConversationGeneration(conversation.id, controller);
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
  } finally {
    completeConversationGeneration(conversation.id, controller);
    if (!conversationStillExists(conversation.id)) return;
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
  }
}

function ensureAssistantGenerationNode(conversation: Conversation, modelId: string): MessageNode {
  const last = conversation.messages[conversation.messages.length - 1];
  if (last?.messages[last.selectIndex]?.role === "ASSISTANT") {
    const msg = last.messages[last.selectIndex];
    msg.modelId = modelId;
    if (hasToolParts(msg)) {
      return last;
    }
    return last;
  }
  const assistantNode: MessageNode = {
    id: id(),
    messages: [message("ASSISTANT", [], modelId)],
    selectIndex: 0,
  };
  conversation.messages.push(assistantNode);
  return assistantNode;
}
export function updateSettings(next: Settings) {
  // 代理配置变化时记一条日志。实际生效由 fetch 拦截器 per-request 现读 resolveEffectiveProxy 保证,
  // 无需手动刷新 env / 探测 —— 配置变化下一次请求自动跟上。
  const prevProxyUrl = resolveEffectiveProxy(state.settings.proxyConfig).url;
  state.settings = next;
  saveState();
  broadcastSettings();
  broadcastList();
  const newProxyUrl = resolveEffectiveProxy(state.settings.proxyConfig).url;
  if (newProxyUrl !== prevProxyUrl) {
    applyEffectiveProxy(state.settings.proxyConfig);
  }
}


// Tolerate both layouts: when run via `bun run server.ts`, argv[0..1] are bun + script;
// when run as a `bun build --compile` exe, argv[0] is the exe itself. `slice(1)` strips
// the leading process binary in both cases, leaving just user flags.
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

