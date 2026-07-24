// conversations/stats.ts — 使用统计聚合（每日消息量/token/模型分布）
// 纪律：纯搬迁自 server.ts（阶段 5.3h），行为不变。

import type { DailyStat } from "../foundation/types";
import { dateKey, textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { flushConvDirtyNow, getConversationsDb, loadConversationNodesFromDb } from "./index";
import { listAllConversationMetas } from "./read-queries";

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

  // DB-first 批1:统计全走活库(先 flush 对齐脏数据,静息态与旧内存版逐字等价;
  // 流式期间仅"最后 200ms 内的增量"可能未计入,统计场景不可感知)。逐会话瞬时读,不驻留。
  flushConvDirtyNow();
  const statsDb = getConversationsDb();
  const statsMetas = statsDb ? listAllConversationMetas(statsDb) : [];
  for (const conversation of statsMetas) {
    const conversationDate = dateKey(conversation.createAt);
    const row = daily.get(conversationDate) ?? { date: conversationDate, messages: 0, conversations: 0, characters: 0 };
    row.conversations += 1;
    daily.set(conversationDate, row);

    const nodes = statsDb ? loadConversationNodesFromDb(statsDb, conversation.id) : [];
    for (const node of nodes) {
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
      conversations: statsMetas.length,
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
