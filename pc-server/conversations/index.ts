// conversations/index.ts — 会话 SQLite 活库与持久化原语
// 纪律：负责 pc_conversation / pc_message_node 的读写、脏标记 flush、迁移灌库。
// 不处理 SSE 广播、不处理生成流程——那些留在 server.ts / api / inference-engine。

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import { conversationsDbPath, dataDir } from "../foundation/paths";
import { checkoutConversation, clearWorkingSet, configureWorkingSet, peekConversation, releaseConversation, removeConversations, startWorkingSetSweep } from "./working-set";
import { getConversationMeta } from "./read-queries";
import { generating } from "./generation-state";
import type { Conversation, ConversationDto, ConversationListDto, Message, MessageNode, MessageNodeDto, PcConversationRow, PcMessageNodeRow } from "../foundation/types";
import { state } from "../persistence/json-store";
import { clearAllFts, deleteConversationFts, ensureMessageFtsTable, ftsRowCount, rebuildFtsFromNodeTable, replaceNodeFts } from "./fts";

export const DEFAULT_ASSISTANT_ID = "0950e2dc-9bd5-4801-afa3-aa887aa36b4e";

let conversationsDb: InstanceType<typeof Database> | null = null;

export function getConversationsDb(): InstanceType<typeof Database> | null {
  return conversationsDb;
}

/** 打开/创建会话活库并建表(幂等)。每次启动调一次,返回长连接。 */
export function openConversationsDb(): InstanceType<typeof Database> {
  mkdirSync(dataDir, { recursive: true });
  try {
    conversationsDb = openConversationsDbUnsafe();
    return conversationsDb;
  } catch (err) {
    // 活库损坏(杀软隔离 / 磁盘错误 / 非 SQLite 文件 / 旧版残留)。1.2.5 前无 DB 依赖、服务
    // 总能起来;1.2.6 不能因活库损坏让整个服务起不来。保留坏文件供事后取证,清旁文件,重建
    // 空库。后续恢复:未迁移过 → migrateConversationsIfNeeded 从 state.json(方案 A 保住的
    // 重试源)或 pre-sqlite.bak(方案 B)重新灌库;已迁移过 → 空库起步,坏文件已留存,用户
    // 可用 sqlite3 .recover 手动 salvage。不自动用 stale 的 .bak 覆盖(已迁移后会话已变动,
    // 回滚到迁移前会静默丢新增/复活已删,比空库更迷惑)。
    console.error("[conv-db] 活库打开/建表失败,尝试隔离坏文件并重建:", err);
    try {
      if (existsSync(conversationsDbPath)) {
        const corruptPath = `${conversationsDbPath}.corrupt-${Date.now()}`;
        try { renameSync(conversationsDbPath, corruptPath); }
        catch { /* 文件锁/权限:尽力而为,继续清旁文件重建 */ }
      }
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${conversationsDbPath}${suffix}`;
        if (existsSync(sidecar)) { try { unlinkSync(sidecar); } catch { /* best-effort */ } }
      }
      conversationsDb = openConversationsDbUnsafe();
      return conversationsDb;
    } catch (err2) {
      console.error("[conv-db] 重建活库仍失败,会话持久化不可用", err2);
      throw err2;
    }
  }
}

/** 实际打开 + PRAGMA + 建表。抛错时确保关闭句柄(Windows 文件锁),否则 rename 会失败。 */
function openConversationsDbUnsafe(): InstanceType<typeof Database> {
  const db = new Database(conversationsDbPath, { create: true, readwrite: true });
  try {
    // WAL:脏页进 -wal 旁文件,不重写主库——这是"增量写"的根本机制。
    // synchronous=NORMAL:WAL 下足够安全且更快(每次 commit 不强制 fsync)。
    // foreign_keys=ON:CASCADE 删除依赖它(删会话行自动带走其节点)。
    // busy_timeout:并发写竞争时等待而非立即报 SQLITE_BUSY。
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS pc_conversation (
        id              TEXT PRIMARY KEY NOT NULL,
        assistant_id    TEXT NOT NULL,
        title           TEXT NOT NULL DEFAULT '',
        system_prompt   TEXT NOT NULL DEFAULT '',
        truncate_index  INTEGER NOT NULL DEFAULT -1,
        suggestions     TEXT NOT NULL DEFAULT '[]',
        is_pinned       INTEGER NOT NULL DEFAULT 0,
        create_at       INTEGER NOT NULL,
        update_at       INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pc_message_node (
        id              TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        node_index      INTEGER NOT NULL,
        messages        TEXT NOT NULL DEFAULT '[]',
        select_index    INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (conversation_id) REFERENCES pc_conversation(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pc_msg_node_conv ON pc_message_node(conversation_id);
    `);
    ensureMessageFtsTable(db);
    // FTS 自愈重建：老库首次升级（表刚建、空）或索引意外丢失时，从节点表全量重建。
    // 幂等：行数>0 时零成本跳过。
    try {
      const nodeCount = (db.prepare("SELECT COUNT(*) AS n FROM pc_message_node").get() as { n: number }).n;
      if (nodeCount > 0 && ftsRowCount(db) === 0) {
        const rebuilt = rebuildFtsFromNodeTable(db);
        console.log(`[conv-db] 消息全文索引重建完成：${rebuilt} 个节点`);
      }
    } catch (ftsErr) {
      console.warn("[conv-db] FTS 重建失败（搜索降级为空结果，不影响会话读写）:", ftsErr);
    }
    return db;
  } catch (err) {
    try { db.close(); } catch { /* best-effort:句柄随 GC 释放 */ }
    throw err;
  }
}

