// api/handlers/settings.ts — 设置路由（settings GET/stream、display/keybindings、assistant/*、mcp-server/*、
// mode-injection/*、lorebook/*、quick-message/*、search/*、模型与 provider/*、proxy/port）
// 纪律：纯搬迁自 server.ts routeApi()；settings 数据契约冻结。

import type { Assistant, JsonValue, Provider, ProxyConfig, SearchService } from "../../foundation/types";
import type { Settings } from "../../foundation/types/settings";
import { getStringArray, id, isRecord } from "../../foundation/utils";
import {
  applyEffectiveProxy,
  friendlyRequestError,
  proxyStatusPayload,
  readWindowsSystemProxy,
  resolveEffectiveProxy,
} from "../../foundation/net";
import { state } from "../../persistence/json-store";
import { defaultAssistant } from "../../assistants/index";
import { firstProviderModel } from "../../model-providers/index";
import { loadModelsDev } from "../../inference-engine/providers";
import { syncMcpServerTools } from "../../tools/mcp";
import { listSkills } from "../../tools/skills";
import { testSearchService } from "../../search/index";
import { callImageGeneration } from "../../media/image-gen";
import { memoryStore } from "../../memory/index";
import { addLog } from "../logs";
import { error, json, readJson } from "../request";
import { broadcastMemoryUpdate, sseFrame } from "../sse";
import { deleteById, reorderByIds, upsertById, validateKnownJsonIds } from "../../foundation/utils";
import { normalizePreferredPort, normalizeProxyConfig } from "../../foundation/net";
import { defaultSettings } from "../../app-config/defaults";
import { DEFAULT_COMPRESS_PROMPT, DEFAULT_OCR_PROMPT, DEFAULT_PROMPT_OPTIMIZE_PROMPT, DEFAULT_SUGGESTION_PROMPT, DEFAULT_TITLE_PROMPT, DEFAULT_TRANSLATION_PROMPT } from "../../app-config/prompts";
import { updateSettings } from "../../app-config";
import { markProviderTestResult } from "../../model-providers/checks";
import { endpointFor, fetchProviderBalance, fetchProviderModels, runProviderCheck } from "../../model-providers/checks";

