// inference-engine/tool-loop.ts — 统一流式工具循环骨架（P1-5，方案见 项目重构方案.md「P1-5 方案」）
//
// 三家 provider（OpenAI/Claude/Google）的流式工具循环骨架原本各写一遍、逐字重复约 60%——
// 任何流式/工具循环 bug 都要修三遍。本模块吸收全部共同骨架：
//   轮次推进(MAX_TOOL_STEPS) / abort 检查 / fetch / 错误与成功请求日志 / usage 下沉 /
//   文本累积 / 工具卡创建(未在流内建卡的 provider) / 审批 pre-scan bail / 工具执行分发 /
//   非流式降级重试(可选能力) / 超限抛错。
// Provider 差异经 ProviderRoundAdapter 注入：单轮流解析、工具调用归一、下一轮编码(回放
// assistant 轮 + 工具结果轮的 provider 特定格式)、日志载荷、若干冻结的行为点位。
//
// 行为冻结纪律：本文件从三个旧循环逐字搬迁共同骨架，行为差异点位全部保留为 adapter
// 字段（见接口注释），不做任何有意统一——那属于单独的行为修复提交。
import type { Assistant, Message, Provider } from "../foundation/types";
import { id } from "../foundation/utils";
import { initialApprovalState, toolNeedsApproval } from "../tools/approval";
import { toolExecutionErrorPayload } from "../tools/format";
import { finishReasoningParts } from "./parts";
import type { StreamHooksWithSink, ToolCall, ToolDispatchContext, ToolResult } from "./events";
import type { ToolOutputEntry, ToolPart } from "../foundation/types";
import { jsonBody, textBody } from "../model-providers";
import { addLog } from "../api/logs";
import { touchStream } from "../api/sse";
import { isRecord } from "../foundation/utils";

export const MAX_TOOL_STEPS = 256;

export function toolCallContext(hooks?: StreamHooksWithSink): ToolDispatchContext | undefined {
  if (!hooks?.conversation) return undefined;
  return {
    conversationId: hooks.conversation.id,
    conversationTitle: hooks.conversation.title || undefined,
    messageNodeId: hooks.node?.id,
    executeTool: hooks.executeTool,
  };
}

/** 归一化的工具调用（三家提取形状 tool_use / functionCall / toolCalls 统一到此）。 */
export interface NormalizedToolCall {
  id: string;
  name: string;
  /** JSON string（与 OpenAI function.arguments 对齐；Claude/Google 的对象入参由 adapter 序列化）。 */
  arguments: string;
}

/** 单轮请求的解析结果。replay 是 adapter 私有的回放载荷（如 Claude 的 content blocks、
 *  Google 的 modelParts、OpenAI 的 raw toolCalls 数组），骨架原样传给 encodeNextTurn。 */
export interface RoundResult {
  text: string;
  usage?: Message["usage"];
  toolCalls: NormalizedToolCall[];
  replay: unknown;
}

export interface ExecutedToolResult {
  call: NormalizedToolCall;
  output: ToolOutputEntry[];
}

export interface ProviderRoundAdapter {
  providerItem: Provider;
  /** 请求日志的 url 字段。 */
  logUrl: string;
  /** 请求日志的 requestHeaders 字段。 */
  logHeaders: Record<string, string>;
  /** 发起单轮请求。骨架不关心 url/headers 细节（超时/abort 桥接等由 adapter 自理）。 */
  fetchRound(requestBody: Record<string, unknown>, round: number): Promise<Response>;
  /** 读取并解析单轮响应，流内增量经 hooks/sink 下沉。 */
  readRound(response: Response, signal: AbortSignal | undefined): Promise<RoundResult>;
  /** 编码下一轮请求 body：回放本轮 assistant 轮 + 工具结果轮（provider 特定格式）。 */
  encodeNextTurn(result: RoundResult, toolResults: ExecutedToolResult[]): Record<string, unknown>;
  /** 成功轮的响应日志载荷。 */
  logResponseBody(result: RoundResult): string;
  /** 文本累积是否用换行分隔（Claude/Google: true；OpenAI: false 直接拼接）。 */
  joinTextWithNewline: boolean;
  /** 工具卡是否已在流内创建（Claude/Google: true；OpenAI: false → 骨架在循环层建卡）。 */
  toolCardsCreatedInStream: boolean;
  /** 无工具调用最终返回前的收尾（Claude/Google: finishReasoningParts；OpenAI: 无）。 */
  finishReasoningOnFinal: boolean;
  /** MAX_TOOL_STEPS 超限的报错文案（三家文案不同，冻结）。 */
  exhaustedError: string;
  /** 读流结束后是否检查 abort 并抛出（OpenAI: true；Claude/Google: false——原实现只在
   *  轮首检查，abort 后本轮工具仍会执行。此差异冻结，统一属行为修复须单独提交）。 */
  abortCheckAfterRead: boolean;
  /** 流式失败降级为非流式重试（仅 OpenAI）。makeBody 把请求体改造为非流式形态。 */
  nonStreamFallback?: {
    makeBody(body: Record<string, unknown>): Record<string, unknown>;
    /** fetch 本身失败（连接失败）时的提示，追加 detail。 */
    connectHint: string;
    /** 读流中断时的提示。 */
    interruptHint: string;
  };
}

