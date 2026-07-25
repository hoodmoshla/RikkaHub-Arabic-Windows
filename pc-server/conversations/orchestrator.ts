// conversations/orchestrator.ts — 会话生成编排（Provider 分发、流式工具循环挂接、生成主链路与收尾任务）
// 纪律：纯搬迁自 server.ts（阶段 5.3g），行为不变。推理引擎经 GenerationEvent sink 与本层解耦。

import type { ApiMessage, Assistant, Conversation, JsonValue, Message, MessageNode, Model, Provider, StreamHooks, ToolPendingOutput } from "../foundation/types";
import type { GenerationEvent, GenerationEventSink, StreamHooksWithSink, ToolCall, ToolExecutor, ToolResult } from "../inference-engine/events";
import { id, isRecord, message, textFromParts } from "../foundation/utils";
import { classifyProxyError } from "../foundation/net";
import { saveState, state } from "../persistence/json-store";
import { addLog } from "../api/logs";
import { broadcastConversation, broadcastList, broadcastNodeUpdate, touchStream } from "../api/sse";
import { applyCustomBody, applyRequestHeaders, findModel } from "../model-providers";
import { endpointFor } from "../model-providers/checks";
import {
  claudeCacheControlEphemeral,
  claudeMessagesFromApiMessages,
  claudeSystemContent,
  claudeThinkingPayload,
  claudeToolsFromOpenAiTools,
  hostOfProvider,
  isModelAllowTemperature,
  openAiChatCompletionsModalities,
  reasoningLevelNormalized,
  reasoningPayloadForProvider,
  responseApiBuiltInTools,
  responseApiIncludeForProvider,
  responseApiReasoningForProvider,
  supportsAbility,
} from "../inference-engine/message-builder";
import {
  buildGoogleRequestBody,
  conversationMessagesForApi,
  conversationResponseApiInput,
  conversationResponseApiInstructions,
} from "../inference-engine/conversation-encoding";
import {
  fetchClaudeTextWithTools,
  fetchOpenAiText,
  fetchOpenAiTextStreaming,
  fetchText,
  streamClaudeChatWithTools,
  streamGoogleChatWithTools,
} from "../inference-engine/providers";
import {
  addStreamImage,
  addStreamText,
  appendReasoningDelta,
  finishReasoningParts,
  replaceLoadingReasoningWithTool,
  setMessageLoading,
  streamStartedMessages,
} from "../inference-engine/parts";
import { apiToolCallFromPart, resolvedToolOutput, toolExecutionErrorPayload } from "../tools/format";
import { openAiLocalTools, openAiMcpTools, openAiSearchTools, openAiSkillTools } from "../tools/bound";
import { executeToolCall, realizeToolResult, toolResultToParts } from "../tools/execution";
import { applyOutputTransforms } from "../assistants";
import { TITLE_CHARACTER_LIMIT } from "../app-config/prompts";
import { flushConvDirtyNow, getConversation, getConversationsDb, markMessageNodeDirty, persistConversation, scheduleThrottledConvFlush } from "./index";
import { checkoutConversation, releaseConversation } from "./working-set";
import { conversationExistsInDb } from "./read-queries";
import { reportError } from "../observability/app-errors";
import { generating } from "./generation-state";
import {
  appendTextPart,
  canResumeToolExecution,
  ensureUsage,
  findAssistant,
  finishMessage,
  hasPendingToolApproval,
  hasResumableToolParts,
  hasToolParts,
  toolApprovalType,
} from "./helpers";
import { generateSuggestionsForConversation, generateTitleForConversation, limitAuxiliaryText, modelExists, shouldAutoGenerateTitle } from "./auxiliary";

/** 生成入口一次性解析的配置快照（P1-4）。流式生成横跨多个 await 点，用户中途改配置
 *  （换模型/改工具集/删助手）时，updateSettings 会整体替换 state.settings——持有入口
 *  时刻的引用即天然快照（旧对象不会被原地修改），保证同一次生成读到同一代配置。 */
export interface GenerationSnapshot {
  assistant: Assistant;
  provider: Provider;
  model: Model;
}

