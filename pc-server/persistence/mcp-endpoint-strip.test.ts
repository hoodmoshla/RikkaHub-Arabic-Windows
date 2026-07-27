// 批次三 R3-3 回归:normalizeState 必须一次性剥除持久化的 mcpServers[].ssePostEndpoint。
// 该字段是运行时会话缓存(常带 sessionId),曾被误写进 settings;服务器重启即失效,留在
// 磁盘会让重启 PC 也救不回来。每次加载无条件剥除,天然覆盖备份恢复带回的旧值。
import { describe, expect, test } from "bun:test";
import { normalizeState } from "./state-load";
import type { JsonValue } from "../foundation/types";

function servers(state: ReturnType<typeof normalizeState>) {
  return state.settings.mcpServers as Array<Record<string, JsonValue>>;
}

describe("R3-3 mcpServers.ssePostEndpoint 剥离", () => {
  test("持久化的 ssePostEndpoint 被剥除,其余字段原样保留", () => {
    const state = normalizeState({
      settings: {
        mcpServers: [
          {
            id: "s1",
            type: "sse",
            url: "https://mcp.example/sse",
            ssePostEndpoint: "https://mcp.example/messages?sessionId=stale",
            commonOptions: { enable: true, name: "X", headers: [], tools: [] },
          },
        ],
      } as any,
    });
    const s = servers(state)[0];
    expect("ssePostEndpoint" in s).toBe(false);
    expect(s.id).toBe("s1");
    expect(s.url).toBe("https://mcp.example/sse");
    expect((s.commonOptions as Record<string, JsonValue>).name).toBe("X");
  });

  test("无该字段的 streamable_http 服务器原样通过", () => {
    const state = normalizeState({
      settings: {
        mcpServers: [{ id: "s2", type: "streamable_http", url: "https://mcp.example/mcp", commonOptions: { enable: true } }],
      } as any,
    });
    expect("ssePostEndpoint" in servers(state)[0]).toBe(false);
    expect(servers(state)[0].id).toBe("s2");
  });
});
