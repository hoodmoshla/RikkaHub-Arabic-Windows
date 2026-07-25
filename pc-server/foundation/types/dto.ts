// foundation/types/dto.ts — 线上契约 DTO 单一声明源(FE-P1-2 批2)。
// 权威即后端:形状尽量从领域模型派生(Omit 交叉),领域类型演进时 DTO 自动跟随;
// 与领域模型的有意分歧只有 Message.annotations/usage(领域层硬化收官前仍以 JsonValue
// 承载,线上契约在 DTO 层收窄为真实产出形状),显式写在 Omit 里。
// 前端 web-ui/app/types/dto.ts 只做 type-only re-export;字段增删属冻结契约变更。

import type { Conversation, Message, MessageNode } from "./index";

// ── 消息级线上明细类型 ──────────────────────────────────────────────

/** 搜索工具产出的 url_citation 注释(search/index.ts 从 provider 响应过滤后写入)。 */
export type UrlCitationAnnotation = {
  type: "url_citation";
  title: string;
  url: string;
};

/** 注释判别联合(对齐安卓 UIMessageAnnotation;当前仅 url_citation 一种)。 */
export type UIMessageAnnotation = UrlCitationAnnotation;

/** token 用量:inference-engine 三家 provider 归一化后的统一形状(appendUsageFromRaw 等)。 */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** 模型最大上下文窗口(models.dev 目录查得);null = 未知/无匹配,缺省 = 尚未回填。 */
  contextLimit?: number | null;
};

// ── 会话/消息 DTO ──────────────────────────────────────────────────

/** 消息线上形状 = 领域 Message 原样出线,仅 annotations/usage 收窄(见文件头)。 */
export type MessageDto = Omit<Message, "annotations" | "usage"> & {
  annotations: UIMessageAnnotation[];
  usage: TokenUsage | null;
};

export type MessageNodeDto = Omit<MessageNode, "messages"> & {
  messages: MessageDto[];
};

/** 会话详情:GET conversations/:id 响应与会话 SSE snapshot 载荷。 */
export type ConversationDto = Omit<Conversation, "messages"> & {
  messages: MessageNodeDto[];
  isGenerating: boolean;
};

/** 会话列表项:conversations 与 conversations/paged 的元素(toListDto 产出)。 */
export type ConversationListDto = {
  id: string;
  assistantId: string;
  title: string;
  isPinned: boolean;
  createAt: number;
  updateAt: number;
  isGenerating: boolean;
};

/** conversations/paged 响应包装。 */
export type PagedResult<T> = {
  items: T[];
  nextOffset?: number | null;
  hasMore: boolean;
};

/** conversations/search 响应元素(FTS 命中;snippet 用 [] 包裹匹配片段)。 */
export type MessageSearchResultDto = {
  nodeId: string;
  messageId: string;
  conversationId: string;
  title: string;
  updateAt: number;
  snippet: string;
};

// ── 文件上传 DTO ───────────────────────────────────────────────────

/** files/upload 响应元素。 */
export type UploadedFileDto = {
  id: number;
  url: string;
  fileName: string;
  mime: string;
  size: number;
  /** 服务端抽取出的正文长度(旧前端 DTO 未声明,实际线上一直存在)。 */
  extractedTextLength: number;
};

export type UploadFilesResponseDto = {
  files: UploadedFileDto[];
};

// ── 应用错误通道(P2-1) ─────────────────────────────────────────────

/** 严重度:error=用户必须知道(toast),warn=可感知降级,info=仅进错误中心。 */
export type AppErrorSeverity = "info" | "warn" | "error";

/** 错误所属域(决定用户视角的归因文案与错误中心分组)。 */
export type AppErrorDomain =
  | "provider"
  | "persistence"
  | "backup"
  | "network"
  | "tool"
  | "media"
  | "update"
  | "internal";

/** 应用级错误条目:errors/recent 快照元素与 errors/stream SSE 载荷。 */
export type AppErrorDto = {
  id: string;
  /** 最近一次发生时间(风暴合并时更新)。 */
  at: number;
  /** 30s 窗口内同 domain+message 的合并计数。 */
  count: number;
  severity: AppErrorSeverity;
  domain: AppErrorDomain;
  message: string;
  detail?: string;
};

// ── SSE 事件载荷 ───────────────────────────────────────────────────

/** 会话列表 SSE:invalidate 事件(前端收到后重拉列表)。 */
export type ConversationListInvalidateEventDto = {
  type: "invalidate";
  assistantId: string;
  timestamp: number;
};

/** 会话详情 SSE:全量快照事件。 */
export type ConversationSnapshotEventDto = {
  type: "snapshot";
  seq: number;
  conversation: ConversationDto;
  serverTime: number;
};

/** 会话详情 SSE:流式期间的单节点增量事件(携带完整增长中的节点)。 */
export type ConversationNodeUpdateEventDto = {
  type: "node_update";
  seq: number;
  conversationId: string;
  nodeId: string;
  nodeIndex: number;
  node: MessageNodeDto;
  updateAt: number;
  isGenerating: boolean;
  serverTime: number;
};

/** 会话详情 SSE:错误事件。 */
export type ConversationErrorEventDto = {
  type: "error";
  message: string;
};