// 会话列表顺序 = createAt 倒序:旧架构数组只在新建/fork 时 unshift(unshift 时刻
// createAt = Date.now(),从不 sort/reorder/push),数组顺序严格等价于 createAt 倒序。
// DB-first 用 ORDER BY create_at DESC, id DESC 保持该顺序(read-queries.ts 同)。
/** 读取全部会话元数据(不 parse 节点 JSON,messages 置空)。迁移/合并路径用。 */
export function loadConversationMetasFromDb(db: InstanceType<typeof Database>): Conversation[] {
  const convRows = db.prepare(
    "SELECT id, assistant_id, title, system_prompt, truncate_index, suggestions, is_pinned, create_at, update_at FROM pc_conversation ORDER BY create_at DESC, id DESC",
  ).all() as PcConversationRow[];
  return convRows.map((row) => ({
    id: row.id,
    assistantId: row.assistant_id,
    systemPrompt: row.system_prompt || null,
    title: row.title ?? "",
    messages: [],
    truncateIndex: typeof row.truncate_index === "number" ? row.truncate_index : -1,
    chatSuggestions: safeParseStringArray(row.suggestions),
    isPinned: row.is_pinned === 1,
    createAt: row.create_at,
    updateAt: row.update_at,
  }));
}

/** 读取单个会话的消息树(按 node_index 组装)。懒加载的按需读取原语。 */
export function loadConversationNodesFromDb(db: InstanceType<typeof Database>, conversationId: string): MessageNode[] {
  const nodeRows = db.prepare(
    "SELECT id, node_index, messages, select_index FROM pc_message_node WHERE conversation_id = ? ORDER BY node_index ASC",
  ).all(conversationId) as PcMessageNodeRow[];
  return nodeRows.map((nr) => ({
    id: nr.id,
    messages: safeParseMessageArray(nr.messages),
    selectIndex: nr.select_index ?? 0,
  }));
}

/** 读取全部会话(会话行 + 各自节点),组装成内存 Conversation[]。迁移校验/回退路径用。 */
export function loadAllConversationsFromDb(db: InstanceType<typeof Database>): Conversation[] {
  const conversations = loadConversationMetasFromDb(db);
  for (const conv of conversations) conv.messages = loadConversationNodesFromDb(db, conv.id);
  return conversations;
}

