// tools/approval.ts — 工具审批状态判断
// 纪律：纯函数，只读取 assistant / settings，不读写 state 运行时副作用。

import { getStringArray, isRecord } from "../foundation/utils";
import type { Assistant, JsonValue } from "../foundation/types";
import { state } from "../persistence/json-store";

export function getMcpToolOverride(
  assistant: Assistant,
  serverId: string,
  toolName: string,
): { enable?: boolean; needsApproval?: boolean } | undefined {
  const overrides = isRecord(assistant.mcpToolOverrides)
    ? (assistant.mcpToolOverrides as Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>>)
    : undefined;
  if (!overrides) return undefined;
  const perServer = overrides[serverId];
  if (!perServer) return undefined;
  return perServer[toolName];
}

// Per-assistant resolved enable state for a tool. Global tool.enable=false ⇒ false (override
// can never reactivate a globally-disabled tool — matches the user's stated rule "设置中关闭
// 的工具会话里看不见"). Otherwise, the override.enable wins; absence falls back to true.
export function isMcpToolEnabledForAssistant(
  assistant: Assistant,
  serverId: string,
  tool: Record<string, unknown>,
): boolean {
  if (tool.enable === false) return false;
  const override = getMcpToolOverride(assistant, serverId, String(tool.name ?? ""));
  if (override?.enable === false) return false;
  return true;
}

// Per-assistant resolved needsApproval state. Override wins when set (true/false), otherwise
// falls back to the global per-tool needsApproval flag.
export function isMcpToolApprovalRequiredForAssistant(
  assistant: Assistant,
  serverId: string,
  tool: Record<string, unknown>,
): boolean {
  const override = getMcpToolOverride(assistant, serverId, String(tool.name ?? ""));
  if (typeof override?.needsApproval === "boolean") return override.needsApproval;
  return tool.needsApproval === true;
}

// Returns true if this tool requires user approval before executing — mirrors Android's
// GenerationHandler.kt:184-189 logic (`toolDef?.needsApproval == true && state is Auto -> Pending`).
// PC scope: `ask_user` is always pending (it's literally a "ask the user" prompt), and any
// MCP tool whose effective needsApproval (override-resolved) is true gets pending too. Local
// built-ins (search/scrape/memory/etc.) currently never need approval — Android matches.
export function toolNeedsApproval(toolName: string, assistant: Assistant): boolean {
  if (!toolName) return false;
  if (toolName === "ask_user") return true;
  if (!toolName.startsWith("mcp__")) return false;
  const selected = new Set(getStringArray(assistant.mcpServers));
  const servers = (state.settings.mcpServers as Array<Record<string, unknown>>)
    .filter((server) => selected.has(String(server.id ?? "")) && isRecord(server.commonOptions) && server.commonOptions.enable !== false);
  for (const server of servers) {
    const common = server.commonOptions as Record<string, unknown>;
    const tools = Array.isArray(common.tools) ? common.tools.filter(isRecord) : [];
    const matched = tools.find(
      (tool) =>
        isMcpToolEnabledForAssistant(assistant, String(server.id ?? ""), tool)
        && `mcp__${String(tool.name ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")}` === toolName,
    );
    if (matched) return isMcpToolApprovalRequiredForAssistant(assistant, String(server.id ?? ""), matched);
  }
  return false;
}

export function initialApprovalState(toolName: string, assistant: Assistant): JsonValue {
  return toolNeedsApproval(toolName, assistant) ? { type: "pending" } : { type: "auto" };
}