function logRound(
  adapter: ProviderRoundAdapter,
  round: number,
  startedAt: number,
  requestBody: Record<string, unknown>,
  fields: { ok: boolean; status: number; responseHeaders?: Record<string, string>; responseBody: string; error?: string },
): void {
  addLog({
    providerId: adapter.providerItem.id,
    providerName: adapter.providerItem.name,
    url: adapter.logUrl,
    ok: fields.ok,
    status: fields.status,
    kind: round === 0 ? "provider:chat:stream" : "provider:chat:tool_result:stream",
    durationMs: Date.now() - startedAt,
    method: "POST",
    requestHeaders: adapter.logHeaders,
    ...(fields.responseHeaders ? { responseHeaders: fields.responseHeaders } : {}),
    requestBody: jsonBody(requestBody),
    responseBody: fields.responseBody,
    ...(fields.error !== undefined ? { error: fields.error } : {}),
  });
}

/** 统一流式工具循环。返回最终 assistant 文本（与三个旧循环的返回值语义逐字一致）。 */
export async function runStreamingToolLoop(
  adapter: ProviderRoundAdapter,
  initialBody: Record<string, unknown>,
  assistant: Assistant,
  signal: AbortSignal | undefined,
  hooks: StreamHooksWithSink,
): Promise<string> {
  let currentBody = initialBody;
  let allContent = "";
  let forceNonStream = false;

  for (let round = 0; round < MAX_TOOL_STEPS; round += 1) {
    if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    const roundStarted = Date.now();
    const requestBody = forceNonStream && adapter.nonStreamFallback
      ? adapter.nonStreamFallback.makeBody(currentBody)
      : currentBody;

    let response: Response;
    try {
      response = await adapter.fetchRound(requestBody, round);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logRound(adapter, round, roundStarted, requestBody, { ok: false, status: 0, responseBody: "", error: detail });
      if (adapter.nonStreamFallback && !forceNonStream && !signal?.aborted) {
        forceNonStream = true;
        hooks.sink?.({ kind: "reasoning_delta", text: `${adapter.nonStreamFallback.connectHint} ${detail}` });
        round -= 1;
        continue;
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text();
      logRound(adapter, round, roundStarted, requestBody, {
        ok: false,
        status: response.status,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        responseBody: textBody(text),
        error: textBody(text),
      });
      throw new Error(`${adapter.providerItem.name} ${response.status}: ${text.slice(0, 500)}`);
    }

    let result: RoundResult;
    try {
      result = await adapter.readRound(response, signal);
    } catch (err) {
      logRound(adapter, round, roundStarted, requestBody, {
        ok: false,
        status: response.status,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        responseBody: "",
        error: err instanceof Error ? err.message : String(err),
      });
      if (adapter.nonStreamFallback && !forceNonStream && !signal?.aborted) {
        forceNonStream = true;
        hooks.sink?.({ kind: "reasoning_delta", text: adapter.nonStreamFallback.interruptHint });
        round -= 1;
        continue;
      }
      throw err;
    }

    if (hooks.message && result.usage) {
      if (hooks.sink) hooks.sink({ kind: "usage", usage: result.usage });
      else hooks.message.usage = result.usage;
    }

    logRound(adapter, round, roundStarted, requestBody, {
      ok: true,
      status: response.status,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      responseBody: adapter.logResponseBody(result),
    });

    if (adapter.joinTextWithNewline) {
      if (result.text) allContent += `${allContent ? "\n" : ""}${result.text}`;
    } else {
      allContent += result.text;
    }

    if (adapter.abortCheckAfterRead && signal?.aborted) throw new DOMException("Generation stopped", "AbortError");

    if (result.toolCalls.length === 0) {
      if (adapter.finishReasoningOnFinal) finishReasoningParts(hooks.message!);
      return allContent.trim() || "(empty response)";
    }

    // 审批 pre-scan：批内任一工具需要用户审批就整批不执行（避免部分执行后下一轮缺
    // tool_result）。工具卡已经/将要渲染为 pending 态，generateAnswer 看到
    // hasPendingToolApproval 会暂停等用户决定。
    const hasPendingInBatch = result.toolCalls.some((call) => toolNeedsApproval(call.name, assistant));
    const dispatchCtx = toolCallContext(hooks);
    const toolResults: ExecutedToolResult[] = [];

    for (const call of result.toolCalls) {
      if (!adapter.toolCardsCreatedInStream && hooks.message) {
        // 流内不建卡的 provider（OpenAI）：循环层创建工具卡（pending 时也要渲染卡）
        const toolPart: ToolPart = {
          type: "tool",
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments,
          output: [],
          approvalState: initialApprovalState(call.name, assistant),
        };
        finishReasoningParts(hooks.message);
        hooks.sink?.({
          kind: "tool_call_created",
          toolCallId: toolPart.toolCallId,
          toolName: toolPart.toolName,
          input: String(toolPart.input),
          approvalState: toolPart.approvalState,
        });
        touchStream(hooks);
      }
      if (hasPendingInBatch) continue;

      const toolCall: ToolCall = { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };
      let toolResult: ToolResult;
      try {
        toolResult = await dispatchCtx!.executeTool!(toolCall, dispatchCtx);
      } catch (err) {
        toolResult = { output: [toolExecutionErrorPayload(err)] };
      }
      const outputParts = toolResult.output;
      if (hooks.message) {
        if (hooks.sink) {
          hooks.sink({ kind: "tool_result", toolCallId: call.id, output: outputParts });
        } else {
          hooks.message.parts = hooks.message.parts.map((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.toolCallId !== call.id) return part;
            return { ...part, input: call.arguments, output: outputParts };
          });
          touchStream(hooks);
        }
      }
      toolResults.push({ call, output: outputParts });
    }

    if (hasPendingInBatch) {
      return allContent.trim() || "";
    }

    currentBody = adapter.encodeNextTurn(result, toolResults);
  }

  throw new Error(adapter.exhaustedError);
}

/** 生成兜底 id（adapter 归一化工具调用缺 id 时用）。 */
export function fallbackToolCallId(): string {
  return id();
}
