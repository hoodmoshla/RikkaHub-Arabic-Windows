// Claude 流式工具循环端到端单测（P1-5 批B）：mock 全局 fetch 仿真 Anthropic SSE，
// 验证 thinking signature 回放、tool_result 编码、工具分发、最终文本——这是 Claude
// 路径唯一的回归网（request-chain smoke 只覆盖 OpenAI）。
import { afterAll, describe, expect, mock, test } from "bun:test";

mock.module("../api/logs", () => ({ addLog: () => {} }));
mock.module("../api/sse", () => ({ touchStream: () => {} }));

const { streamClaudeChatWithTools } = await import("./providers");

const assistant = { id: "a1", mcpServers: [] } as never;
const providerItem = { id: "p1", name: "Claude Test" } as never;

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const toolRoundStream = sse([
  ["message_start", { message: { usage: { input_tokens: 10 } } }],
  ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }],
  ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "思考中" } }],
  ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig123" } }],
  ["content_block_stop", { index: 0 }],
  ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "do_it" } }],
  ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }],
  ["content_block_stop", { index: 1 }],
  ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
  ["message_stop", {}],
]);

const finalRoundStream = sse([
  ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "完成" } }],
  ["content_block_stop", { index: 0 }],
  ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
  ["message_stop", {}],
]);

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("streamClaudeChatWithTools", () => {
  test("工具轮→tool_result 回放(thinking signature 保留)→最终文本", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const streams = [toolRoundStream, finalRoundStream];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      requestBodies.push(JSON.parse(String(init.body)));
      return new Response(streams.shift() ?? "", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const events: Array<Record<string, unknown>> = [];
    const executed: Array<{ name: string; args: string }> = [];
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: (event: Record<string, unknown>) => events.push(event),
      executeTool: async (call: { function: { name: string; arguments: string } }) => {
        executed.push({ name: call.function.name, args: call.function.arguments });
        return { output: [{ type: "text", text: "工具输出" }] };
      },
    } as never;

    const out = await streamClaudeChatWithTools(
      "https://api.test/v1/messages",
      { "x-api-key": "k" },
      { model: "claude-test", messages: [{ role: "user", content: "hi" }] },
      providerItem,
      assistant,
      undefined,
      hooks,
    );

    expect(out).toBe("完成");
    expect(executed).toEqual([{ name: "do_it", args: '{"a":1}' }]);

    // 第二轮请求体：assistant 回放轮(thinking+signature 与 tool_use)+ user tool_result 轮
    expect(requestBodies).toHaveLength(2);
    const secondMessages = requestBodies[1]!.messages as Array<{ role: string; content: unknown }>;
    expect(secondMessages).toHaveLength(3);
    const assistantReplay = secondMessages[1]!;
    expect(assistantReplay.role).toBe("assistant");
    const replayBlocks = assistantReplay.content as Array<Record<string, unknown>>;
    // 现状(切换前旧实现同):thinking_delta 只累积进 thinkingOut 不写回 block,回放的
    // thinking 恒为 content_block_start 快照(通常空);signature 才是 Anthropic 的校验关键。
    expect(replayBlocks.find((b) => b.type === "thinking")).toEqual({ type: "thinking", thinking: "", signature: "sig123" });
    const toolUseReplay = replayBlocks.find((b) => b.type === "tool_use")!;
    expect(toolUseReplay.id).toBe("toolu_1");
    expect(toolUseReplay.name).toBe("do_it");
    const toolResultTurn = secondMessages[2]!;
    expect(toolResultTurn.role).toBe("user");
    const resultBlocks = toolResultTurn.content as Array<Record<string, unknown>>;
    expect(resultBlocks[0]!.type).toBe("tool_result");
    expect(resultBlocks[0]!.tool_use_id).toBe("toolu_1");

    // sink 事件链：thinking 增量、工具卡创建、工具输入增量、工具结果、usage、最终文本
    expect(events.some((e) => e.kind === "reasoning_delta" && e.text === "思考中")).toBe(true);
    expect(events.some((e) => e.kind === "tool_call_created" && e.toolCallId === "toolu_1")).toBe(true);
    expect(events.some((e) => e.kind === "tool_result" && e.toolCallId === "toolu_1")).toBe(true);
    expect(events.some((e) => e.kind === "usage")).toBe(true);
    expect(events.some((e) => e.kind === "text_delta" && e.text === "完成")).toBe(true);
  });

  test("无工具单轮直接返回文本", async () => {
    globalThis.fetch = (async () => new Response(finalRoundStream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: () => {},
      executeTool: async () => ({ output: [] }),
    } as never;
    const out = await streamClaudeChatWithTools(
      "https://api.test/v1/messages",
      {},
      { model: "m", messages: [] },
      providerItem,
      assistant,
      undefined,
      hooks,
    );
    expect(out).toBe("完成");
  });
});
