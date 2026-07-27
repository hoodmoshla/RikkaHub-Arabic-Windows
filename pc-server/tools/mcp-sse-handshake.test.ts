// 批次三 R3-2 回归:SSE 型 MCP 握手预算以外层 timeoutMs 为准,不再被"每次 read 包 1s
// reject"卡死。旧实现下服务器静默超 1 秒(冷启动/跨洋高延迟)即握手失败;新实现用 1s tick
// 唤醒复查预算,只要 endpoint 事件在总预算内到达就成功。
import { describe, expect, test } from "bun:test";

import { readMcpSseUntilEndpoint } from "./mcp";

// 构造一个 SSE 响应体:先静默 delayMs,再发 endpoint 事件(可选);endless=true 则永不发。
function sseResponse(opts: { delayMs: number; endpoint?: string; endless?: boolean }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.endless) {
        // 发一个无关的注释帧证明"有字节但无 endpoint",然后挂住直到被 cancel。
        controller.enqueue(encoder.encode(": keepalive\n\n"));
        return;
      }
      controller.enqueue(encoder.encode(`event: endpoint\ndata: ${opts.endpoint}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

describe("readMcpSseUntilEndpoint(R3-2)", () => {
  test("endpoint 事件静默 >1s 后到达仍握手成功(旧实现会在 1s 失败)", async () => {
    const res = sseResponse({ delayMs: 1300, endpoint: "/messages?sessionId=abc" });
    const endpoint = await readMcpSseUntilEndpoint(res, 15000);
    expect(endpoint).toBe("/messages?sessionId=abc");
  });

  test("超过总预算仍无 endpoint 才失败(报错含总预算秒数)", async () => {
    const res = sseResponse({ delayMs: 0, endless: true });
    await expect(readMcpSseUntilEndpoint(res, 800)).rejects.toThrow(/timeout after 1s/);
  });
});
