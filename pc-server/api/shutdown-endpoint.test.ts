// 全面审查 8-2/1-1 回归测试:优雅停机端点端到端契约——POST /api/app/shutdown 必须在
// 全部状态刷盘后返回 200,随后进程以 0 码自退。Tauri 壳(Windows kill=TerminateProcess,
// 信号钩子不运行)依赖这个契约:收到 200 后硬杀是零丢失的。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverEntry = join(import.meta.dir, "..", "server.ts");

async function waitForPortLine(proc: ReturnType<typeof Bun.spawn>): Promise<number> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    const m = acc.match(/RIKKAHUB_PORT:(\d+)/);
    if (m) {
      reader.releaseLock();
      return Number(m[1]);
    }
  }
  reader.releaseLock();
  throw new Error(`服务端未打印端口标记,输出:\n${acc.slice(0, 2000)}`);
}

describe("POST /api/app/shutdown(优雅停机端点)", () => {
  test("返回 200 后进程以 0 码自退", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-shutdown-e2e-"));
    const proc = Bun.spawn(["bun", serverEntry, "--port", "18230", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForPortLine(proc);
      const res = await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

      // 200 的契约:刷盘已完成,进程随后自退(端点内 100ms 延迟 + 退出)
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error("进程 5s 内未自退")), 5000)),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      proc.kill();
    }
  }, 30_000);

  test("GET 方法不触发停机(只接受 POST)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-shutdown-e2e2-"));
    const proc = Bun.spawn(["bun", serverEntry, "--port", "18240", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForPortLine(proc);
      const res = await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "GET" });
      expect(res.status).not.toBe(200);
      // 服务仍然活着
      const alive = await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" });
      expect(alive.status).toBe(200);
    } finally {
      proc.kill();
    }
  }, 30_000);
});