export async function callProvider(
  conversation: Conversation,
  signal?: AbortSignal,
  hooks?: StreamHooksWithSink,
  snapshot?: GenerationSnapshot,
) {
  const assistant = snapshot?.assistant ?? findAssistant(conversation.assistantId);
  const picked = snapshot
    ? { provider: snapshot.provider, model: snapshot.model }
    : findModel(assistant.chatModelId ?? state.settings.chatModelId);
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

export async function callProviderStreaming(
  conversation: Conversation,
  assistantMessage: Message,
  assistantNode: MessageNode,
  ctx: { signal?: AbortSignal; sink: GenerationEventSink; executeTool: ToolExecutor; snapshot?: GenerationSnapshot },
): Promise<string> {
  const assistant = ctx.snapshot?.assistant ?? findAssistant(conversation.assistantId);
  const picked = ctx.snapshot
    ? { provider: ctx.snapshot.provider, model: ctx.snapshot.model }
    : findModel(assistant.chatModelId ?? state.settings.chatModelId);
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
    // 把本函数已解析的快照透传，确保 claude/google 路径与 openai 路径读到同一代配置
    return callProvider(conversation, ctx.signal, hooks, { assistant, provider: picked.provider, model: picked.model });
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

export async function executeApprovedToolPart(part: Record<string, JsonValue>, assistant: Assistant) {
  const approvalType = toolApprovalType(part);
  if (approvalType === "answered") return String((part.approvalState as Record<string, JsonValue>)?.answer ?? "");
  if (approvalType === "denied") {
    const reason = String((part.approvalState as Record<string, JsonValue>)?.reason ?? "").trim() || "No reason provided";
    return { error: `Tool execution denied by user. Reason: ${reason}` };
  }
  return executeToolCall(apiToolCallFromPart(part), assistant);
}

export async function resumeApprovedToolParts(
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
  // DB-first 批1:直查活库。新建会话即时落库(ensureConversation 1.2.6 起),无漏检窗口。
  const db = getConversationsDb();
  return db ? conversationExistsInDb(db, conversationId) : false;
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
      reportError("provider", "warn", "标题自动生成失败,已回退首条消息文本", titleError);
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
    } catch (suggestionError) {
      // Suggestions are auxiliary;正文生成状态不应受影响。
      reportError("provider", "warn", "会话建议自动生成失败", suggestionError);
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
    // P1-4：generateAnswer 入口解析的 assistant/provider/model 贯穿本次生成，
    // callProviderStreaming 不再从可能已被替换的 state.settings 重新解析。
    snapshot: { assistant: deps.assistant, provider: deps.providerItem, model: deps.selectedModel },
  });
}

