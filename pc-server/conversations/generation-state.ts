// conversations/generation-state.ts — 会话生成中的运行时状态（AbortController 注册表）
// 单独成文件：api/sse 与编排层都要读它，独立后互不成环。

export const generating = new Map<string, AbortController>();
