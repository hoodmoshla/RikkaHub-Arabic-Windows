// context-overflow.test.ts — 专题4:超上下文报错识别的回归防线。
// 正例取自三家 provider 的真实 400 报文形状(providers.ts 抛错格式:`名字 状态码: 正文`);
// 负例确保限流/鉴权/普通网络错误不会被误说成超上下文。

import { describe, expect, test } from "bun:test";
import { CONTEXT_OVERFLOW_MESSAGE, classifyContextOverflowError } from "./context-overflow";

describe("classifyContextOverflowError", () => {
  const overflowSamples = [
    // OpenAI 官方
    'OpenAI 400: {"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 152340 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}',
    // DeepSeek(OpenAI 兼容,同文案不同 code)
    "DeepSeek 400: This model's maximum context length is 65536 tokens. However, you requested 90000 tokens.",
    // Claude
    'Claude 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210145 tokens > 200000 maximum"}}',
    'Claude 400: {"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 195000 + 8192 > 200000"}}',
    // Gemini
    "Gemini 400: The input token count (1189529) exceeds the maximum number of tokens allowed (1048576).",
    // OpenAI 兼容网关的通用表述
    "OpenRouter 400: This request exceeds the context window of the model.",
  ];
  test.each(overflowSamples)("命中:%s", (sample) => {
    expect(classifyContextOverflowError(new Error(sample))).toBe(CONTEXT_OVERFLOW_MESSAGE);
  });

  const normalSamples = [
    "OpenAI 401: Incorrect API key provided",
    "OpenAI 429: Rate limit reached for tokens per min (TPM): Limit 30000, Used 29000",
    "Claude 529: overloaded_error",
    "Gemini 400: User location is not supported for the API use.",
    "fetch failed: ECONNRESET",
    // 正常回答里讨论 token 的内容不该进这里(本函数只吃 Error),但防御性验证普通提及不命中
    "some response mentioning tokens and context in passing",
  ];
  test.each(normalSamples)("不命中:%s", (sample) => {
    expect(classifyContextOverflowError(new Error(sample))).toBeNull();
  });

  test("非 Error 输入不炸", () => {
    expect(classifyContextOverflowError(null)).toBeNull();
    expect(classifyContextOverflowError(undefined)).toBeNull();
    expect(classifyContextOverflowError("prompt is too long: 1 > 0")).toBe(CONTEXT_OVERFLOW_MESSAGE);
  });
});