export async function handleSettingsRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  if (path === "settings" && request.method === "GET") return json(state.settings);
  // settings 快照推送已并入 /api/events 通道(settings 事件)。
  if (path === "settings/display" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    updateSettings({ ...state.settings, displaySetting: { ...state.settings.displaySetting, ...body } });
    return json({ status: "ok" });
  }
  // 更新单个 action 的快捷键(keys 录制结果)或 enabled 开关。仅接受默认 action 列表内的条目。
  if (path === "settings/keybindings" && request.method === "POST") {
    const body = await readJson<{ action: string; keys?: string[]; enabled?: boolean }>(request);
    const defaults = defaultSettings().keybindings;
    if (!(body.action in defaults)) return error("Unknown keybinding action", 400);
    const current = { ...defaults, ...state.settings.keybindings } as Record<string, JsonValue>;
    const existing = isRecord(current[body.action]) ? (current[body.action] as Record<string, JsonValue>) : {};
    const next: Record<string, JsonValue> = { ...existing };
    if (Array.isArray(body.keys)) next.keys = body.keys.filter((k) => typeof k === "string");
    if (typeof body.enabled === "boolean") next.enabled = body.enabled;
    current[body.action] = next;
    updateSettings({ ...state.settings, keybindings: current });
    return json({ status: "ok" });
  }
  // 重置全部快捷键到默认(设置页"恢复默认"按钮)。
  if (path === "settings/keybindings/reset" && request.method === "POST") {
    updateSettings({ ...state.settings, keybindings: defaultSettings().keybindings });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant" && request.method === "POST") {
    const body = await readJson<{ assistantId: string }>(request);
    if (!state.settings.assistants.some((assistant) => assistant.id === body.assistantId)) return error("Assistant not found", 404);
    updateSettings({ ...state.settings, assistantId: body.assistantId });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/detail" && request.method === "POST") {
    const body = await readJson<Assistant>(request);
    const assistant = { ...defaultAssistant(), ...body, id: body.id || id() };
    updateSettings({
      ...state.settings,
      assistantId: assistant.id,
      assistants: state.settings.assistants.some((item) => item.id === assistant.id)
        ? state.settings.assistants.map((item) => (item.id === assistant.id ? assistant : item))
        : [...state.settings.assistants, assistant],
    });
    // 助手改名后刷新 assistant_memory.json 里的 assistantName 快照(§12.4-22),推前端同步。
    memoryStore.refreshAssistantNames(state.settings.assistants);
    broadcastMemoryUpdate();
    return json({ status: "ok", assistant });
  }
  const assistantDelete = path.match(/^settings\/assistant\/([^/]+)$/);
  if (assistantDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(assistantDelete[1]);
    if (state.settings.assistants.length <= 1) return error("At least one assistant is required", 400);
    const deleteMemories = url.searchParams.get("deleteMemories") === "true";
    const assistants = state.settings.assistants.filter((item) => item.id !== idValue);
    // M4:默认保留记忆为孤儿(防误删助手导致记忆连带丢失);仅 deleteMemories=true 时连带清。
    if (deleteMemories) {
      memoryStore.deleteMemoriesByAssistant(idValue);
      broadcastMemoryUpdate();
    }
    updateSettings({
      ...state.settings,
      assistants,
      assistantId: state.settings.assistantId === idValue ? assistants[0].id : state.settings.assistantId,
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/assistants/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.assistants.map((item) => [item.id, item]));
    const ordered = body.ids.map((itemId) => byId.get(itemId)).filter(Boolean) as Assistant[];
    const rest = state.settings.assistants.filter((item) => !body.ids.includes(item.id));
    updateSettings({ ...state.settings, assistants: [...ordered, ...rest] });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/model" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; modelId: string }>(request);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, chatModelId: body.modelId } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/thinking-budget" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; reasoningLevel: string }>(request);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, reasoningLevel: body.reasoningLevel } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/mcp" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; mcpServerIds: string[] }>(request);
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === body.assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    let mcpServerIds: string[];
    try {
      mcpServerIds = validateKnownJsonIds(state.settings.mcpServers, body.mcpServerIds, "mcpServerIds");
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 400);
    }
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) => {
        if (assistant.id !== body.assistantId) return assistant;
        // Master-on transition for assistant-level MCP servers. Mirror the global server's
        // behavior: when the user flips an assistant's MCP server master ON, if every tool
        // in this server is currently disabled-by-override for THIS assistant (meaning
        // there's no surviving user preference at the assistant scope), wipe the overrides
        // so the freshly-enabled MCP exposes all globally-enabled tools. If even one tool
        // override doesn't disable a tool, the user has expressed an intentional subset —
        // leave overrides untouched.
        const prevServers = new Set(getStringArray(assistant.mcpServers));
        const newlyAdded: string[] = mcpServerIds.filter((sid) => !prevServers.has(sid));
        const overrides = isRecord(assistant.mcpToolOverrides)
          ? { ...assistant.mcpToolOverrides as Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>> }
          : {};
        for (const sid of newlyAdded) {
          const globalServer = (state.settings.mcpServers as Array<Record<string, JsonValue>>).find((s) => String(s.id) === sid);
          const globalCommon = globalServer && isRecord(globalServer.commonOptions) ? globalServer.commonOptions : null;
          const globalTools = globalCommon && Array.isArray(globalCommon.tools) ? globalCommon.tools.filter(isRecord) : [];
          const visibleTools = globalTools.filter((tool) => tool.enable !== false);
          if (visibleTools.length === 0) continue;
          const perServerOverride = overrides[sid] ?? {};
          // Every visible tool effectively disabled by THIS assistant means the override
          // map is the only thing standing in the way of these tools being exposed.
          const allOverriddenOff = visibleTools.every((tool) => perServerOverride[String(tool.name ?? "")]?.enable === false);
          if (allOverriddenOff) {
            // Strip per-tool `enable` overrides for this server. Keep needsApproval entries —
            // they're an independent dimension and shouldn't get wiped just because the
            // user re-enabled the master switch.
            const cleanedServerOverride: Record<string, { enable?: boolean; needsApproval?: boolean }> = {};
            for (const [toolName, ov] of Object.entries(perServerOverride)) {
              if (typeof ov?.needsApproval === "boolean") {
                cleanedServerOverride[toolName] = { needsApproval: ov.needsApproval };
              }
            }
            if (Object.keys(cleanedServerOverride).length === 0) {
              delete overrides[sid];
            } else {
              overrides[sid] = cleanedServerOverride;
            }
          }
        }
        return { ...assistant, mcpServers: mcpServerIds, mcpToolOverrides: overrides };
      }),
    });
    return json({ status: "ok" });
  }
  // Per-tool override within one MCP server, for ONE assistant. Body shape:
  //   { assistantId, serverId, toolName, enable?, needsApproval? }
  // - enable: null/undefined → clear override (revert to global); true/false → set
  // - needsApproval: same semantics
  // Sending both nulls removes the entry from mcpToolOverrides[serverId][toolName]. If that
  // makes the server's override map empty, we drop the server key as well to keep state.json
  // tidy.
  if (path === "settings/assistant/mcp-tool-override" && request.method === "POST") {
    const body = await readJson<{
      assistantId?: string;
      serverId?: string;
      toolName?: string;
      enable?: boolean | null;
      needsApproval?: boolean | null;
    }>(request);
    const assistantId = String(body.assistantId ?? "");
    const serverId = String(body.serverId ?? "");
    const toolName = String(body.toolName ?? "");
    if (!assistantId || !serverId || !toolName) {
      return error("assistantId, serverId, toolName are required", 400);
    }
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    const serverKnown = (state.settings.mcpServers as Array<Record<string, JsonValue>>).some((server) => String(server.id) === serverId);
    if (!serverKnown) return error("MCP server not found", 404);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) => {
        if (assistant.id !== assistantId) return assistant;
        const overrides = isRecord(assistant.mcpToolOverrides)
          ? { ...assistant.mcpToolOverrides as Record<string, Record<string, { enable?: boolean; needsApproval?: boolean }>> }
          : {};
        const serverOverrides = isRecord(overrides[serverId])
          ? { ...overrides[serverId] }
          : {};
        const next: { enable?: boolean; needsApproval?: boolean } = { ...(serverOverrides[toolName] ?? {}) };
        if (body.enable === null) delete next.enable;
        else if (typeof body.enable === "boolean") next.enable = body.enable;
        if (body.needsApproval === null) delete next.needsApproval;
        else if (typeof body.needsApproval === "boolean") next.needsApproval = body.needsApproval;
        if (Object.keys(next).length === 0) {
          delete serverOverrides[toolName];
        } else {
          serverOverrides[toolName] = next;
        }
        if (Object.keys(serverOverrides).length === 0) {
          delete overrides[serverId];
        } else {
          overrides[serverId] = serverOverrides;
        }
        // Mirror the global server's "all tools off → master off" rule at the assistant
        // scope: if every globally-enabled tool on this server is now disabled-by-override
        // for this assistant, remove the server from assistant.mcpServers (auto master-off).
        // This is the assistant-level counterpart of Transition 2 in settings/mcp-server/detail.
        let mcpServers = assistant.mcpServers;
        if (assistant.mcpServers.includes(serverId)) {
          const globalServer = (state.settings.mcpServers as Array<Record<string, JsonValue>>).find((s) => String(s.id) === serverId);
          const globalCommon = globalServer && isRecord(globalServer.commonOptions) ? globalServer.commonOptions : null;
          const globalTools = globalCommon && Array.isArray(globalCommon.tools) ? globalCommon.tools.filter(isRecord) : [];
          const visibleTools = globalTools.filter((tool) => tool.enable !== false);
          const serverOverrideForCheck = overrides[serverId] ?? {};
          if (visibleTools.length > 0 && visibleTools.every((tool) => serverOverrideForCheck[String(tool.name ?? "")]?.enable === false)) {
            mcpServers = assistant.mcpServers.filter((sid) => sid !== serverId);
          }
        }
        return { ...assistant, mcpServers, mcpToolOverrides: overrides };
      }),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/injections" && request.method === "POST") {
    const body = await readJson<{
      assistantId: string;
      modeInjectionIds: string[];
      lorebookIds: string[];
      quickMessageIds: string[];
    }>(request);
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === body.assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    let modeInjectionIds: string[];
    let lorebookIds: string[];
    let quickMessageIds: string[];
    try {
      modeInjectionIds = validateKnownJsonIds(state.settings.modeInjections, body.modeInjectionIds, "modeInjectionIds");
      lorebookIds = validateKnownJsonIds(state.settings.lorebooks, body.lorebookIds, "lorebookIds");
      quickMessageIds = validateKnownJsonIds(state.settings.quickMessages, body.quickMessageIds, "quickMessageIds");
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 400);
    }
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId
          ? {
              ...assistant,
              modeInjectionIds,
              lorebookIds,
              quickMessageIds,
            }
          : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/assistant/skills" && request.method === "POST") {
    const body = await readJson<{ assistantId: string; enabledSkills: string[] }>(request);
    const assistantExists = state.settings.assistants.some((assistant) => assistant.id === body.assistantId);
    if (!assistantExists) return error("Assistant not found", 404);
    const installedSkillNames = new Set(listSkills().map((skill) => skill.name));
    const enabledSkills = getStringArray(body.enabledSkills);
    const unknownSkill = enabledSkills.find((skillName) => !installedSkillNames.has(skillName));
    if (unknownSkill) return error(`enabledSkills contains unknown skill: ${unknownSkill}`, 400);
    updateSettings({
      ...state.settings,
      assistants: state.settings.assistants.map((assistant) =>
        assistant.id === body.assistantId ? { ...assistant, enabledSkills } : assistant,
      ),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/mcp-server/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const common = isRecord(body.commonOptions) ? body.commonOptions : {};
    // Read the previous server state so we can detect the user transitioning the main MCP
    // switch from off→on, which has special "revive child switches" semantics (see below).
    const prevServer = (state.settings.mcpServers as Array<Record<string, JsonValue>>)
      .find((item) => String(item.id) === String(body.id ?? "")) ?? null;
    const prevCommon = prevServer && isRecord(prevServer.commonOptions) ? prevServer.commonOptions : null;
    const wasEnabled = prevCommon ? prevCommon.enable !== false : false;
    const willEnable = common.enable !== false;
    let server: Record<string, JsonValue> = {
      type: String(body.type ?? "streamable_http") === "sse" ? "sse" : "streamable_http",
      url: String(body.url ?? ""),
      ...body,
      id: String(body.id ?? id()),
      ssePostEndpoint: String(body.ssePostEndpoint ?? ""),
      commonOptions: {
        enable: willEnable,
        name: String(common.name ?? body.name ?? "MCP Server"),
        headers: Array.isArray(common.headers) ? common.headers : [],
        tools: Array.isArray(common.tools) ? common.tools : [],
        lastSyncAt: typeof common.lastSyncAt === "number" ? common.lastSyncAt : null,
        lastSyncError: String(common.lastSyncError ?? ""),
        connected: common.connected === true,
      },
    };
    if (isRecord(server.commonOptions) && server.commonOptions.enable !== false && String(server.url ?? "").trim()) {
      server = await syncMcpServerTools(server, addLog);
    }
    // ── Master/child switch coupling ─────────────────────────────────────────────────
    // The MCP server's `commonOptions.enable` is a master switch; each tool's `enable`
    // is a child switch that persists across master toggles to preserve user intent.
    //
    // Transition 1 — master off → on:
    //   If every child is currently off (i.e. there's no surviving user preference),
    //   revive them all to ON so the freshly-enabled MCP isn't a no-op surprise. If even
    //   one child is on, the user has expressed an intentional subset — leave it alone.
    //
    // Transition 2 — master is on AND user just turned every child off:
    //   Auto-flip master to off, since an MCP with no enabled tools is a dead control.
    //   This pairs with Transition 1: re-enabling later will revive everything.
    //
    // Transition 3 — master on → off (manual):
    //   DON'T touch child states. The user might just be temporarily hiding MCP from
    //   chat; we want their next re-enable to remember which tools were on.
    if (isRecord(server.commonOptions)) {
      const finalCommon = server.commonOptions as Record<string, JsonValue>;
      const tools = Array.isArray(finalCommon.tools) ? finalCommon.tools.filter(isRecord) : [];
      const allOff = tools.length > 0 && tools.every((tool) => tool.enable === false);
      if (!wasEnabled && willEnable && allOff) {
        // Transition 1: revive child switches.
        server.commonOptions = {
          ...finalCommon,
          tools: tools.map((tool) => ({ ...tool, enable: true })),
        };
      } else if (willEnable && allOff) {
        // Transition 2: auto-flip master off. This catches the "user turned off the last
        // tool" case from the per-tool save path (settings/mcp-server/detail also handles
        // tool toggle saves since the UI debounces a full server snapshot).
        server.commonOptions = { ...finalCommon, enable: false };
      }
      // Transition 3 needs no action — the tools array is already preserved verbatim.
    }
    const result = upsertById(state.settings.mcpServers as JsonValue[], server);
    updateSettings({ ...state.settings, mcpServers: result.items });
    return json({ status: "ok", server: result.item });
  }
  const mcpDelete = path.match(/^settings\/mcp-server\/([^/]+)$/);
  if (mcpDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(mcpDelete[1]);
    updateSettings({
      ...state.settings,
      mcpServers: deleteById(state.settings.mcpServers as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        mcpServers: assistant.mcpServers.filter((serverId) => serverId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/mcp-server/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, mcpServers: reorderByIds(state.settings.mcpServers as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/mcp-server/sync" && request.method === "POST") {
    const body = await readJson<{ serverId: string }>(request);
    const server = (state.settings.mcpServers as Array<Record<string, JsonValue>>).find((item) => String(item.id) === body.serverId);
    if (!server) return error("MCP server not found", 404);
    const nextServer = await syncMcpServerTools(server, addLog);
    const result = upsertById(state.settings.mcpServers as JsonValue[], nextServer);
    updateSettings({ ...state.settings, mcpServers: result.items });
    const common = (isRecord(nextServer.commonOptions) ? nextServer.commonOptions : {}) as Record<string, JsonValue>;
    if (common.connected === false) return error(String(common.lastSyncError ?? "MCP sync failed"), 502);
    return json({ status: "ok", tools: Array.isArray(common.tools) ? common.tools : [], server: result.item });
  }
  if (path === "settings/mode-injection/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const item = {
      type: "mode",
      enabled: true,
      priority: 0,
      position: "after_system_prompt",
      content: "",
      injectDepth: 4,
      role: "USER",
      ...body,
      id: String(body.id ?? id()),
      name: String(body.name ?? "Mode Injection"),
    };
    const result = upsertById(state.settings.modeInjections as JsonValue[], item);
    updateSettings({ ...state.settings, modeInjections: result.items });
    return json({ status: "ok", item: result.item });
  }
  const modeDelete = path.match(/^settings\/mode-injection\/([^/]+)$/);
  if (modeDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(modeDelete[1]);
    updateSettings({
      ...state.settings,
      modeInjections: deleteById(state.settings.modeInjections as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        modeInjectionIds: assistant.modeInjectionIds.filter((itemId) => itemId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/mode-injection/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, modeInjections: reorderByIds(state.settings.modeInjections as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/lorebook/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const item = {
      enabled: true,
      description: "",
      entries: [] as JsonValue[],
      ...body,
      id: String(body.id ?? id()),
      name: String(body.name ?? "Lorebook"),
    };
    const result = upsertById(state.settings.lorebooks as JsonValue[], item);
    updateSettings({ ...state.settings, lorebooks: result.items });
    return json({ status: "ok", item: result.item });
  }
  const lorebookDelete = path.match(/^settings\/lorebook\/([^/]+)$/);
  if (lorebookDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(lorebookDelete[1]);
    updateSettings({
      ...state.settings,
      lorebooks: deleteById(state.settings.lorebooks as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        lorebookIds: assistant.lorebookIds.filter((itemId) => itemId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/lorebook/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, lorebooks: reorderByIds(state.settings.lorebooks as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/quick-message/detail" && request.method === "POST") {
    const body = await readJson<Record<string, JsonValue>>(request);
    const item = { title: "", content: "", ...body, id: String(body.id ?? id()) };
    const result = upsertById(state.settings.quickMessages as JsonValue[], item);
    updateSettings({ ...state.settings, quickMessages: result.items });
    return json({ status: "ok", item: result.item });
  }
  const quickMessageDelete = path.match(/^settings\/quick-message\/([^/]+)$/);
  if (quickMessageDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(quickMessageDelete[1]);
    updateSettings({
      ...state.settings,
      quickMessages: deleteById(state.settings.quickMessages as JsonValue[], idValue),
      assistants: state.settings.assistants.map((assistant) => ({
        ...assistant,
        quickMessageIds: assistant.quickMessageIds.filter((itemId) => itemId !== idValue),
      })),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/quick-message/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    updateSettings({ ...state.settings, quickMessages: reorderByIds(state.settings.quickMessages as JsonValue[], body.ids ?? []) });
    return json({ status: "ok" });
  }
  if (path === "settings/search/enabled" && request.method === "POST") {
    const body = await readJson<{ enabled: boolean }>(request);
    updateSettings({ ...state.settings, enableWebSearch: body.enabled });
    return json({ status: "ok" });
  }
  if (path === "settings/search/service" && request.method === "POST") {
    const body = await readJson<{ index: number }>(request);
    updateSettings({ ...state.settings, searchServiceSelected: body.index });
    return json({ status: "ok" });
  }
  if (path === "settings/search/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[]; selectedId?: string }>(request);
    const services = state.settings.searchServices as Array<Record<string, JsonValue>>;
    const byId = new Map(services.map((item) => [String(item.id), item]));
    const ordered = body.ids.map((itemId) => byId.get(String(itemId))).filter(Boolean) as JsonValue[];
    const rest = services.filter((item) => !body.ids.includes(String(item.id)));
    const searchServices = [...ordered, ...rest];
    const selectedId = body.selectedId ?? String(services[state.settings.searchServiceSelected]?.id ?? "");
    const selectedIndex = Math.max(0, searchServices.findIndex((item) => String((item as Record<string, JsonValue>).id) === selectedId));
    updateSettings({ ...state.settings, searchServices, searchServiceSelected: selectedIndex });
    return json({ status: "ok" });
  }
  if (path === "settings/search/service/detail" && request.method === "POST") {
    const body = await readJson<SearchService>(request);
    const service: SearchService = { ...body, id: String(body.id ?? id()) };
    const services = state.settings.searchServices as SearchService[];
    const existing = services.find((item) => String(item.id) === String(service.id));
    // Invalidate testPassed when any auth/endpoint field changes. Preset types
    // (bing_local, rikkahub) don't need testPassed gating — they always show in chat.
    if (existing && existing.testPassed === true) {
      const authFields = ["type", "apiKey", "url", "customUrl", "model", "username", "password", "engines"];
      const changed = authFields.some((key) => String(existing[key] ?? "") !== String(service[key] ?? ""));
      if (changed) {
        service.testPassed = false;
        service.testPassedAt = 0;
      } else {
        service.testPassed = existing.testPassed;
        service.testPassedAt = existing.testPassedAt;
      }
    }
    updateSettings({
      ...state.settings,
      searchServices: existing ? services.map((item) => (String(item.id) === String(service.id) ? service : item)) : [...services, service],
      searchServiceSelected: existing ? state.settings.searchServiceSelected : services.length,
    });
    return json({ status: "ok", service });
  }
  if (path === "settings/search/service/test" && request.method === "POST") {
    const body = await readJson<SearchService>(request);
    try {
      const result = await testSearchService(body);
      // 多 key 服务全量测试后始终返回结构化结果(含每个 key 的状态),不再用 502 表达"某个 key 失败"。
      // 只有 status=ok(至少一个 key 可用,或无 key 服务直连成功)才标 testPassed,让搜索 picker 放行。
      if (result.status === "ok") {
        const services = state.settings.searchServices as SearchService[];
        const targetId = String(body.id ?? "");
        if (targetId) {
          updateSettings({
            ...state.settings,
            searchServices: services.map((item) =>
              String(item.id) === targetId ? { ...item, testPassed: true, testPassedAt: Date.now() } : item,
            ),
          });
        }
      }
      return json(result);
    } catch (err) {
      return error(friendlyRequestError(err, state.settings.proxyConfig), 502);
    }
  }
  const searchDelete = path.match(/^settings\/search\/service\/([^/]+)$/);
  if (searchDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(searchDelete[1]);
    const services = state.settings.searchServices as SearchService[];
    const nextServices = services.filter((item) => String(item.id) !== idValue);
    updateSettings({
      ...state.settings,
      searchServices: nextServices,
      searchServiceSelected: Math.min(state.settings.searchServiceSelected, Math.max(0, nextServices.length - 1)),
    });
    return json({ status: "deleted" });
  }
  if (path === "settings/default-models" && request.method === "POST") {
    const body = await readJson<Partial<Settings>>(request);
    updateSettings({
      ...state.settings,
      chatModelId: String(body.chatModelId ?? state.settings.chatModelId),
      titleModelId: String(body.titleModelId ?? state.settings.titleModelId),
      translateModeId: String(body.translateModeId ?? state.settings.translateModeId),
      suggestionModelId: String(body.suggestionModelId ?? state.settings.suggestionModelId),
      imageGenerationModelId: String(body.imageGenerationModelId ?? state.settings.imageGenerationModelId),
      ocrModelId: String(body.ocrModelId ?? state.settings.ocrModelId),
      compressModelId: String(body.compressModelId ?? state.settings.compressModelId),
      promptOptimizeModelId: String(body.promptOptimizeModelId ?? state.settings.promptOptimizeModelId ?? ""),
      promptOptimizePrompt: String(body.promptOptimizePrompt ?? state.settings.promptOptimizePrompt ?? DEFAULT_PROMPT_OPTIMIZE_PROMPT),
      titlePrompt: String(body.titlePrompt ?? state.settings.titlePrompt ?? DEFAULT_TITLE_PROMPT),
      translatePrompt: String(body.translatePrompt ?? state.settings.translatePrompt ?? DEFAULT_TRANSLATION_PROMPT),
      suggestionPrompt: String(body.suggestionPrompt ?? state.settings.suggestionPrompt ?? DEFAULT_SUGGESTION_PROMPT),
      ocrPrompt: String(body.ocrPrompt ?? state.settings.ocrPrompt ?? DEFAULT_OCR_PROMPT),
      compressPrompt: String(body.compressPrompt ?? state.settings.compressPrompt ?? DEFAULT_COMPRESS_PROMPT),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/favorite-models" && request.method === "POST") {
    const body = await readJson<{ modelIds: string[] }>(request);
    updateSettings({ ...state.settings, favoriteModels: body.modelIds ?? [] });
    return json({ status: "ok" });
  }
  if (path === "settings/model/built-in-tool" && request.method === "POST") {
    const body = await readJson<{ modelId: string; tool: string; enabled: boolean }>(request);
    const toolName = String(body.tool ?? "").trim();
    updateSettings({
      ...state.settings,
      providers: state.settings.providers.map((providerItem) => ({
        ...providerItem,
        models: providerItem.models.map((modelItem) => {
          if (modelItem.id !== body.modelId) return modelItem;
          const existingTools = Array.isArray(modelItem.tools) ? modelItem.tools : [];
          const nextTools = body.enabled
            ? [...existingTools.filter((tool) => String((tool as Record<string, JsonValue>).type ?? tool) !== toolName), { type: toolName }]
            : existingTools.filter((tool) => String((tool as Record<string, JsonValue>).type ?? tool) !== toolName);
          return { ...modelItem, tools: nextTools };
        }),
      })),
    });
    return json({ status: "ok" });
  }
  if (path === "settings/provider" && request.method === "POST") {
    const body = await readJson<Provider>(request);
    updateSettings({
      ...state.settings,
      providers: state.settings.providers.some((item) => item.id === body.id)
        ? state.settings.providers.map((item) =>
          item.id === body.id
            ? {
                ...item,
                ...body,
                testPassed: item.testPassed === true ? true : body.testPassed,
                testPassedAt: item.testPassed === true ? item.testPassedAt : body.testPassedAt,
              }
            : item,
        )
        : [...state.settings.providers, { ...body, id: body.id || id(), builtIn: false }],
    });
    return json({ status: "ok" });
  }
  const providerDelete = path.match(/^settings\/provider\/([^/]+)$/);
  if (providerDelete && request.method === "DELETE") {
    const idValue = decodeURIComponent(providerDelete[1]);
    if (state.settings.providers.length <= 1) return error("At least one provider is required", 400);
    updateSettings({ ...state.settings, providers: state.settings.providers.filter((item) => item.id !== idValue) });
    return json({ status: "deleted" });
  }
  if (path === "settings/provider/reorder" && request.method === "POST") {
    const body = await readJson<{ ids: string[] }>(request);
    const byId = new Map(state.settings.providers.map((item) => [item.id, item]));
    const ordered = body.ids.map((itemId) => byId.get(itemId)).filter(Boolean) as Provider[];
    const rest = state.settings.providers.filter((item) => !body.ids.includes(item.id));
    updateSettings({ ...state.settings, providers: [...ordered, ...rest] });
    return json({ status: "ok" });
  }
  if (path === "settings/provider/balance" && request.method === "POST") {
    const body = await readJson<{ providerId: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    try {
      return json(await fetchProviderBalance(providerItem));
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "settings/provider/test" && request.method === "POST") {
    const body = await readJson<{ providerId: string; modelId?: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    try {
      const result = await fetchProviderModels(providerItem);
      const selectedModel = firstProviderModel(providerItem, body.modelId, result.models);
      const checks = [];
      for (const mode of ["non_stream", "stream", "tools"] as const) {
        checks.push(await runProviderCheck(providerItem, mode, selectedModel, result.models).catch((err) => ({
          mode,
          ok: false,
          status: 0,
          endpoint: endpointFor(providerItem),
          preview: friendlyRequestError(err, state.settings.proxyConfig),
        })));
      }
      markProviderTestResult(providerItem, checks);
      return json({
        status: "ok",
        endpoint: result.endpoint,
        responseApiEndpoint: endpointFor(providerItem),
        testModelId: selectedModel,
        modelCount: result.models.length,
        models: result.models.slice(0, 20),
        checks,
        preview: result.preview,
      });
    } catch (err) {
      return error(friendlyRequestError(err, state.settings.proxyConfig), 502);
    }
  }

  if (path === "settings/provider/test/image" && request.method === "POST") {
    const body = await readJson<{ providerId: string; modelId?: string; prompt?: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    const requestedModelId = String(body.modelId ?? "").trim();
    const modelItem = (providerItem.models ?? []).find((item) => item.modelId === requestedModelId)
      ?? (providerItem.models ?? []).find((item) => (item.type as string) === "IMAGE")
      ?? null;
    if (!modelItem) return error("No image model available for this provider", 400);
    // 4-4:显式 modelId 覆盖复用生图管线;此前临时改写全局 imageGenerationModelId
    // 再 finally 还原,测试期间的真实生图/并发的另一个测试会读到被测模型(多标签页下必现)。
    try {
      const prompt = String(body.prompt ?? "A red apple on a white background").trim() || "A red apple on a white background";
      const images = await callImageGeneration({ prompt, numberOfImages: 1, aspectRatio: "square", overrideModelUuid: modelItem.id });
      const generated = images[0];
      if (!generated) return error("Image generation returned no images", 502);
      return json({
        status: "ok",
        modelId: modelItem.modelId,
        image: { url: generated.url, mime: generated.mime, fileName: generated.fileName },
      });
    } catch (err) {
      return error(friendlyRequestError(err, state.settings.proxyConfig), 502);
    }
  }

  if (path === "settings/provider/test/stream" && request.method === "POST") {
    const body = await readJson<{ providerId: string; modelId?: string }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: JsonValue | object) => controller.enqueue(sseFrame(event, payload));
        try {
          send("progress", { message: "正在读取模型列表..." });
          const result = await fetchProviderModels(providerItem);
          const selectedModel = firstProviderModel(providerItem, body.modelId, result.models);
          send("models", {
            endpoint: result.endpoint,
            responseApiEndpoint: endpointFor(providerItem),
            testModelId: selectedModel,
            modelCount: result.models.length,
            models: result.models.slice(0, 20),
            preview: result.preview,
          });
          const checks = [];
          for (const mode of ["non_stream", "stream", "tools"] as const) {
            send("progress", { message: `正在测试 ${mode}...` });
            const check = await runProviderCheck(providerItem, mode, selectedModel, result.models).catch((err) => ({
              mode,
              ok: false,
              status: 0,
              endpoint: endpointFor(providerItem),
              preview: friendlyRequestError(err, state.settings.proxyConfig),
            }));
            checks.push(check);
            send("check", check);
          }
          markProviderTestResult(providerItem, checks);
          send("done", {
            status: "ok",
            endpoint: result.endpoint,
            responseApiEndpoint: endpointFor(providerItem),
            testModelId: selectedModel,
            modelCount: result.models.length,
            models: result.models.slice(0, 20),
            checks,
            preview: result.preview,
          });
        } catch (err) {
          send("error", { error: friendlyRequestError(err, state.settings.proxyConfig) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
  if (path === "settings/provider/models" && request.method === "POST") {
    const body = await readJson<{ providerId: string; save?: boolean }>(request);
    const providerItem = state.settings.providers.find((item) => item.id === body.providerId);
    if (!providerItem) return error("Provider not found", 404);
    // 用户主动获取模型列表——大概率是想试新模型。顺带刷新 models.dev 缓存,让新模型
    // 的 context 上限立即可用(不用等每日 TTL)。fire-and-forget,不阻塞模型列表返回。
    void loadModelsDev(true);
    try {
      const result = await fetchProviderModels(providerItem);
      if (body.save) {
        updateSettings({
          ...state.settings,
          providers: state.settings.providers.map((item) =>
            item.id === providerItem.id ? { ...item, models: result.models } : item,
          ),
        });
      }
      return json({ status: "ok", endpoint: result.endpoint, models: result.models, preview: result.preview });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }
  if (path === "settings/proxy" && request.method === "POST") {
    const body = await readJson<Partial<ProxyConfig>>(request);
    // P0-2: Bun fetch 静默丢弃 SOCKS 代理(表现为直连失败), 这里显式拒绝。
    // 前端 save() 也有同样校验, 此处为防御性(防止其它调用方绕过前端直接 POST)。
    const trimmedUrl = String(body?.url ?? "").trim();
    if (/^socks/i.test(trimmedUrl)) {
      return json(
        { error: "SOCKS proxy is not supported (Bun fetch only handles HTTP/HTTPS). Please use the proxy tool's HTTP port." },
        { status: 400 },
      );
    }
    const proxyConfig = normalizeProxyConfig(body);
    updateSettings({ ...state.settings, proxyConfig });
    applyEffectiveProxy(state.settings.proxyConfig);
    return json({ status: "ok", config: proxyConfig, ...proxyStatusPayload(state.settings.proxyConfig) });
  }
  if (path === "settings/port" && request.method === "POST") {
    const body = await readJson<{ port?: number | null }>(request).catch(
      () => ({}) as { port?: number | null },
    );
    const preferredPort = normalizePreferredPort(body?.port);
    updateSettings({ ...state.settings, preferredPort });
    // The port is only consulted at startup, so this change takes effect on the next launch.
    // The running server keeps its current port; we return requiresRestart so the UI can tell
    // the user to restart.
    return json({ status: "ok", preferredPort, requiresRestart: true });
  }
  if (path === "settings/proxy/detect" && request.method === "POST") {
    const detected = readWindowsSystemProxy();
    return json({ detected: detected ?? null });
  }
  if (path === "settings/proxy/status" && request.method === "GET") {
    return json(proxyStatusPayload(state.settings.proxyConfig));
  }
  if (path === "settings/proxy/test" && request.method === "POST") {
    // 测试当前生效代理能否真的连通。显式传 proxy 选项绕过 env —— 否则降级态下 env 已清,
    // fetch 会直连成功, 误判成"代理通了"。用户可指定测试 URL (默认 generate_204 轻量快速)。
    const { url } = resolveEffectiveProxy(state.settings.proxyConfig);
    if (!url) return json({ ok: false, error: "no_proxy" });
    let testUrl = "https://www.gstatic.com/generate_204";
    try {
      const body = await request.json();
      if (typeof body?.url === "string") {
        let u = body.url.trim();
        // 用户可能填 "example.com" 不带协议 — 自动补 https://, 否则下面的正则会拒绝,
        // 回退到默认 gstatic, 表现为"改了测试 URL 但梯子日志仍 ping gstatic"。
        if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
        if (/^https?:\/\//i.test(u)) testUrl = u;
      }
    } catch { /* 空 body 用默认 */ }
    const t0 = Date.now();
    try {
      const resp = await fetch(testUrl, {
        proxy: url,
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
      });
      // 2xx/3xx 都算通 (代理能回应 = 通; 5xx 可能是代理报错或目标不可达, 算不通)
      const ok = resp.status >= 200 && resp.status < 400;
      return json({ ok, status: resp.status, latencyMs: Date.now() - t0 });
    } catch (e) {
      return json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - t0,
      });
    }
  }
  return null;
}
