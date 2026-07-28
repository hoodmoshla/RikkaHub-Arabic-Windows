// inference-engine/context-overflow.ts — 专题4:超上下文报错的人话映射
//
// 三家 provider 对"输入超过模型上下文窗口"的 400 各说各话(OpenAI/DeepSeek 系的
// context_length_exceeded / maximum context length、Claude 的 prompt is too long、
// Gemini 的 input token count exceeds the maximum),原文透传给用户就是天书。
// 这里只做识别与换文案,不改任何错误处理流程;模式刻意保守——把正常报错误判成
// 超上下文(用户白压缩半天对话)比漏判(用户看到原文)更糟。

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