// ----- DB-first:会话运行时权威 = 活库 + working set -----
//
// 数据角色终局:SQLite 活库 = 唯一持久权威,读路径直查(WAL 下亚毫秒,页缓存即热缓存);
// 内存只保留"正在被使用"的会话实例,由 working-set.ts 单一权威实例注册表管理
// (checkout/release 引用计数 + sweep 四条件清扫);state.json 不再涉会话。
// 写路径不变:脏标记 200ms 节流 flush + persistConversation 全量落库。

/** working set 的加载器:活库读元数据行 + 消息树,组装完整 Conversation。 */
function loadConversationForWorkingSet(convId: string): Conversation | undefined {
  if (!conversationsDb) return undefined;
  try {
    const meta = getConversationMeta(conversationsDb, convId);
    if (!meta) return undefined;
    meta.messages = loadConversationNodesFromDb(conversationsDb, convId);
    return meta;
  } catch (err) {
    console.warn("[conv-db] working set 加载会话失败", convId, err);
    return undefined;
  }
}

/** 该会话是否有未落库的脏标记(sweep 判据之一;脏集合毫秒级清空,遍历成本可忽略)。 */
function hasConvDirtyState(convId: string): boolean {
  if (dirtyConversationIds.has(convId)) return true;
  const prefix = convId + "::";
  for (const key of dirtyNodeKeys) if (key.startsWith(prefix)) return true;
  return false;
}

// 默认 guards(单测/工具脚本直接 import 本模块时即可用);api/sse.ts 加载时经
// initWorkingSetSseGuard 注入真实的 SSE 客户端判据(避免 index→sse→index 循环导入)。
let hasSseClientsGuard: (convId: string) => boolean = () => false;

export function initWorkingSetSseGuard(hasSseClients: (convId: string) => boolean): void {
  hasSseClientsGuard = hasSseClients;
}

configureWorkingSet({
  loadConversation: loadConversationForWorkingSet,
  isGenerating: (convId) => generating.has(convId),
  hasSseClients: (convId) => hasSseClientsGuard(convId),
  hasDirty: hasConvDirtyState,
});
startWorkingSetSweep();

/** 标题兜底专用:取第一个节点的第一条消息 parts。working set 命中读实例(含未 flush
 *  的最新数据),否则只读活库单行,不触发整树加载、不驻留。 */
export function peekFirstMessageParts(convId: string): Message["parts"] {
  const held = peekConversation(convId);
  if (held) return held.messages[0]?.messages[0]?.parts ?? [];
  if (!conversationsDb) return [];
  try {
    const row = conversationsDb.prepare(
      "SELECT messages FROM pc_message_node WHERE conversation_id = ? AND node_index = 0",
    ).get(convId) as { messages: string } | null;
    if (!row) return [];
    return safeParseMessageArray(row.messages)[0]?.parts ?? [];
  } catch {
    return [];
  }
}

function safeParseMessageArray(raw: string): Message[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
}
function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/** upsert 单个会话行(不含节点)。流式中 updateAt/title 变化、以及全量 reconcile 复用。 */
export function upsertConversationRow(conv: Conversation): void {
  if (!conversationsDb) throw new Error("conversationsDb not open");
  conversationsDb.prepare(
    "INSERT OR REPLACE INTO pc_conversation (id, assistant_id, title, system_prompt, truncate_index, suggestions, is_pinned, create_at, update_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    conv.id,
    conv.assistantId || DEFAULT_ASSISTANT_ID,
    conv.title || "",
    conv.systemPrompt ?? "",
    typeof conv.truncateIndex === "number" ? conv.truncateIndex : -1,
    JSON.stringify(conv.chatSuggestions ?? []),
    conv.isPinned ? 1 : 0,
    conv.createAt || Date.now(),
    conv.updateAt || Date.now(),
  );
}

