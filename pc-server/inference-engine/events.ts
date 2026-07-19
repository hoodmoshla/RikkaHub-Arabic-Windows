// inference-engine/events.ts — 生成事件流与工具执行接口
// 纪律：本文件只定义类型与回调契约，不写具体实现，避免被 server.ts 的细节污染。

import type { JsonValue, Message } from "../foundation/types";

/** 生成过程中产生的单个事件。协调器（generateAnswer）根据这些事件更新消息、
 *  持久化状态和广播 SSE；推理引擎本身不直接执行副作用。 */
export type GenerationEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "reasoning_delta"; text: string; metadata?: Record<string, JsonValue> }
  | { kind: "image_delta"; url: string; metadata?: Record<string, JsonValue> }
  | {
      kind: "tool_call_created";
      toolCallId: string;
      toolName: string;
      input: string;
      approvalState: JsonValue;
    }
  | { kind: "tool_input_delta"; toolCallId: string; input: string }
  | { kind: "tool_result"; toolCallId: string; output: JsonValue[] }
  | { kind: "usage"; usage: Message["usage"] }
  | { kind: "finished"; content: string; stopReason: string | null }
  | { kind: "error"; error: string }
  | { kind: "abort" };

/** 事件接收器。Provider 流式函数在解析到增量时调用它。 */
export type GenerationEventSink = (event: GenerationEvent) => void;

/** 与 Provider API 对齐的工具调用描述。 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** 传给工具执行的上下文信息，仅用于 tracing / 记忆来源。 */
export interface ToolContext {
  conversationId?: string;
  conversationTitle?: string;
  messageNodeId?: string;
}

/** 工具执行的标准化返回值。
 *  - output: 要显示在对话里的 UI parts。
 *  - fileCreation: 工具想创建文件（如 MCP 图片）时返回的描述符，
 *    由协调器统一落盘，避免工具直接修改 global state.files。 */
export interface ToolResult {
  output: JsonValue[];
  fileCreation?: {
    data: string; // base64
    mime: string;
    prefix: string;
  };
}

/** 推理引擎对工具执行层的抽象。实现可以暂时仍是 server.ts 里的 executeToolCall，
 *  但接口保证二者不形成循环 import。 */
export type ToolExecutor = (toolCall: ToolCall, context?: ToolContext) => Promise<ToolResult>;
