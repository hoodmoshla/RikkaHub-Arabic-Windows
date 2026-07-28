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

/** R7-2:模型调用失败的结构化标记(orchestrator catch 落在失败消息上)。前端错误横幅
 *  由它驱动,取代对正文的关键词正则匹配(正常讨论 HTTP 状态码/超时的内容不再误报)。 */
export type ModelCallErrorAnnotation = {
  type: "model_call_error";
  message: string;
};

/** 注释判别联合(对齐安卓 UIMessageAnnotation)。 */
export type UIMessageAnnotation = UrlCitationAnnotation | ModelCallErrorAnnotation;

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

/** 会话详情:GET conversations/:id 响应与会话 SSE snapshot 载荷。
 *  I-2(专题2)窗口化:快照可能只携带最近若干节点,messages[0] 的绝对节点下标为
 *  nodesOffset(缺省/0 = 从头完整);nodeStamps 为**全部**节点的内容戳清单(与绝对
 *  下标对齐),客户端据此对已加载的更早节点做可验证前缀合并。语义见
 *  api/snapshot-window.ts。 */
export type ConversationDto = Omit<Conversation, "messages"> & {
  messages: MessageNodeDto[];
  isGenerating: boolean;
  nodesOffset?: number;
  nodeStamps?: string[];
};

/** GET conversations/:id/nodes 响应:窗口化快照的向上翻页分片(专题2 I-2)。
 *  nodes 为绝对下标 [offset, offset+nodes.length) 的连续节点,stamps 一一对应。 */
export type ConversationNodesPageDto = {
  nodes: MessageNodeDto[];
  stamps: string[];
  offset: number;
  updateAt: number;
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

/** errors/stream SSE:连接快照(前端只入 store 不弹 toast)。 */
export type AppErrorSnapshotEventDto = {
  type: "snapshot";
  errors: AppErrorDto[];
};

/** errors/stream SSE:增量条目(前端按 severity 路由 toast)。 */
export type AppErrorPushEventDto = {
  type: "app_error";
  error: AppErrorDto;
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
  /** 快照协商令牌(专题2 I-1):客户端重开流时经 ?token= 原样回传,不解释内容。 */
  negotiationToken: string;
};

/** 会话详情 SSE:协商命中时的轻量首帧(专题2 I-1)——客户端缓存与服务端一致,
 *  不重发全量快照,只确认订阅建立与当前生成状态。 */
export type ConversationSnapshotMetaEventDto = {
  type: "snapshot_meta";
  seq: number;
  conversationId: string;
  updateAt: number;
  isGenerating: boolean;
  negotiationToken: string;
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
  /** 该节点的内容戳(I-2):客户端同步进 nodeStamps 清单,窗口化合并的比对依据。 */
  stamp: string;
  updateAt: number;
  isGenerating: boolean;
  serverTime: number;
};

/** 会话详情 SSE:流式纯文本增量帧(专题2 H-b)。
 *  仅当被选 message 相对上一帧只有 text/reasoning 的前缀增长时发出;任何结构变化
 *  (part 增删/类型变/工具输入输出/message 增删/selectIndex)走全量 node_update 关键帧。
 *  客户端以 baseLen 自校验:本地该字段长度必须落在 [baseLen, baseLen+text.length]
 *  (快照可能已含部分增量),否则视为分叉,重订阅拿快照。 */
export type ConversationTextDeltaEventDto = {
  type: "text_delta";
  seq: number;
  conversationId: string;
  nodeId: string;
  /** 增量目标 message(节点内按 id 定位,不猜 index)。 */
  messageId: string;
  deltas: Array<{ partIndex: number; baseLen: number; text: string }>;
  updateAt: number;
  isGenerating: boolean;
  serverTime: number;
};

/** 会话详情 SSE:错误事件。 */
export type ConversationErrorEventDto = {
  type: "error";
  message: string;
};