/** upsert 单个节点行(INSERT OR REPLACE)。流式热路径用,nodeIndex 由调用方提供。 */
export function upsertMessageNode(convId: string, node: MessageNode, nodeIndex: number): void {
  if (!conversationsDb) throw new Error("conversationsDb not open");
  conversationsDb.prepare(
    "INSERT OR REPLACE INTO pc_message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)",
  ).run(
    node.id,
    convId,
    nodeIndex,
    JSON.stringify(node.messages ?? []),
    node.selectIndex ?? 0,
  );
  try { replaceNodeFts(conversationsDb, convId, node); }
  catch (err) { console.warn("[conv-db] FTS 节点同步失败", node.id, err); }
}

/**
 * 全量 reconcile:事务内 upsert 会话行 + 删除该会话全部旧节点 + 按当前顺序重插。
 * 给非流式一次性变更用(改名/置顶/编辑/分叉/导入/流结束)。处理节点增删/重排,显而易见
 * 地正确;一次用户动作调一次,可承受。
 */
export function persistConversation(conv: Conversation): void {
  if (!conversationsDb) throw new Error("conversationsDb not open");
  const db = conversationsDb;
  const deleteNodes = db.prepare("DELETE FROM pc_message_node WHERE conversation_id = ?");
  const insertNode = db.prepare(
    "INSERT OR REPLACE INTO pc_message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)",
  );
  const txn = db.transaction(() => {
    upsertConversationRow(conv);
    deleteNodes.run(conv.id);
    deleteConversationFts(db, [conv.id]);
    for (let i = 0; i < (conv.messages ?? []).length; i += 1) {
      const node = conv.messages[i];
      if (!node?.id) continue;
      insertNode.run(node.id, conv.id, i, JSON.stringify(node.messages ?? []), node.selectIndex ?? 0);
      replaceNodeFts(db, conv.id, node);
    }
  });
  txn();
}

/** 删除会话(CASCADE 带走其节点行,依赖 foreign_keys=ON)。 */
export function deletePcConversations(ids: string[]): void {
  if (!conversationsDb || ids.length === 0) return;
  const stmt = conversationsDb.prepare("DELETE FROM pc_conversation WHERE id = ?");
  const db = conversationsDb;
  const txn = db.transaction(() => {
    for (const idValue of ids) stmt.run(idValue);
    deleteConversationFts(db, ids);
  });
  txn();
}

/** 会话总数。迁移校验/自测用。 */
export function countPcConversations(db: InstanceType<typeof Database>): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM pc_conversation").get() as { n: number } | null;
  return row?.n ?? 0;
}

// ----- 流式脏标记 + 节流 flush(仅会话活库用)-----
//
// 流式热路径不再走 scheduleThrottledSaveState(那会全量重写 state.json)。改成:每个 chunk
// 把"正在长的会话行 + 节点"标脏,200ms 合并后逐个 upsert 进活库。多路流式并发时,脏集合
// 累积各自 (convId, nodeId),flush 时从内存 state 算出正确 nodeIndex 逐行 upsert,SQLite
// WAL 自带写串行化。bun:sqlite 同步,但单行 upsert 亚毫秒,阻塞可忽略。

const dirtyConversationIds = new Set<string>();
const dirtyNodeKeys = new Set<string>(); // `${convId}::${nodeId}`
let pendingConvFlush: ReturnType<typeof setTimeout> | null = null;
let lastConvFlushMs = 0;
const CONV_FLUSH_INTERVAL_MS = 200;

export function markConversationRowDirty(convId: string): void {
  dirtyConversationIds.add(convId);
}
export function markMessageNodeDirty(convId: string, nodeId: string): void {
  dirtyNodeKeys.add(`${convId}::${nodeId}`);
}

/**
 * 遍历脏集合逐行 upsert,然后清空。从内存 state 解析 nodeIndex;若会话/节点已被并发删除
 * (如流式中删会话),跳过——避免 INSERT OR REPLACE 把已删的行又建回来。
 */
