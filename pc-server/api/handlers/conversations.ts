// api/handlers/conversations.ts — 会话路由（stream、batch-delete、列表/分页/搜索、单会话子路由）
// 纪律：纯搬迁自 server.ts routeApi()；生成编排（generateAnswer 等）仍在 server.ts，经导入使用。

import type { Conversation, JsonValue, MessagePart } from "../../foundation/types";
import type { ConversationListDto, MessageSearchResultDto, PagedResult } from "../../foundation/types";
import { applyPlaceholders, id, message, textFromParts } from "../../foundation/utils";
import { saveState, state } from "../../persistence/json-store";
import {
  getConversation,
  nextTruncateIndex,
  persistConversation,
  toConversationDto,
  toListDto,
  truncateConversationForRegenerate,
} from "../../conversations";
import { getConversationsDb } from "../../conversations";
import { checkoutConversation, registerConversation, releaseConversation } from "../../conversations/working-set";
import { searchMessageFts } from "../../conversations/fts";
import { listConversationMetas } from "../../conversations/read-queries";
import { applyInputRegexTransformParts } from "../../assistants/index";
import { findModel } from "../../model-providers/index";
import { error, json, readJson } from "../request";
import {
  broadcastConversation,
  broadcastList,
  broadcastNodeUpdate,
  conversationClients,
  listClients,
  openSse,
} from "../sse";
import { bumpAnalyticsMsgCount } from "../../app-config/analytics";
import { DEFAULT_TRANSLATION_PROMPT } from "../../app-config/prompts";
import { attachOcrToImageParts, compressConversation, englishLanguageName, fetchAuxiliaryText, generateTitleForConversation, isQwenMtModel, markOcrPendingParts } from "../../conversations/auxiliary";
import { generateAnswer } from "../../conversations/orchestrator";
import { deleteConversationsById, ensureConversation, findAssistant, finishInterruptedPendingToolsInConversation, hasPendingToolApproval } from "../../conversations/helpers";
import { generating } from "../../conversations/generation-state";