export async function generateAnswer(conversation: Conversation, regenerateAtNodeId?: string) {
  const controller = new AbortController();
  generating.set(conversation.id, controller);
  // DB-first:整个生成期持有引用(与 finally 的 release 恰好配对一次;
  // completeConversationGeneration 有多处幂等调用,release 不能放那里)。
  // generating 条件本身也挡 sweep,refs 是纵深防御(abort 后 generating 先被清的窗口)。
  checkoutConversation(conversation.id);
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
  // P1-3:四条出口路径(pending/done/aborted/failed)的共同收尾序列。差异只在 parts 与
  // finishedAt 处理,由 applyParts 注入。completeConversationGeneration 幂等,finally 兜底。
  const finalizeOutcome = (applyParts: () => void) => {
    applyOutputTransforms(currentMessage, assistant);
    finishReasoningParts(currentMessage);
    applyParts();
    ensureUsage(currentMessage, conversation);
    conversation.updateAt = Date.now();
    saveState();
    completeConversationGeneration(conversation.id, controller);
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
  };
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
      // ask_user / MCP 审批等 pending 状态直接作为单 output 载荷返回，让协调器走暂停路径。
      if (isRecord(raw) && "pending" in raw) {
        return { output: [raw as unknown as ToolPendingOutput] };
      }
      const normalized = await toolResultToParts(raw);
      const output = await realizeToolResult(normalized);
      return { output };
    };
    const applyEvent = (event: GenerationEvent) => {
      const streamHooks: StreamHooks = { message: currentMessage, conversation, node: assistantNode };
      switch (event.kind) {
        // 文本/思维链/图片增量写入内存后必须 touchStream(标脏 + 200ms 节流落库 + 33ms 节流
        // 广播),与下方三个 tool case 对齐。5.3g 搬迁时该调用曾丢失(收官审查 P0-2):无工具
        // 会话全程无增量帧、无增量落库,流式中崩溃丢整段回答。
        case "text_delta":
          addStreamText(streamHooks, event.text);
          touchStream(streamHooks as StreamHooksWithSink);
          break;
        case "reasoning_delta":
          appendReasoningDelta(streamHooks as StreamHooksWithSink, event.text, event.metadata);
          touchStream(streamHooks as StreamHooksWithSink);
          break;
        case "image_delta":
          addStreamImage(streamHooks, event.url, event.metadata);
          touchStream(streamHooks as StreamHooksWithSink);
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
    if (hasPendingToolApproval(currentMessage)) {
      // 注:hasPendingToolApproval 判定在 applyOutputTransforms 之前与旧实现一致——
      // 旧实现先 transform 再判定,但 transform 只改 text/reasoning parts,不触碰 tool
      // parts 的 approvalState,判定结果不受影响;两分支的 transform 都由 finalize 统一做。
      finalizeOutcome(() => {
        currentMessage.finishedAt = null;
      });
      return;
    }
    finalizeOutcome(() => {
      if (currentMessage.parts.length === 0) {
        finishMessage(currentMessage, [{ type: "text", text: content }]);
      } else {
        const hasText = textFromParts(currentMessage.parts).trim().length > 0;
        if (!hasText && content && content !== "(empty response)") {
          appendTextPart(currentMessage, content);
        }
        currentMessage.finishedAt = new Date().toISOString();
      }
    });
    const snapshot = cloneConversation(conversation);
    void runPostGenerationTasks(conversation.id, snapshot, currentMessage.id);
  } catch (err) {
    if (!conversationStillExists(conversation.id)) {
      completeConversationGeneration(conversation.id, controller);
      return;
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      finalizeOutcome(() => {
        currentMessage.finishedAt = new Date().toISOString();
      });
      return;
    }
    const rawContent = err instanceof Error ? err.message : String(err);
    const proxyHint = classifyProxyError(err, state.settings.proxyConfig);
    const failureText = proxyHint ?? `请求失败：${rawContent}`;
    // P2-1(N-7 归宿):失败文本除了写进会话消息(仅会话 SSE 可见),还上报全局通道——
    // 用户不在该会话页时也能收到通知(批2 接前端 toast)。
    reportError("provider", "error", failureText, err);
    finalizeOutcome(() => {
      if (currentMessage.parts.length === 0) {
        finishMessage(currentMessage, [{ type: "text", text: failureText }]);
      } else {
        appendTextPart(currentMessage, `\n\n${failureText}`);
        currentMessage.finishedAt = new Date().toISOString();
      }
    });
  } finally {
    releaseConversation(conversation.id);
    completeConversationGeneration(conversation.id, controller);
    if (!conversationStillExists(conversation.id)) return;
    broadcastNodeUpdate(conversation, assistantNode);
    broadcastConversation(conversation);
  }
}

export function ensureAssistantGenerationNode(conversation: Conversation, modelId: string): MessageNode {
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
  // 新节点立即标脏:节点创建到第一个 chunk 之间存在窗口,若此窗口内导出/统计(DB-first
  // 读活库)或进程崩溃,未标脏的节点不在任何落库计划里。标脏后 flushConvDirtyNow 可见,
  // 与旧"读内存必含该节点"行为对齐。
  markMessageNodeDirty(conversation.id, assistantNode.id);
  scheduleThrottledConvFlush();
  return assistantNode;
}

// Tolerate both layouts: when run via `bun run server.ts`, argv[0..1] are bun + script;
// when run as a `bun build --compile` exe, argv[0] is the exe itself. `slice(1)` strips
// the leading process binary in both cases, leaving just user flags.
