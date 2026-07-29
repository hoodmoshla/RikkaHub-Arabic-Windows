// 专题11-P1-3 回归网:缓存命中字段多方言解析(对齐安卓 #1576)与 usage 合并语义
// (新值>0 才覆盖)。防止"后到的 usage 事件缺字段把已知命中数清零"回潮。
import { describe, expect, test } from "bun:test";
import { appendUsageFromRaw } from "./providers";
import { mergeTokenUsage } from "./tool-loop";
import { message } from "../foundation/utils";

function usageOf(raw: Record<string, unknown>) {
  const msg = message("ASSISTANT", []);
  appendUsageFromRaw(msg, { usage: raw });
  return msg.usage as Record<string, number>;
}

describe("appendUsageFromRaw 方言解析", () => {
  test("OpenAI 嵌套 prompt_tokens_details.cached_tokens", () => {
    const usage = usageOf({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 64 } });
    expect(usage.cachedTokens).toBe(64);
    expect(usage.promptTokens).toBe(100);
  });

  test("Responses API 嵌套 input_tokens_details.cached_tokens", () => {
    const usage = usageOf({ input_tokens: 200, output_tokens: 20, input_tokens_details: { cached_tokens: 128 } });
    expect(usage.cachedTokens).toBe(128);
  });

  test("Moonshot 顶层 cached_tokens", () => {
    const usage = usageOf({ prompt_tokens: 50, completion_tokens: 5, cached_tokens: 30 });
    expect(usage.cachedTokens).toBe(30);
  });

  test("DeepSeek prompt_cache_hit_tokens", () => {
    const usage = usageOf({ prompt_tokens: 19239, completion_tokens: 500, prompt_cache_hit_tokens: 14976 });
    expect(usage.cachedTokens).toBe(14976);
  });

  test("无缓存字段时为 0", () => {
    expect(usageOf({ prompt_tokens: 10, completion_tokens: 1 }).cachedTokens).toBe(0);
  });
});

describe("usage 合并语义(新值>0 才覆盖)", () => {
  test("后到事件缺缓存字段不清零已知命中数", () => {
    const msg = message("ASSISTANT", []);
    appendUsageFromRaw(msg, { usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } } });
    appendUsageFromRaw(msg, { usage: { prompt_tokens: 100, completion_tokens: 42 } });
    const usage = msg.usage as Record<string, number>;
    expect(usage.cachedTokens).toBe(80);
    expect(usage.completionTokens).toBe(42);
  });

  test("mergeTokenUsage:新值为 0 保留旧值,新值>0 覆盖", () => {
    const prev = { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedTokens: 64 };
    const next = { promptTokens: 200, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
    expect(mergeTokenUsage(prev, next)).toEqual({ promptTokens: 200, completionTokens: 10, totalTokens: 110, cachedTokens: 64 });
  });

  test("mergeTokenUsage:contextLimit 随旧值保留", () => {
    const prev = { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0, contextLimit: 128000 };
    const next = { promptTokens: 5, completionTokens: 2, totalTokens: 7, cachedTokens: 3 };
    expect((mergeTokenUsage(prev, next) as Record<string, number>).contextLimit).toBe(128000);
  });

  test("mergeTokenUsage:一侧为空返回另一侧", () => {
    const only = { promptTokens: 1, completionTokens: 2, totalTokens: 3, cachedTokens: 0 };
    expect(mergeTokenUsage(null, only)).toEqual(only);
    expect(mergeTokenUsage(only, null)).toEqual(only);
  });
});