export function flushConvDirty(): void {
  if (!conversationsDb) return;
  lastConvFlushMs = Date.now();
  const convIds = Array.from(dirtyConversationIds);
  dirtyConversationIds.clear();
  const nodeKeys = Array.from(dirtyNodeKeys);
  dirtyNodeKeys.clear();
  for (const convId of convIds) {
    // 脏标记只可能来自 checkout 过的会话,working set 必命中;未命中 = 会话已被删除
    const conv = peekConversation(convId);
    if (!conv) continue;
    try {
      upsertConversationRow(conv);
    } catch (err) {
      console.warn("[conv-db] upsert conversation row failed", convId, err);
    }
  }
  for (const key of nodeKeys) {
    const sep = key.indexOf("::");
    if (sep < 0) continue;
    const convId = key.slice(0, sep);
    const nodeId = key.slice(sep + 2);
    const conv = peekConversation(convId);
    if (!conv) continue; // 删除正在流的会话竞态:会话已不在 working set,不重建行
    const idx = conv.messages.findIndex((n) => n.id === nodeId);
    if (idx < 0) continue; // 节点已被删除/替换
    try {
      upsertMessageNode(convId, conv.messages[idx], idx);
    } catch (err) {
      console.warn("[conv-db] upsert message node failed", convId, nodeId, err);
    }
  }
}

/** 200ms 节流合并(镜像 scheduleThrottledSaveState 的结构,但同步执行——单行 upsert 亚毫秒)。 */
export function scheduleThrottledConvFlush(): void {
  const now = Date.now();
  const elapsed = now - lastConvFlushMs;
  if (elapsed >= CONV_FLUSH_INTERVAL_MS) {
    if (pendingConvFlush) {
      clearTimeout(pendingConvFlush);
      pendingConvFlush = null;
    }
    flushConvDirty();
    return;
  }
  if (pendingConvFlush) return;
  pendingConvFlush = setTimeout(() => {
    pendingConvFlush = null;
    flushConvDirty();
  }, CONV_FLUSH_INTERVAL_MS - elapsed);
}

/** 立即 flush 并取消 pending 定时器。关停/流结束/导入前用。 */
export function flushConvDirtyNow(): void {
  if (pendingConvFlush) {
    clearTimeout(pendingConvFlush);
    pendingConvFlush = null;
  }
  flushConvDirty();
}

/** 清空脏标记集合与 pending 定时器(不 flush)。导入前中止所有流后调用,避免脏集合被 flush 到刚重灌的库。 */
export function clearConvDirtyState(): void {
  if (pendingConvFlush) {
    clearTimeout(pendingConvFlush);
    pendingConvFlush = null;
  }
  dirtyConversationIds.clear();
  dirtyNodeKeys.clear();
}

/**
 * 批量灌库(单事务)。比逐个 persistConversation 快(1 个事务 vs N 个)。迁移用。
 * INSERT OR REPLACE 幂等——中途失败重跑不重复/不冲突。
 */
export function migrateConversationsIntoDb(db: InstanceType<typeof Database>, conversations: Conversation[]): void {
  const upsertConv = db.prepare(
    "INSERT OR REPLACE INTO pc_conversation (id, assistant_id, title, system_prompt, truncate_index, suggestions, is_pinned, create_at, update_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertNode = db.prepare(
    "INSERT OR REPLACE INTO pc_message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)",
  );
  const txn = db.transaction(() => {
    for (const conv of conversations) {
      upsertConv.run(
        conv.id,
        conv.assistantId || DEFAULT_ASSISTANT_ID,
        conv.title || "",
        conv.systemPrompt ?? "",
        typeof conv.truncateIndex === "number" ? conv.truncateIndex : -1,
        JSON.stringify(conv.chatSuggestions ?? []),
        conv.isPinned ? 1 : 0,
        conv.createAt || Date.now(),
        conv.updateAt || Date.now(),
      );
      deleteConversationFts(db, [conv.id]);
      for (let i = 0; i < (conv.messages ?? []).length; i += 1) {
        const node = conv.messages[i];
        if (!node?.id) continue;
        insertNode.run(node.id, conv.id, i, JSON.stringify(node.messages ?? []), node.selectIndex ?? 0);
        replaceNodeFts(db, conv.id, node);
      }
    }
  });
  txn();
}

