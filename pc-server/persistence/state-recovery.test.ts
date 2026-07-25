// 全面审查 1-2/1-3 回归测试:state.json 损坏恢复链与每日滚动备份。
// 原缺陷:performStateSave 兜底写出的 recovery-*.json 全项目零读取,损坏回退只认
// 1.2.6 迁移时代的化石 pre-sqlite.bak——磁盘上躺着最新完整状态却回滚到远古设置。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maybeWriteDailyBackupTo, recoverStateFromBackups } from "./json-store";

function tempDataDir(): { dir: string; statePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rkh-state-recovery-"));
  return { dir, statePath: join(dir, "state.json") };
}

describe("recoverStateFromBackups(1-2 恢复链)", () => {
  test("优先采用最新 recovery 文件,并归档(改名 .applied-*)防止重复使用", () => {
    const { dir, statePath } = tempDataDir();
    writeFileSync(join(dir, "state.json.recovery-1000.json"), JSON.stringify({ settings: { assistantId: "旧" } }));
    writeFileSync(join(dir, "state.json.recovery-2000.json"), JSON.stringify({ settings: { assistantId: "新" } }));
    writeFileSync(join(dir, "state.json.pre-sqlite.bak"), JSON.stringify({ settings: { assistantId: "化石" } }));

    const recovered = recoverStateFromBackups(dir, statePath);
    expect((recovered?.settings as { assistantId: string }).assistantId).toBe("新");
    const names = readdirSync(dir);
    expect(names.some((n) => n.startsWith("state.json.recovery-2000.json.applied-"))).toBe(true);
    expect(names).toContain("state.json.recovery-1000.json"); // 未用到的保持原样
  });

  test("最新 recovery 损坏时回退到更早的 recovery", () => {
    const { dir, statePath } = tempDataDir();
    writeFileSync(join(dir, "state.json.recovery-1000.json"), JSON.stringify({ settings: { assistantId: "早但完好" } }));
    writeFileSync(join(dir, "state.json.recovery-2000.json"), "{损坏的json");

    const recovered = recoverStateFromBackups(dir, statePath);
    expect((recovered?.settings as { assistantId: string }).assistantId).toBe("早但完好");
  });

  test("无 recovery 时用每日滚动备份(1-3 与 1-2 组成梯队)", () => {
    const { dir, statePath } = tempDataDir();
    writeFileSync(`${statePath}.daily.bak`, JSON.stringify({ settings: { assistantId: "昨日" } }));
    writeFileSync(join(dir, "state.json.pre-sqlite.bak"), JSON.stringify({ settings: { assistantId: "化石" } }));

    const recovered = recoverStateFromBackups(dir, statePath);
    expect((recovered?.settings as { assistantId: string }).assistantId).toBe("昨日");
  });

  test("只剩 pre-sqlite.bak 时仍可用(化石好过默认)", () => {
    const { dir, statePath } = tempDataDir();
    writeFileSync(join(dir, "state.json.pre-sqlite.bak"), JSON.stringify({ settings: { assistantId: "化石" } }));

    const recovered = recoverStateFromBackups(dir, statePath);
    expect((recovered?.settings as { assistantId: string }).assistantId).toBe("化石");
  });

  test("空目录返回 null(调用方回默认状态)", () => {
    const { dir, statePath } = tempDataDir();
    expect(recoverStateFromBackups(dir, statePath)).toBeNull();
  });
});

describe("maybeWriteDailyBackupTo(1-3 每日滚动备份)", () => {
  test("当日首写落盘,同日不重复,跨日覆盖为单代", () => {
    const { statePath } = tempDataDir();
    const bakPath = `${statePath}.daily.bak`;
    const day1 = new Date("2099-01-01T08:00:00Z");
    const day1Later = new Date("2099-01-01T20:00:00Z");
    const day2 = new Date("2099-01-02T08:00:00Z");

    expect(maybeWriteDailyBackupTo(bakPath, '{"v":1}', day1)).toBe(true);
    expect(statSync(bakPath).size).toBeGreaterThan(0);
    const firstMtime = statSync(bakPath).mtimeMs;

    // 同日第二次:内存记忆命中,不重写
    expect(maybeWriteDailyBackupTo(bakPath, '{"v":2}', day1Later)).toBe(false);
    expect(statSync(bakPath).mtimeMs).toBe(firstMtime);

    // 次日:覆盖同一文件(单代滚动)
    expect(maybeWriteDailyBackupTo(bakPath, '{"v":3}', day2)).toBe(true);
    expect(JSON.parse(require("node:fs").readFileSync(bakPath, "utf8")).v).toBe(3);
  });
});
