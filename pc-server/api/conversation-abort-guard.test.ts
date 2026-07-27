// 2-1 回归:regenerate / messages/edit / compress 三入口开头必须对齐 send 的 abort
// 序列——中止进行中的旧流并从 generating 摘除,否则 generateAnswer 的 generating.set
// 会顶掉旧 controller,旧流成为无主流(双流写同节点/幽灵广播)。
// 经 compress 路由驱动 handleConversationRoutes(三入口共享同一段守卫):压缩本身
// 因消息不足返回 400,但守卫必须已经生效。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Conversation, State } from "../foundation/types";
import { generating } from "../conversations/generation-state";
import { configureWorkingSet, registerConversation } from "../conversations/working-set";
import { setState, state } from "../persistence/json-store";
import { handleConversationRoutes } from "./handlers/conversations";

const priorState = state;

beforeAll(() => {
  setState({ settings: { assistantId: "a1", assistants: [], chatModelId: "" } } as unknown as State);
  configureWorkingSet({
    loadConversation: () => undefined,
    isGenerating: (id) => generating.has(id),
    hasSseClients: () => false,
    hasDirty: () => false,
  });
});

afterAll(() => {
  setState(priorState);
});

function makeConversation(id: string): Conversation {
  const now = Date.now();
  return {
    id,
    assistantId: "a1",
    title: "abort-guard",
    messages: [
      {
        id: `${id}-n1`,
        selectIndex: 0,
        messages: [
          {
            id: `${id}-m1`,
            role: "USER",
            parts: [{ type: "text", text: "hello" }],
            annotations: [],
            createdAt: new Date(now).toISOString(),
            finishedAt: null,
            translation: null,
          },
        ],
      },
    ],
    isPinned: false,
    createAt: now,
    updateAt: now,
    chatSuggestions: [],
  } as unknown as Conversation;
}

async function postCompress(conversationId: string): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1/api/conversations/${conversationId}/compress`);
  const request = new Request(url, {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
  });
  return handleConversationRoutes(request, url, `conversations/${conversationId}/compress`);
}

describe("三入口 abort 守卫(2-1)", () => {
  test("compress 入口:进行中的旧流被 abort 并从 generating 摘除", async () => {
    const conv = makeConversation("c-abort-1");
    registerConversation(conv);
    const controller = new AbortController();
    generating.set(conv.id, controller);

    const response = await postCompress(conv.id);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    expect(controller.signal.aborted).toBe(true);
    expect(generating.has(conv.id)).toBe(false);
  });

  test("无进行中旧流时守卫是幂等 no-op,请求正常走到业务逻辑", async () => {
    const conv = makeConversation("c-abort-2");
    registerConversation(conv);

    const response = await postCompress(conv.id);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    expect(generating.has(conv.id)).toBe(false);
  });
});