/** 重灌活库为给定会话集:删除所有会话行(CASCADE 带走节点)+ 单事务灌入。
 *  导入备份/bak 恢复用——导入流程把替换/合并结果统一灌回活库(权威)。 */
export function resetConversationsDbTo(conversations: Conversation[]): void {
  if (!conversationsDb) throw new Error("conversationsDb not open");
  const db = conversationsDb;
  const txn = db.transaction(() => {
    db.exec("DELETE FROM pc_conversation");
    clearAllFts(db);
    migrateConversationsIntoDb(db, conversations);
  });
  txn();
}

/** 关停前做一次 WAL checkpoint,让 -wal 数据回写主库。 */
export function checkpointConversationsDb(): void {
  conversationsDb?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** 按 id 取会话的权威实例(working set 命中或从活库装入)。
 *  checkout+立即 release:实例进注册表并刷新 lastAccess,60s 闲置宽限保证同步段安全;
 *  跨 await 修改会话的路径必须显式 checkout/release 持有引用(handlers 子路由块、
 *  generateAnswer),防 sweep 清出后另一处 checkout 装出第二实例并发互覆。 */
export function getConversation(idValue: string): Conversation | undefined {
  const conversation = checkoutConversation(idValue);
  if (conversation) releaseConversation(idValue);
  return conversation;
}

/** 领域 MessageNode → 线上 DTO。运行时同物零拷贝;领域 annotations/usage 在类型硬化
 *  收官前仍是 JsonValue,线上契约(foundation/types/dto.ts)已收窄为真实产出形状,
 *  这里是全工程唯一的显式窄化点。 */
export function toMessageNodeDtos(nodes: MessageNode[]): MessageNodeDto[] {
  return nodes as unknown as MessageNodeDto[];
}

/** 把 Conversation 转成含生成状态快照的 DTO。 */
export function toConversationDto(conversation: Conversation, isGenerating: boolean): ConversationDto {
  return { ...conversation, messages: toMessageNodeDtos(conversation.messages), isGenerating };
}

/** 把 Conversation 转成列表项 DTO。 */
export function toListDto(conversation: Conversation, isGenerating: boolean): ConversationListDto {
  return {
    id: conversation.id,
    assistantId: conversation.assistantId,
    title: conversation.title,
    isPinned: conversation.isPinned,
    createAt: conversation.createAt,
    updateAt: conversation.updateAt,
    isGenerating,
  };
}

/** 按当前 selectIndex 取出每个节点的有效 message。 */
export function selectedConversationMessages(conversation: Conversation): Message[] {
  return conversation.messages
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean);
}

/** 重新生成前截断会话消息:
 * - 无 messageId:删除末尾 ASSISTANT 节点。
 * - 有 messageId:若目标消息是 USER,保留到该节点(含);若是 ASSISTANT,保留到该节点(不含)。
 */
export function truncateConversationForRegenerate(conversation: Conversation, messageId?: string): void {
  if (!messageId) {
    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.messages[last.selectIndex]?.role === "ASSISTANT") conversation.messages.pop();
    return;
  }
  const nodeIndex = conversation.messages.findIndex((node) => node.messages.some((msg) => msg.id === messageId));
  if (nodeIndex < 0) return;
  const node = conversation.messages[nodeIndex];
  const msg = node.messages.find((item) => item.id === messageId);
  if (!msg) return;
  if (msg.role === "USER") {
    conversation.messages = conversation.messages.slice(0, nodeIndex + 1);
    return;
  }
  conversation.messages = conversation.messages.slice(0, nodeIndex);
}
