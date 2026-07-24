// api/handlers/conversations.ts — 会话路由（stream、batch-delete、列表/分页/搜索、单会话子路由）
// 纪律：纯搬迁自 server.ts routeApi()；生成编排（generateAnswer 等）仍在 server.ts，经导入使用。

import type { Conversation, JsonValue, MessagePart } from "../../foundation/types";
import { applyPlaceholders, id, message, textFromParts } from "../../foundation/utils";
import { saveState, state } from "../../persistence/json-store";
import {
  getConversation,
  persistConversation,
  toConversationDto,
  toListDto,
  truncateConversationForRegenerate,
} from "../../conversations";
import { getConversationsDb, markConversationsLoaded } from "../../conversations";
import { searchMessageFts } from "../../conversations/fts";
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

  if (path === "conversations" && request.method === "GET") {
    return json(state.conversations.filter((item) => item.assistantId === state.settings.assistantId).map((item) => toListDto(item, generating.has(item.id))));
  }
  if (path === "conversations/paged" && request.method === "GET") {
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    const items = state.conversations
      .filter((item) => item.assistantId === state.settings.assistantId)
      .filter((item) => !query || item.title.toLowerCase().includes(query))
      .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updateAt - a.updateAt);
    const page = items.slice(offset, offset + limit);
    return json({ items: page.map((item) => toListDto(item, generating.has(item.id))), nextOffset: offset + limit < items.length ? offset + limit : null, hasMore: offset + limit < items.length });
  }
  if (path === "conversations/search" && request.method === "GET") {
    // P1-2：FTS5 trigram 索引查询（旧实现为全会话×全消息内存线性扫描，见 conversations/fts.ts）。
    // 流式期间内存领先活库最多 200ms（脏节点节流 flush），搜索"正在生成中的最后一句"可能
    // 晚 200ms 命中——可接受（搜索场景极少针对正在生成的内容）。
    const queryText = (url.searchParams.get("query") ?? "").trim();
    const db = getConversationsDb();
    if (!queryText || !db) return json([]);
    const byId = new Map(state.conversations.map((conversation) => [conversation.id, conversation]));
    const results = searchMessageFts(db, queryText)
      .flatMap((hit) => {
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
      const msg = conversation.messages.flatMap((node) => node.messages).find((item) => item.id === messageId);
      if (!msg) return error("Message not found", 404);
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
          msg.translation = await fetchAuxiliaryText(state.settings.translateModeId, prompt, "translation", {
            reasoningLevel: useQwenMt ? null : (state.settings.translateThinkingBudget ?? 0) > 0 ? "LOW" : null,
            temperature: useQwenMt ? 0.3 : null,
            topP: useQwenMt ? 0.95 : null,
            customBody: useQwenMt
              ? { translation_options: { source_lang: "auto", target_lang: englishLanguageName(targetLanguage) } }
              : undefined,
            stream: !useQwenMt,
            onDelta: (delta) => {
              streamedTranslation += delta;
              msg.translation = streamedTranslation || "正在翻译...";
              conversation.updateAt = Date.now();
              persistConversation(conversation);
              saveState();
              broadcastConversation(conversation);
            },
          });
        } catch (err) {
          msg.translation = `翻译失败：${err instanceof Error ? err.message : String(err)}`;
        } finally {
          conversation.updateAt = Date.now();
          saveState();
          broadcastConversation(conversation);
        }
      })();
      return json({ status: "accepted", translation: msg.translation }, { status: 202 });
    }
    if (sub === "compress" && request.method === "POST") {
      const body = await readJson<{ additionalPrompt?: string; targetTokens?: number; keepRecentMessages?: number }>(request);
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
      state.conversations.unshift(fork);
      markConversationsLoaded([fork.id]); // fork 树复制自内存源会话,内存即权威
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
  }
  return null;
}
