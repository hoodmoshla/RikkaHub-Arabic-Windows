// inference-engine/provider-errors.ts — provider 报错的人话映射
// (专题4 超上下文 + 专题7 限流/过载;原名 context-overflow.ts,随职责扩展改名)
//
// 三家 provider 的报错各说各话,原文透传给用户就是天书。这里只做识别与换文案,
// 不改任何错误处理流程;模式刻意保守——误判(把正常报错说成限流/超上下文,误导用户
// 白折腾)比漏判(用户看到原文)更糟。调用点在 orchestrator 的生成失败分支,
// 与 classifyProxyError 串成 代理 ?? 超上下文 ?? 限流 ?? 原文 的分类链。

export const CONTEXT_OVERFLOW_MESSAGE = "超出模型最大上下文窗口，建议压缩对话或切换窗口更大的模型";

const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  // OpenAI 官方错误码;各 OpenAI 兼容网关(SiliconFlow/OpenRouter 等)大多原样转发
  /context_length_exceeded/i,
  // OpenAI/DeepSeek 文案:"This model's maximum context length is 65536 tokens. However..."
  /maximum context length/i,
  // Claude:"prompt is too long: 210145 tokens > 200000 maximum"
  /prompt is too long/i,
  // Claude(带 max_tokens 的变体):"input length and `max_tokens` exceed context limit"
  /exceed[s]? context limit/i,
  // Gemini:"The input token count (1189529) exceeds the maximum number of tokens allowed (1048576)"
  /input token count .*exceeds/i,
  /exceeds the maximum number of tokens/i,
  // 通用兜底:明确说"超过上下文窗口"的其他 OpenAI 兼容实现
  /exceed[s]? (the )?context window/i,
];

/** 命中"超上下文窗口"类报错时返回给用户的替换文案,否则 null(维持原报错)。 */
export function classifyContextOverflowError(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (!text) return null;
  return CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(text)) ? CONTEXT_OVERFLOW_MESSAGE : null;
}

export const RATE_LIMIT_MESSAGE = "服务商限流或暂时过载（请求过于频繁 / 配额不足 / 上游繁忙），请稍后重试，或更换模型/服务商";

const RATE_LIMIT_PATTERNS: RegExp[] = [
  // tool-loop 抛错格式为 `名字 状态码: 正文`,429 状态码本身就是限流的权威信号
  /\s429:/,
  // OpenAI "Rate limit reached" / code rate_limit_exceeded;Claude type rate_limit_error
  /rate[ _-]?limit/i,
  // 429 的通用 HTTP status text(部分网关只回这个)
  /too many requests/i,
  // Gemini 429 的 status 字段
  /RESOURCE_EXHAUSTED/,
  // OpenAI 欠费/配额耗尽(insufficient_quota,也走 429)
  /insufficient_quota/i,
  /exceeded your current quota/i,
  // Claude 529:{"type":"overloaded_error","message":"Overloaded"}
  /overloaded_error/i,
];

/** 命中"限流/配额/上游过载"类报错时返回人话文案(附原始错误,常含可等待秒数),否则 null。 */
export function classifyRateLimitError(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (!text) return null;
  if (!RATE_LIMIT_PATTERNS.some((re) => re.test(text))) return null;
  return `${RATE_LIMIT_MESSAGE}\n[原始错误] ${text}`;
}
