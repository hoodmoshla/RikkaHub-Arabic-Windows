// tools/format.ts — 工具结果格式化与输入解析
// 纪律：纯函数，只负责把工具 part / 输出转成 API 消息可用的字符串或对象。

import { id, isRecord, textFromParts } from "../foundation/utils";
import type { JsonValue } from "../foundation/types";

export function parseToolInput(value: unknown): Record<string, JsonValue> {
  if (isRecord(value)) return value as Record<string, JsonValue>;
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? (parsed as Record<string, JsonValue>) : {};
  } catch {
    return {};
  }
}

export function toolExecutionErrorPayload(err: unknown): JsonValue {
  if (err instanceof Error) {
    return {
      error: `[${err.name || "Error"}] ${err.message}${err.stack ? `\n${err.stack}` : ""}`,
    };
  }
  return { error: String(err) };
}

export function openAiToolOutput(parts: JsonValue[]): string {
  const text = textFromParts(parts);
  if (text) return text;
  return parts.length ? JSON.stringify(parts) : "";
}

export function toolOutputForApproval(part: Record<string, unknown>): string {
  const approvalState = isRecord(part.approvalState) ? part.approvalState : { type: "auto" };
  const type = String(approvalState.type ?? "auto");
  if (type === "answered") return String(approvalState.answer ?? "");
  if (type === "denied") {
    const reason = String(approvalState.reason ?? "").trim() || "No reason provided";
    return JSON.stringify({ error: `Tool execution denied by user. Reason: ${reason}` });
  }
  return "";
}

export function resolvedToolOutput(part: Record<string, unknown>): string {
  const output = Array.isArray(part.output) ? part.output : [];
  const fromOutput = openAiToolOutput(output as JsonValue[]);
  if (fromOutput) return fromOutput;
  return toolOutputForApproval(part);
}

export function apiToolCallFromPart(part: Record<string, unknown>) {
  return {
    id: String(part.toolCallId ?? id()),
    type: "function" as const,
    function: {
      name: String(part.toolName ?? ""),
      arguments: String(part.input ?? "{}"),
    },
  };
}

export function partsToToolResultText(parts: JsonValue[]): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (isRecord(part) && part.type === "text" ? String(part.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}