export async function handleConversationRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  if (path === "conversations/stream") {
    return openSse(
      () => [["invalidate", { type: "invalidate", assistantId: state.settings.assistantId, timestamp: Date.now() }]],
      (controller) => {
        listClients.add(controller);
        return () => listClients.delete(controller);
      },
    );
  }

  if (path === "conversations/batch-delete" && request.method === "POST") {
    const body = await readJson<{ ids?: string[] }>(request);
    const ids = new Set((body.ids ?? []).map(String).filter(Boolean));
    if (ids.size === 0) return error("No conversations selected", 400);
    deleteConversationsById(ids);
    return json({ status: "deleted", deleted: ids.size });
  }

  // DB-first 批1:列表读直查活库元数据(SQL 只做 WHERE+基准排序,过滤/排序/分页留在 JS
  // 逐字复刻旧内存实现——SQLite lower()/LIKE 只处理 ASCII,与 JS toLowerCase 语义有差异)。
  // 流式期间 updateAt 最多滞后 200ms(脏标记节流),列表场景不可感知。db 不可用时降级空列表
  // (活库彻底损坏场景,会话功能整体不可用,与 search 端点既有降级一致)。
  if (path === "conversations" && request.method === "GET") {
    const db = getConversationsDb();
    const metas = db ? listConversationMetas(db, state.settings.assistantId) : [];
    return json(metas.map((item) => toListDto(item, generating.has(item.id))));
  }
  if (path === "conversations/paged" && request.method === "GET") {
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    const db = getConversationsDb();
    const items = (db ? listConversationMetas(db, state.settings.assistantId) : [])
      .filter((item) => !query || item.title.toLowerCase().includes(query))
      .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updateAt - a.updateAt);
    const page = items.slice(offset, offset + limit);
    const paged: PagedResult<ConversationListDto> = { items: page.map((item) => toListDto(item, generating.has(item.id))), nextOffset: offset + limit < items.length ? offset + limit : null, hasMore: offset + limit < items.length };
    return json(paged);
  }
  if (path === "conversations/search" && request.method === "GET") {
    // P1-2：FTS5 trigram 索引查询（旧实现为全会话×全消息内存线性扫描，见 conversations/fts.ts）。
    // 流式期间内存领先活库最多 200ms（脏节点节流 flush），搜索"正在生成中的最后一句"可能
    // 晚 200ms 命中——可接受（搜索场景极少针对正在生成的内容）。
    const queryText = (url.searchParams.get("query") ?? "").trim();
    const db = getConversationsDb();
    if (!queryText || !db) return json([]);
    // DB-first 批1:title/updateAt join 改用活库元数据(原为 state.conversations 内存 map)
    const byId = new Map(listConversationMetas(db, state.settings.assistantId).map((meta) => [meta.id, meta]));
    const results = searchMessageFts(db, queryText)
      .flatMap((hit): MessageSearchResultDto[] => {
        const conversation = byId.get(hit.conversationId);
        // 当前助手过滤（响应契约不变）；已删会话的残留命中防御性跳过
        if (!conversation || conversation.assistantId !== state.settings.assistantId) return [];
        return [{ nodeId: hit.nodeId, messageId: hit.messageId, conversationId: hit.conversationId, title: conversation.title, updateAt: conversation.updateAt, snippet: hit.snippet }];
      })
      .sort((a, b) => b.updateAt - a.updateAt);
    return json(results);
  }

  const conversationStream = path.match(/^conversations\/([^/]+)\/stream$/);
  if (conversationStream) {
    const conversation = getConversation(conversationStream[1]);
    if (!conversation) return error("Conversation not found", 404);
    return openSse(
      () => [["snapshot", { type: "snapshot", seq: Date.now(), conversation: toConversationDto(conversation, generating.has(conversation.id)), serverTime: Date.now() }]],
      (controller) => {
        const set = conversationClients.get(conversation.id) ?? new Set<ReadableStreamDefaultController<Uint8Array>>();
        set.add(controller);
        conversationClients.set(conversation.id, set);
        return () => set.delete(controller);
      },
    );
  }

  const conversationRoute = path.match(/^conversations\/([^/]+)(?:\/(.*))?$/);
  if (conversationRoute) {
    const conversationId = conversationRoute[1];
    const sub = conversationRoute[2] ?? "";

    if (!sub && request.method === "DELETE") {
      deleteConversationsById(new Set([conversationId]));
      return new Response(null, { status: 204 });
    }
    const conversation = (sub === "messages" || sub === "system-prompt") && request.method === "POST"
      ? ensureConversation(conversationId)
      : getConversation(conversationId);
    if (!conversation) return error("Conversation not found", 404);
    // DB-first:整个子路由块持有引用——translate/OCR 等长 await 期间实例不得被 sweep
    // 清出(否则另一请求 checkout 会装出第二实例,并发修改互相丢失)。try/finally 配对。
    checkoutConversation(conversation.id);
    try { // 块内 300+ 行保持原缩进(纯搬迁最小 diff),与结尾 } finally 配对

    if (!sub && request.method === "GET") return json(toConversationDto(conversation, generating.has(conversation.id)));
    if (sub === "messages" && request.method === "POST") {
      const body = await readJson<{ parts: JsonValue[] }>(request);
      const assistant = findAssistant(conversation.assistantId);
      const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
      // 用户在 ask_user 等待中直接发新消息时，旧 generation 可能还在跑（不太常
      // 见，因为 ask_user 通常会中止流并等待）也可能已经停了。无论如何先 abort
      // 旧 controller，避免后续 race；然后把上一条 ASSISTANT 残留的 pending 工具
      // 标记为"用户取消"，让历史回放时模型看到的是 denied tool 结果而不是空 output
      // ——对齐安卓 commit 05c12488 finishInterruptedPendingTools 的修复目标。
      generating.get(conversation.id)?.abort();
      generating.delete(conversation.id);
      finishInterruptedPendingToolsInConversation(conversation);
      const processedParts = applyInputRegexTransformParts((body.parts ?? []) as MessagePart[], assistant);
      const userMessage = message("USER", markOcrPendingParts(processedParts, picked.model));
      bumpAnalyticsMsgCount();
      const userNode = { id: id(), messages: [userMessage], selectIndex: 0 };
      conversation.messages.push(userNode);
      conversation.chatSuggestions = [];
      conversation.updateAt = Date.now();
      if (!conversation.title) conversation.title = "New Conversation";
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      void (async () => {
        userMessage.parts = await attachOcrToImageParts(userMessage.parts, picked.model);
        conversation.updateAt = Date.now();
        persistConversation(conversation);
        saveState();
        broadcastNodeUpdate(conversation, userNode);
        void generateAnswer(conversation);
      })();
      return json({ status: "accepted" }, { status: 202 });
    }
    if (sub === "pin" && request.method === "POST") {
      conversation.isPinned = !conversation.isPinned;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    // 产品决策①(2-2):"清除上下文"落地。对齐安卓切换语义:无显式 index 时,已截到
    // 末尾 → 撤销(-1),否则截到当前节点数(之前的历史不进上下文,编码侧 applyTruncateIndex
    // 消费)。body.index 显式指定(-1=撤销)供前端分割线点击恢复用。快照广播回流刷新分割线。
    if (sub === "truncate" && request.method === "POST") {
      const body = await readJson<{ index?: number }>(request);
      conversation.truncateIndex = nextTruncateIndex(conversation.truncateIndex, conversation.messages.length, body.index);
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated", truncateIndex: conversation.truncateIndex });
    }
    if (sub === "title" && request.method === "POST") {
      const body = await readJson<{ title: string }>(request);
      conversation.title = body.title?.trim() || conversation.title;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "move" && request.method === "POST") {
      const body = await readJson<{ assistantId: string }>(request);
      conversation.assistantId = body.assistantId;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "system-prompt" && request.method === "POST") {
      const body = await readJson<{ systemPrompt?: string }>(request);
      conversation.systemPrompt = String(body.systemPrompt ?? "").trim() || null;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    if (sub === "stop" && request.method === "POST") {
      // Abort the in-flight upstream fetch. Some providers take a moment to actually close the
      // socket after `controller.abort()` returns, so we proactively flush any throttled state
      // and broadcast immediately — the UI shouldn't have to wait for the next streaming chunk.
      const controller = generating.get(conversation.id);
      controller?.abort();
      generating.delete(conversation.id);
      // 与新消息入口对齐：用户主动停止时，也把残留的 pending tool 标记成"用户取消"，
      // 否则下次重生成/继续时会基于一条 output 为空的 pending tool 节点继续。
      // 对齐安卓 commit 05c12488 把 finishInterruptedPendingTools 同时用在新消息
      // 和 stopGenerating 两条路径上。
      finishInterruptedPendingToolsInConversation(conversation);
      const lastNode = conversation.messages[conversation.messages.length - 1];
      if (lastNode) {
        const msg = lastNode.messages[lastNode.selectIndex];
        if (msg) {
          // Strip the loading placeholder — otherwise the user sees the typing "..." linger
          // because the placeholder part rendering doesn't depend on isGenerating.
          msg.parts = msg.parts.filter((part) => !(
            part && typeof part === "object" && !Array.isArray(part) && part.type === "loading"
          ));
          if (!msg.finishedAt) msg.finishedAt = new Date().toISOString();
        }
        broadcastNodeUpdate(conversation, lastNode);
      }
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      return json({ status: "stopped" });
    }
    if (sub === "regenerate-title" && request.method === "POST") {
      try {
        conversation.title = await generateTitleForConversation(conversation);
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err), 400);
      }
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated", title: conversation.title });
    }
    if (sub === "regenerate" && request.method === "POST") {
      const body = await readJson<{ messageId?: string }>(request);
      // 2-1:对齐 send 入口——先中止进行中的旧流。否则 generateAnswer 的 generating.set
      // 直接顶掉旧 controller,旧流成为无主流:与新流同写一个节点,或对已摘除节点持续
      // touchStream 广播幽灵帧。UI 虽屏蔽流式中的按钮,但 API 层必须自带守卫。
      generating.get(conversation.id)?.abort();
      generating.delete(conversation.id);
      finishInterruptedPendingToolsInConversation(conversation);
      let regenerateAtNodeId: string | undefined;
      if (body.messageId) {
        const nodeIndex = conversation.messages.findIndex((n) =>
          n.messages.some((m) => m.id === body.messageId),
        );
        if (nodeIndex >= 0) {
          const targetNode = conversation.messages[nodeIndex];
          const targetMsg = targetNode.messages.find((m) => m.id === body.messageId);
          if (targetMsg?.role === "ASSISTANT") {
            // 对齐安卓 regenerateAtMessage:重新生成 ASSISTANT = 在原 node 追加新分支,
            // 旧回复保留(前端 < 2 / 2 > 切换器生效)。截断到该 node(含)丢弃其后所有 node,
            // 保证组装 API 历史时上下文 = [0..nodeIndex-1]——新空分支会被
            // appendAssistantApiMessages.flushAssistant 跳过,旧分支不在 selectIndex 不被取到,
            // 等价于安卓的 messageRange = 0..<nodeIndex;同时避免"新回复 + 旧后续脱节"。
            conversation.messages = conversation.messages.slice(0, nodeIndex + 1);
            const assistant = findAssistant(conversation.assistantId);
            const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
            const newMsg = message("ASSISTANT", [], picked.model.id);
            targetNode.messages.push(newMsg);
            targetNode.selectIndex = targetNode.messages.length - 1;
            regenerateAtNodeId = targetNode.id;
          } else {
            // USER 重新生成:截断到该 USER node(含),丢弃后续 assistant(行为不变)。
            truncateConversationForRegenerate(conversation, body.messageId);
          }
        } else {
          truncateConversationForRegenerate(conversation, body.messageId);
        }
      } else {
        truncateConversationForRegenerate(conversation, body.messageId);
      }
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      void generateAnswer(conversation, regenerateAtNodeId);
      return json({ status: "accepted" }, { status: 202 });
    }
    const nodeSelect = sub.match(/^nodes\/([^/]+)\/select$/);
    if (nodeSelect && request.method === "POST") {
      const body = await readJson<{ selectIndex?: number }>(request);
      const node = conversation.messages.find((item) => item.id === decodeURIComponent(nodeSelect[1]));
      if (!node) return error("Node not found", 404);
      const nextIndex = Number(body.selectIndex ?? node.selectIndex);
      if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= node.messages.length) return error("Invalid branch index", 400);
      node.selectIndex = nextIndex;
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      return json({ status: "updated" });
    }
    const messageDelete = sub.match(/^messages\/([^/]+)$/);
    if (messageDelete && request.method === "DELETE") {
      const messageId = decodeURIComponent(messageDelete[1]);
      let changed = false;
      conversation.messages = conversation.messages
        .map((node) => {
          const messages = node.messages.filter((msg) => msg.id !== messageId);
          if (messages.length !== node.messages.length) changed = true;
          return { ...node, messages, selectIndex: Math.min(node.selectIndex, Math.max(messages.length - 1, 0)) };
        })
        .filter((node) => node.messages.length > 0);
      if (!changed) return error("Message not found", 404);
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      return json({ status: "deleted" });
    }
    const messageEdit = sub.match(/^messages\/([^/]+)\/edit$/);
    if (messageEdit && request.method === "POST") {
      const body = await readJson<{ parts?: JsonValue[] }>(request);
      // 2-1:对齐 send 入口——先中止进行中的旧流。否则 generateAnswer 的 generating.set
      // 直接顶掉旧 controller,旧流成为无主流:与新流同写一个节点,或对已摘除节点持续
      // touchStream 广播幽灵帧。UI 虽屏蔽流式中的按钮,但 API 层必须自带守卫。
      generating.get(conversation.id)?.abort();
      generating.delete(conversation.id);
      finishInterruptedPendingToolsInConversation(conversation);
      const messageId = decodeURIComponent(messageEdit[1]);
      const nodeIndex = conversation.messages.findIndex((node) => node.messages.some((msg) => msg.id === messageId));
      if (nodeIndex < 0) return error("Message not found", 404);
      const node = conversation.messages[nodeIndex];
      const msgIndex = node.messages.findIndex((msg) => msg.id === messageId);
      const msg = node.messages[msgIndex];
      const assistant = findAssistant(conversation.assistantId);
      const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
      // 边界断言：body.parts 来自前端，契约即 UIMessagePart[]
      const editedParts = msg.role === "USER"
        ? applyInputRegexTransformParts((body.parts ?? msg.parts) as MessagePart[], assistant)
        : (body.parts ?? msg.parts) as MessagePart[];
      msg.parts = markOcrPendingParts(editedParts, picked.model);
      msg.translation = null;
      msg.finishedAt = msg.role === "ASSISTANT" ? new Date().toISOString() : null;
      node.selectIndex = msgIndex;
      conversation.messages = conversation.messages.slice(0, nodeIndex + 1);
      conversation.chatSuggestions = [];
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      if (msg.role === "USER") {
        void (async () => {
          msg.parts = await attachOcrToImageParts(msg.parts, picked.model);
          conversation.updateAt = Date.now();
          persistConversation(conversation);
          saveState();
          broadcastNodeUpdate(conversation, node);
          void generateAnswer(conversation);
        })();
      }
      return json({ status: "updated" }, { status: msg.role === "USER" ? 202 : 200 });
    }
    const messageTranslate = sub.match(/^messages\/([^/]+)\/translate$/);
    if (messageTranslate && request.method === "POST") {
      const body = await readJson<{ targetLanguage?: string }>(request).catch(() => ({ targetLanguage: "" }));
      const messageId = decodeURIComponent(messageTranslate[1]);
      const node = conversation.messages.find((n) => n.messages.some((item) => item.id === messageId));
      const msg = node?.messages.find((item) => item.id === messageId);
      if (!node || !msg) return error("Message not found", 404);
      const sourceText = textFromParts(msg.parts).trim();
      if (!sourceText) return error("Message has no text to translate", 400);
      const targetLanguage = String(body.targetLanguage ?? "").trim() || Intl.DateTimeFormat().resolvedOptions().locale;
      msg.translation = "正在翻译...";
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      void (async () => {
        try {
          const pickedTranslationModel = findModel(state.settings.translateModeId || state.settings.chatModelId);
          const useQwenMt = isQwenMtModel(pickedTranslationModel.model.modelId);
          const prompt = useQwenMt
            ? sourceText
            : applyPlaceholders(state.settings.translatePrompt || DEFAULT_TRANSLATION_PROMPT, {
                source_text: sourceText,
                target_lang: targetLanguage,
              });
          let streamedTranslation = "";
          let lastNodeBroadcastAt = 0;
          msg.translation = await fetchAuxiliaryText(state.settings.translateModeId, prompt, "translation", {
            reasoningLevel: useQwenMt ? null : (state.settings.translateThinkingBudget ?? 0) > 0 ? "LOW" : null,
            temperature: useQwenMt ? 0.3 : null,
            topP: useQwenMt ? 0.95 : null,
            customBody: useQwenMt
              ? { translation_options: { source_lang: "auto", target_lang: englishLanguageName(targetLanguage) } }
              : undefined,
            stream: !useQwenMt,
            // 2-3:onDelta 只改内存 + 33ms 节流的单节点广播。原先每个 token 都
            // persistConversation(全表删插)+saveState(全量序列化)+broadcastConversation
            // (全量快照帧),长会话流式翻译=每秒几十次全表重写,事件循环被持续占用。
            onDelta: (delta) => {
              streamedTranslation += delta;
              msg.translation = streamedTranslation || "正在翻译...";
              const now = Date.now();
              if (now - lastNodeBroadcastAt >= 33) {
                lastNodeBroadcastAt = now;
                broadcastNodeUpdate(conversation, node);
              }
            },
          });
        } catch (err) {
          msg.translation = `翻译失败：${err instanceof Error ? err.message : String(err)}`;
        } finally {
          // 2-3:落库收口到 finally 一次。同时修复原缺陷:非流式路径(Qwen-MT)与失败
          // 路径的 translation 从未 persistConversation,重启即丢。
          conversation.updateAt = Date.now();
          persistConversation(conversation);
          saveState();
          broadcastConversation(conversation);
        }
      })();
      return json({ status: "accepted", translation: msg.translation }, { status: 202 });
    }
    if (sub === "compress" && request.method === "POST") {
      const body = await readJson<{ additionalPrompt?: string; targetTokens?: number; keepRecentMessages?: number }>(request);
      // 2-1:对齐 send 入口——先中止进行中的旧流。否则 generateAnswer 的 generating.set
      // 直接顶掉旧 controller,旧流成为无主流:与新流同写一个节点,或对已摘除节点持续
      // touchStream 广播幽灵帧。UI 虽屏蔽流式中的按钮,但 API 层必须自带守卫。
      generating.get(conversation.id)?.abort();
      generating.delete(conversation.id);
      finishInterruptedPendingToolsInConversation(conversation);
      try {
        const summaries = await compressConversation(
          conversation,
          String(body.additionalPrompt ?? ""),
          Math.max(256, Number(body.targetTokens ?? 2000) || 2000),
          Math.max(0, Number(body.keepRecentMessages ?? 32) || 0),
        );
        return json({ status: "compressed", summaries });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err), 400);
      }
    }
    if (sub === "fork" && request.method === "POST") {
      const body = await readJson<{ messageId?: string }>(request);
      const messageId = String(body.messageId ?? "");
      const nodeIndex = conversation.messages.findIndex((node) => node.messages.some((msg) => msg.id === messageId));
      if (nodeIndex < 0) return error("Message not found", 404);
      const fork: Conversation = {
        ...JSON.parse(JSON.stringify(conversation)),
        id: id(),
        title: conversation.title ? `${conversation.title} Fork` : "Fork",
        messages: JSON.parse(JSON.stringify(conversation.messages.slice(0, nodeIndex + 1))),
        isPinned: false,
        createAt: Date.now(),
        updateAt: Date.now(),
      };
      registerConversation(fork); // fork 树复制自内存源会话,内存即权威
      persistConversation(fork);
      saveState();
      broadcastList();
      return json({ conversationId: fork.id });
    }
    if (sub === "tool-approval" && request.method === "POST") {
      const body = await readJson<{ toolCallId?: string; approved?: boolean; reason?: string; answer?: string }>(request);
      let changed = false;
      for (const node of conversation.messages) {
        for (const msg of node.messages) {
          msg.parts = msg.parts.map((part) => {
            if (!part || typeof part !== "object" || Array.isArray(part) || part.type !== "tool" || part.toolCallId !== body.toolCallId) return part;
            changed = true;
            return {
              ...part,
              approvalState: body.approved
                ? { type: body.answer ? "answered" : "approved", answer: body.answer ?? "" }
                : { type: "denied", reason: body.reason ?? "" },
            };
          });
        }
      }
      if (!changed) return error("Tool call not found", 404);
      conversation.updateAt = Date.now();
      persistConversation(conversation);
      saveState();
      broadcastConversation(conversation);
      const hasPendingTools = conversation.messages.some((node) =>
        node.messages.some((msg) => hasPendingToolApproval(msg))
      );
      if (!hasPendingTools) {
        void generateAnswer(conversation);
        return json({ status: "accepted" }, { status: 202 });
      }
      return json({ status: "updated" });
    }
    } finally {
      releaseConversation(conversation.id);
    }
  }
  return null;
}
