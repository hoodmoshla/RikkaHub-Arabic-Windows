// tools/format 纯函数单元测试（5.5 测试补强）。
// 工具调用的输入解析 / 输出序列化是模型工具循环的契约层：
// output 优先级（真实输出 > 审批回退）与 {error}/{pending} 历史载荷容错都在这里。
import { describe, expect, test } from "bun:test";

import {
  apiToolCallFromPart,
  openAiToolOutput,
  parseToolInput,
  partsToToolResultText,
  resolvedToolOutput,
  toolExecutionErrorPayload,
  toolOutputForApproval,
} from "./format";

describe("parseToolInput", () => {
  test("对象原样返回，JSON 字符串解析，垃圾输入返回空对象", () => {
    expect(parseToolInput({ a: 1 })).toEqual({ a: 1 });
    expect(parseToolInput('{"q":"x"}')).toEqual({ q: "x" });
    expect(parseToolInput("not json")).toEqual({});
    expect(parseToolInput("")).toEqual({});
    expect(parseToolInput(42)).toEqual({});
    expect(parseToolInput('["array"]')).toEqual({});
  });
});

describe("toolExecutionErrorPayload", () => {
  test("Error 带名称与消息（历史契约 {error} 裸对象形状）", () => {
    const payload = toolExecutionErrorPayload(new Error("boom"));
    expect(payload.error).toContain("[Error] boom");
    expect(payload.type).toBeUndefined();
  });

  test("非 Error 转字符串", () => {
    expect(toolExecutionErrorPayload("oops")).toEqual({ error: "oops" });
  });
});

describe("openAiToolOutput", () => {
  test("有 text part 时优先返回文本", () => {
    expect(openAiToolOutput([{ type: "text", text: "result" }])).toBe("result");
  });

  test("无文本时 JSON 序列化整个 output，空数组返回空串", () => {
    expect(openAiToolOutput([{ error: "boom" }])).toBe('[{"error":"boom"}]');
    expect(openAiToolOutput([])).toBe("");
  });
});

describe("toolOutputForApproval / resolvedToolOutput", () => {
  test("answered 返回答案，denied 返回带理由的错误 JSON，auto 返回空", () => {
    expect(toolOutputForApproval({ approvalState: { type: "answered", answer: "42" } })).toBe("42");
    const denied = toolOutputForApproval({ approvalState: { type: "denied", reason: "no" } });
    expect(JSON.parse(denied)).toEqual({ error: "Tool execution denied by user. Reason: no" });
    expect(toolOutputForApproval({ approvalState: { type: "auto" } })).toBe("");
  });

  test("denied 无理由时用占位文案", () => {
    const denied = toolOutputForApproval({ approvalState: { type: "denied", reason: "" } });
    expect(denied).toContain("No reason provided");
  });

  test("resolvedToolOutput 优先真实 output，无 output 回退审批状态", () => {
    expect(
      resolvedToolOutput({ output: [{ type: "text", text: "real" }], approvalState: { type: "answered", answer: "x" } }),
    ).toBe("real");
    expect(
      resolvedToolOutput({ output: [], approvalState: { type: "answered", answer: "fallback" } }),
    ).toBe("fallback");
  });
});

describe("partsToToolResultText", () => {
  test("只取 text part 以换行拼接", () => {
    expect(
      partsToToolResultText([
        { type: "text", text: "a" },
        { type: "image", url: "u" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });
});

describe("apiToolCallFromPart", () => {
  test("从 tool part 构造 OpenAI 工具调用回显", () => {
    const call = apiToolCallFromPart({ toolCallId: "id1", toolName: "search", input: '{"q":"x"}' });
    expect(call).toEqual({
      id: "id1",
      type: "function",
      function: { name: "search", arguments: '{"q":"x"}' },
    });
  });

  test("缺 input 时回退到空对象串", () => {
    const call = apiToolCallFromPart({ toolCallId: "id2", toolName: "t" });
    expect(call.function.arguments).toBe("{}");
  });
});
