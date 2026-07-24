// api/sse.ts — SSE 基础设施（客户端集合、事件帧、33ms 合并节流广播）
// 纪律：只负责 SSE 推送；不做持久化、不改会话数据。
// 临时耦合：generating Map 仍从 ../server 导入（生成控制归属待 api/handlers 拆分时收敛）。

import type { Conversation, JsonValue, MessageNode } from "../foundation/types";
import { state } from "../persistence/json-store";
import { toConversationDto } from "../conversations";
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
  const payload = { type: "invalidate", assistantId: state.settings.assistantId, timestamp: Date.now() };
  for (const client of listClients) client.enqueue(sseFrame("invalidate", payload));
}

export function broadcastConversation(conversation: Conversation, event = "snapshot") {
  const payload = {
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
  const payload = {
    type: "node_update",
    seq: Date.now(),
    serverTime: Date.now(),
    conversationId: conversation.id,
    nodeId: node.id,
    nodeIndex: conversation.messages.findIndex((item) => item.id === node.id),
    node,
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
