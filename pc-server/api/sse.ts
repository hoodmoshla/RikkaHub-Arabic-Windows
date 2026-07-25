// api/sse.ts — SSE 基础设施（客户端集合、事件帧、33ms 合并节流广播）
// 纪律：只负责 SSE 推送；不做持久化、不改会话数据。
// 临时耦合：generating Map 仍从 ../server 导入（生成控制归属待 api/handlers 拆分时收敛）。

import type { StreamHooksWithSink } from "../inference-engine/events";
import { initWorkingSetSseGuard, markConversationRowDirty, markMessageNodeDirty, scheduleThrottledConvFlush } from "../conversations";
import { initAppErrorBroadcast } from "../observability/app-errors";
import type { Conversation, ConversationListInvalidateEventDto, ConversationNodeUpdateEventDto, ConversationSnapshotEventDto, JsonValue, MessageNode } from "../foundation/types";
import { state } from "../persistence/json-store";
import { toConversationDto, toMessageNodeDtos } from "../conversations";
import { memoryStore } from "../memory/index";
import { generating } from "../conversations/generation-state";

// Streaming clients receive a node_update per chunk. Since each update carries the full growing
// MessageNode (cumulative text), naive per-chunk broadcasts turn into O(N^2) bytes over SSE and
// browsers fall behind — the user sees "stuck then dump" instead of smooth streaming, and the stop
// button feels laggy because old events keep flushing. We coalesce broadcasts to ~30 fps while
// always flushing the final state at end-of-generation.
const STREAM_BROADCAST_INTERVAL_MS = 33;
const pendingBroadcasts = new Map<string, { conversation: Conversation; node: MessageNode; timer: ReturnType<typeof setTimeout> | null; lastFlush: number }>();
function flushNodeBroadcast(key: string) {
  const entry = pendingBroadcasts.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.lastFlush = Date.now();
  broadcastNodeUpdateNow(entry.conversation, entry.node);
}
export function scheduleNodeBroadcast(conversation: Conversation, node: MessageNode) {
  const key = `${conversation.id}::${node.id}`;
  const now = Date.now();
  const existing = pendingBroadcasts.get(key);
  if (!existing) {
    pendingBroadcasts.set(key, { conversation, node, timer: null, lastFlush: now });
    broadcastNodeUpdateNow(conversation, node);
    return;
  }
  // Always keep the freshest references — the node object identity can stay but the parts mutate.
  existing.conversation = conversation;
  existing.node = node;
  const elapsed = now - existing.lastFlush;
  if (elapsed >= STREAM_BROADCAST_INTERVAL_MS) {
    flushNodeBroadcast(key);
    return;
  }
  if (existing.timer) return;
  existing.timer = setTimeout(() => flushNodeBroadcast(key), STREAM_BROADCAST_INTERVAL_MS - elapsed);
}
function clearNodeBroadcast(conversation: Conversation, node: MessageNode) {
  const key = `${conversation.id}::${node.id}`;
  const entry = pendingBroadcasts.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingBroadcasts.delete(key);
}

export const settingsClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
export const listClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
export const conversationClients = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
// working set 的 SSE 驻留判据:某会话有打开的 SSE 流(用户界面正开着)时不清扫。
// 在此注入而非 conversations/index 直接 import,避免 index→sse→index 循环导入。
initWorkingSetSseGuard((convId) => (conversationClients.get(convId)?.size ?? 0) > 0);

// 应用错误通道(P2-1):errors/stream 订阅者集合 + 广播注入(通道模块不依赖 api 层)。
export const errorClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
initAppErrorBroadcast((entry) => {
  for (const client of errorClients) client.enqueue(sseFrame("app_error", { type: "app_error", error: entry }));
});
const encoder = new TextEncoder();

export function sseFrame(event: string, data: JsonValue | object) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function openSse(
  initial: () => Array<[string, JsonValue | object]>,
  register: (controller: ReadableStreamDefaultController<Uint8Array>) => () => void,
) {
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = register(controller);
      for (const [event, payload] of initial()) {
        controller.enqueue(sseFrame(event, payload));
      }
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
      cleanup = ((old) => () => {
        clearInterval(heartbeat);
        old();
      })(cleanup);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function broadcastSettings() {
  for (const client of settingsClients) client.enqueue(sseFrame("update", state.settings));
}

// memory SSE 通道(1.3.2):推送 MemorySnapshot 给前端记忆管理 UI + 待确认徽章。独立于
// settings SSE——记忆运行时数据(pending 队列)不属于配置,混在一起会让每次记忆变化触发
// 全量 settings 重渲染(§10.3)。触发时机:任何记忆增删改 / pending 入队/解决。
export const memoryClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

export function broadcastMemoryUpdate() {
  const snapshot = memoryStore.getSnapshot();
  for (const client of memoryClients) {
    try { client.enqueue(sseFrame("update", snapshot)); } catch { /* client gone */ }
  }
}

export function broadcastList() {
  const payload: ConversationListInvalidateEventDto = { type: "invalidate", assistantId: state.settings.assistantId, timestamp: Date.now() };
  for (const client of listClients) client.enqueue(sseFrame("invalidate", payload));
}

export function broadcastConversation(conversation: Conversation, event = "snapshot") {
  const payload: ConversationSnapshotEventDto = {
    type: "snapshot",
    seq: Date.now(),
    conversation: toConversationDto(conversation, generating.has(conversation.id)),
    serverTime: Date.now(),
  };
  for (const client of conversationClients.get(conversation.id) ?? []) {
    client.enqueue(sseFrame(event, payload));
  }
  broadcastList();
}

function broadcastNodeUpdateNow(conversation: Conversation, node: MessageNode) {
  const payload: ConversationNodeUpdateEventDto = {
    type: "node_update",
    seq: Date.now(),
    serverTime: Date.now(),
    conversationId: conversation.id,
    nodeId: node.id,
    nodeIndex: conversation.messages.findIndex((item) => item.id === node.id),
    node: toMessageNodeDtos([node])[0]!,
    updateAt: conversation.updateAt,
    isGenerating: generating.has(conversation.id),
  };
  for (const client of conversationClients.get(conversation.id) ?? []) {
    client.enqueue(sseFrame("node_update", payload));
  }
  // NOTE: deliberately NOT calling broadcastList() here. This used to fire on every chunk
  // during streaming (~30 times/sec via scheduleNodeBroadcast), which made the conversation
  // list SSE issue an `invalidate` event 30x/sec, which made the frontend re-fetch
  // `/api/conversations/p?offset=0&limit=30` 30x/sec. With Chrome's 6-connection-per-host
  // limit, that storm was rapidly exhausting the frontend's HTTP connection pool, queuing
  // any other request (including the conversation-detail GET) past ky's 30s timeout. That
  // matches the user-reported "even fresh conversations stall" + "list also times out"
  // pattern that the saveState-blocking fix alone couldn't explain.
  //
  // The conversation list only needs to refresh when the metadata it actually displays
  // changes (title, isPinned, isGenerating-state-transition, last-message-preview). Per-
  // chunk content updates don't change any of those. We now call broadcastList() at
  // generation start (server.ts:10358), generation end (server.ts:9601), and on explicit
  // mutations (rename, pin, delete) — not on every streamed chunk.
}

// Non-streaming call sites (final flush, tool approval, etc.) flush immediately so callers see
// the authoritative state without delay. Streaming hot paths go through scheduleNodeBroadcast.
export function broadcastNodeUpdate(conversation: Conversation, node: MessageNode) {
  clearNodeBroadcast(conversation, node);
  broadcastNodeUpdateNow(conversation, node);
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
