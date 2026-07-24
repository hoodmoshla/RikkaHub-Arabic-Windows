// applyNodeUpdate 行为契约(FE-P1-3):这是流式渲染的核心数据通路,
// SSE node_update 帧如何并进当前会话快照的全部语义都钉在这里。
import { describe, expect, test } from "bun:test";

import type { ConversationDto, ConversationNodeUpdateEventDto, MessageNodeDto } from "~/types";
import { applyNodeUpdate } from "./conversation-sync";

function node(id: string, text: string): MessageNodeDto {
  return {
    id,
    selectIndex: 0,
    messages: [
      {
        id: `${id}-m`,
        role: "ASSISTANT",
        parts: [{ type: "text", text }],
        annotations: [],
        createdAt: "2026-07-24T00:00:00",
        finishedAt: null,
        modelId: null,
        usage: null,
        translation: null,
      },
    ],
  };
}

function conversation(nodes: MessageNodeDto[]): ConversationDto {
  return {
    id: "c1",
    assistantId: "a1",
    systemPrompt: null,
    title: "标题",
    messages: nodes,
    truncateIndex: -1,
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 1,
    isGenerating: false,
  };
}

function event(overrides: Partial<ConversationNodeUpdateEventDto>): ConversationNodeUpdateEventDto {
  return {
    type: "node_update",
    seq: 100,
    conversationId: "c1",
    nodeId: "n1",
    nodeIndex: 0,
    node: node("n1", "更新后"),
    updateAt: 200,
    isGenerating: true,
    serverTime: 300,
    ...overrides,
  };
}

describe("applyNodeUpdate", () => {
  test("非本会话事件原样返回(同引用,不误伤当前打开的会话)", () => {
    const conv = conversation([node("n1", "旧")]);
    expect(applyNodeUpdate(conv, event({ conversationId: "other" }))).toBe(conv);
  });

  test("按 nodeId 命中替换,并采用事件的 updateAt/isGenerating", () => {
    const conv = conversation([node("n1", "旧"), node("n2", "保持")]);
    const next = applyNodeUpdate(conv, event({}));
    expect(next).not.toBe(conv);
    expect(next.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "更新后" }]);
    expect(next.messages[1]).toBe(conv.messages[1]!);
    expect(next.updateAt).toBe(200);
    expect(next.isGenerating).toBe(true);
    // 原快照不被修改(React state 不可变契约)
    expect(conv.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "旧" }]);
  });

  test("nodeId 命中优先于 nodeIndex(服务端 index 与本地错位时以 id 为准)", () => {
    const conv = conversation([node("n1", "一"), node("n2", "二")]);
    const next = applyNodeUpdate(conv, event({ nodeId: "n2", nodeIndex: 0, node: node("n2", "新二") }));
    expect(next.messages[0]!.messages[0]!.parts).toEqual([{ type: "text", text: "一" }]);
    expect(next.messages[1]!.messages[0]!.parts).toEqual([{ type: "text", text: "新二" }]);
  });

  test("nodeId 未命中时回退 nodeIndex 替换", () => {
    const conv = conversation([node("n1", "一"), node("n2", "二")]);
    const next = applyNodeUpdate(conv, event({ nodeId: "n9", nodeIndex: 1, node: node("n9", "顶掉二") }));
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]!.id).toBe("n9");
  });

  test("nodeIndex 等于当前长度时追加(生成新回复的首帧)", () => {
    const conv = conversation([node("n1", "一")]);
    const next = applyNodeUpdate(conv, event({ nodeId: "n2", nodeIndex: 1, node: node("n2", "新节点") }));
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]!.id).toBe("n2");
  });

  test("nodeIndex 越过当前长度也追加(帧乱序到达不丢内容)", () => {
    const conv = conversation([node("n1", "一")]);
    const next = applyNodeUpdate(conv, event({ nodeId: "n3", nodeIndex: 5, node: node("n3", "跳跃") }));
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]!.id).toBe("n3");
  });

  test("nodeId 未命中且 nodeIndex 为负时原样返回(防御异常帧)", () => {
    const conv = conversation([node("n1", "一")]);
    expect(applyNodeUpdate(conv, event({ nodeId: "n9", nodeIndex: -1 }))).toBe(conv);
  });
});
