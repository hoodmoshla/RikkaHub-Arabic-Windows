// 会话详情 SSE 增量应用(FE-P1-3:从 routes/conversations.tsx 原样迁出以便单测)。
// 这是流式渲染的核心数据通路:node_update 事件携带完整增长中的节点,这里把它并进
// 当前快照。行为契约见测试 conversation-sync.test.ts。
import type { ConversationDto, ConversationNodeUpdateEventDto } from "~/types";

export function applyNodeUpdate(
  conversation: ConversationDto,
  event: ConversationNodeUpdateEventDto,
): ConversationDto {
  if (conversation.id !== event.conversationId) {
    return conversation;
  }

  const nextNodes = [...conversation.messages];
  const indexById = nextNodes.findIndex((node) => node.id === event.nodeId);
  const targetIndex = indexById >= 0 ? indexById : event.nodeIndex;

  if (targetIndex < 0) {
    return conversation;
  }

  if (targetIndex < nextNodes.length) {
    nextNodes[targetIndex] = event.node;
  } else if (targetIndex === nextNodes.length) {
    nextNodes.push(event.node);
  } else {
    nextNodes.push(event.node);
  }

  return {
    ...conversation,
    messages: nextNodes,
    updateAt: event.updateAt,
    isGenerating: event.isGenerating,
  };
}
