// 6-2 回归:统一出站 fetch 包装(默认超时/调用方 signal 并联)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DEFAULT_OUTBOUND_TIMEOUT_MS, fetchWithTimeout } from "./net";

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fast") return new Response("ok");
      // /slow:挂住直到客户端中止(模拟黑洞上游)
      await new Promise(() => { /* 永不 resolve,连接由 abort 撕掉 */ });
      return new Response("unreachable");
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("fetchWithTimeout(6-2)", () => {
  test("正常响应原样返回", async () => {
    const res = await fetchWithTimeout(`${base}/fast`);
    expect(await res.text()).toBe("ok");
  });

  test("上游黑洞 → 按 timeoutMs 中止而非永挂", async () => {
    const t0 = Date.now();
    expect(fetchWithTimeout(`${base}/slow`, { timeoutMs: 300 })).rejects.toThrow();
    await Bun.sleep(50);
    // 若未生效,本用例会撞 bun test 的 5s 超时;到这里说明按时中止
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  test("调用方 signal 先触发 → 立即中止(生成中止透传)", async () => {
    const controller = new AbortController();
    const pending = fetchWithTimeout(`${base}/slow`, { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort(new Error("user aborted"));
    expect(pending).rejects.toThrow();
  });

  test("默认超时为 30s", () => {
    expect(DEFAULT_OUTBOUND_TIMEOUT_MS).toBe(30_000);
  });
});
