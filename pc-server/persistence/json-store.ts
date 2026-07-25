// persistence/json-store.ts — state.json 读写与状态对象
// 纪律：负责 state 对象的持久化和共享，不依赖业务逻辑（阶段 2/3 逐步解耦 normalizeState）。

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fsPromises from "node:fs/promises";
import { dataDir, statePath } from "../foundation/paths";
import { reportError } from "../observability/app-errors";
import type { State } from "../foundation/types";

// 迁移常量：诞生版本档案，不可改。从 server.ts 迁出以便 persistence 层自包含。
export const CONVERSATIONS_SQLITE_MIGRATION = "conversations-sqlite-1.2.6";
export const MEMORY_FILE_SPLIT_MIGRATION = "memory-file-split-1.3.2";

// 全局状态对象。由 server.ts 在启动时通过 loadState() 初始化并赋值。
export let state!: State;
export function setState(next: State) { state = next; }

let pendingThrottledSave: ReturnType<typeof setTimeout> | null = null;
let lastSaveStateMs = 0;
const STREAM_SAVE_INTERVAL_MS = 200;

export function scheduleThrottledSaveState() {
  const now = Date.now();
  const elapsed = now - lastSaveStateMs;
  if (elapsed >= STREAM_SAVE_INTERVAL_MS) {
    if (pendingThrottledSave) {
      clearTimeout(pendingThrottledSave);
      pendingThrottledSave = null;
    }
    saveState();
    return;
  }
  if (pendingThrottledSave) return;
  pendingThrottledSave = setTimeout(() => {
    pendingThrottledSave = null;
    saveState();
  }, STREAM_SAVE_INTERVAL_MS - elapsed);
}

let activeSaveStatePromise: Promise<void> | null = null;
let coalescedSaveRequested = false;

async function performStateSave(): Promise<void> {
  lastSaveStateMs = Date.now();
  mkdirSync(dataDir, { recursive: true });
  // No pretty-printing — state.json is read by the server, not humans. On a large state
  // (post-import), the indentation alone can double serialize CPU cost.
  // logs 是内存态运行时缓冲（对齐移动端，重启清空），不写入 state.json。
  // JSON.stringify 对值为 undefined 的属性会省略键，故 logs 不会落盘。
  // conversations:仅当迁移标记（conversations-sqlite-1.2.6）已写时才排除——此时活库是
  // 权威源，state.json 瘦身。迁移未完成时必须保留 conversations，确保 state.json 始终是
  // 合法的重试源：若迁移失败后这里把会话抹空，下次启动 parsed.conversations 为空、活库也空，
  // 会话永久丢失（详见 migrateConversationsIfNeeded 的方案 B 兜底）。
  const convSqliteMigrated = Array.isArray(state.appliedMigrations)
    && state.appliedMigrations.includes(CONVERSATIONS_SQLITE_MIGRATION);
  const memoryFileSplit = Array.isArray(state.appliedMigrations)
    && state.appliedMigrations.includes(MEMORY_FILE_SPLIT_MIGRATION);
  // 与 conversations 同理：记忆迁移未完成时必须保留 state.memories，确保 state.json 始终
  // 是合法的重试源（迁移失败下次启动重试）；迁移完成后排除，瘦身且以 memory/ 为权威。
  const content = JSON.stringify({
    ...state,
    logs: undefined,
    ...(convSqliteMigrated ? { conversations: undefined } : {}),
    ...(memoryFileSplit ? { memories: undefined, nextMemoryId: undefined } : {}),
  });
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      // Bun.write is non-blocking — yields to the event loop while the OS does the I/O.
      await Bun.write(tempPath, content);
      // fs.promises.rename is also non-blocking. The atomic temp-then-rename pattern
      // protects against torn writes if the process is killed mid-save.
      await fsPromises.rename(tempPath, statePath);
      maybeWriteDailyBackup(content);
      return;
    } catch (errorValue) {
      lastError = errorValue;
      try { await fsPromises.unlink(tempPath); } catch { /* cleanup best-effort */ }
      // Backoff via setTimeout/await rather than busy-wait — frees the event loop during
      // the retry delay. Windows occasionally holds locks on state.json briefly (e.g.
      // virus scanners), so the retries are still worth keeping.
      await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  // 全面审查 1-2:原先这里还有一步"非原子直写 state.json"的兜底——中途被杀即撕裂主文件,
  // 下次启动只能走损坏回退。删除该步:直接写 recovery 旁文件(全新文件,绝不撕裂既有数据),
  // loadState 的损坏回退链会优先采用最新 recovery(见 recoverStateFromBackups)。
  // P2-1:静默丢配置是最高危的一类故障,用户必须知道(通道镜像到 console)。
  try {
    await Bun.write(`${statePath}.recovery-${Date.now()}.json`, content);
    reportError("persistence", "error", "state.json 落盘失败(已另存 recovery 文件,重启后自动恢复)", lastError);
  } catch (recErr) {
    reportError("persistence", "error", "state.json 落盘失败,recovery 文件也写不出——本次变更未持久化", lastError ?? recErr);
  }
}

// ----- 全面审查 1-3:state.json 滚动每日备份(单代)-----
// 会话有活库+WAL+导入前快照,设置层(供应商 apiKey/助手/记忆配置)此前只有一次性迁移
// 时代的化石快照。每天首次成功落盘后顺手写一份 state.json.daily.bak,与 recovery 链
// 组成完整恢复梯队(recovery=最后一笔 → daily.bak=最多回退一天 → pre-sqlite.bak=化石)。

let dailyBackupDoneForDay: string | null = null;

/** 参数化实现,回归测试直连;返回是否真的写了备份。失败只告警——备份是增强,不阻塞主写。 */
export function maybeWriteDailyBackupTo(bakPath: string, content: string, now = new Date()): boolean {
  const today = now.toISOString().slice(0, 10);
  if (dailyBackupDoneForDay === today) return false;
  try {
    try {
      // 跨进程重启同日不重复写:以备份文件 mtime 的日期为准
      if (new Date(statSync(bakPath).mtimeMs).toISOString().slice(0, 10) === today) {
        dailyBackupDoneForDay = today;
        return false;
      }
    } catch { /* 不存在 → 写 */ }
    const tempPath = `${bakPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, content);
    renameSync(tempPath, bakPath);
    dailyBackupDoneForDay = today;
    return true;
  } catch (err) {
    dailyBackupDoneForDay = today; // 当天不再反复尝试/告警
    reportError("persistence", "warn", "state.json 每日滚动备份写入失败(主写不受影响)", err);
    return false;
  }
}

function maybeWriteDailyBackup(content: string): void {
  maybeWriteDailyBackupTo(`${statePath}.daily.bak`, content);
}

/** 全面审查 1-2:state.json 损坏时的回退链(loadState 解析失败后调用)。原先只认
 *  pre-sqlite.bak(1.2.6 迁移时代化石,老用户可能落后数月),而 performStateSave 八连败
 *  写出的 recovery-*.json 从来无人读——磁盘上躺着最新完整状态却回滚到远古设置。
 *  按新鲜度依次尝试:① 最新 recovery-*.json(坏则逐个回退)→ ② 每日滚动备份 →
 *  ③ pre-sqlite.bak → ④ null(调用方回默认)。用过的 recovery 归档改名 .applied-<ts>,
 *  防下次启动误用陈旧 recovery 覆盖更新的状态。 */
export function recoverStateFromBackups(dataDirPath: string, statePathValue: string): Partial<State> | null {
  try {
    const names = readdirSync(dataDirPath)
      .filter((n) => n.startsWith("state.json.recovery-") && n.endsWith(".json"))
      .sort() // Date.now() 毫秒时间戳同位数,字典序即时间序
      .reverse();
    for (const name of names) {
      const candidate = join(dataDirPath, name);
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<State>;
        console.error(`[loadState] 已从 recovery 文件恢复:${name}`);
        try { renameSync(candidate, `${candidate}.applied-${Date.now()}`); } catch { /* 归档尽力而为 */ }
        return parsed;
      } catch { /* 该 recovery 也坏 → 试更早的 */ }
    }
  } catch { /* readdir 失败 → 继续下一级 */ }
  try {
    const daily = `${statePathValue}.daily.bak`;
    const parsed = JSON.parse(readFileSync(daily, "utf8")) as Partial<State>;
    console.error("[loadState] 已从每日滚动备份恢复(最多回退一天)");
    return parsed;
  } catch { /* 不存在/损坏 → 继续 */ }
  try {
    const bak = join(dataDirPath, "state.json.pre-sqlite.bak");
    const parsed = JSON.parse(readFileSync(bak, "utf8")) as Partial<State>;
    console.error("[loadState] 已从 pre-sqlite.bak 恢复(迁移时代快照,可能显著过时)");
    return parsed;
  } catch { /* 不存在/损坏 */ }
  return null;
}

export function saveState(): void {
  // Cancel any pending throttled save — its work is about to be done by this call.
  if (pendingThrottledSave) {
    clearTimeout(pendingThrottledSave);
    pendingThrottledSave = null;
  }
  // If a save is already in flight, mark that another save is needed; it'll run when
  // the current one completes. Coalesces a burst of saves into at most two writes
  // (current + one trailing) instead of N synchronous serializations.
  if (activeSaveStatePromise) {
    coalescedSaveRequested = true;
    return;
  }
  const run = async (): Promise<void> => {
    try {
      await performStateSave();
    } finally {
      if (coalescedSaveRequested) {
        coalescedSaveRequested = false;
        // Snapshot the latest state — performStateSave reads `state` at call time, so
        // re-running it will pick up any changes that landed during the previous write.
        activeSaveStatePromise = run();
      } else {
        activeSaveStatePromise = null;
      }
    }
  };
  activeSaveStatePromise = run();
  // Surface unhandled rejections to the console rather than crashing the process —
  // every saveState call is treated as fire-and-forget by the existing call sites.
  activeSaveStatePromise.catch((err) => console.warn("saveState failed", err));
}

/** Used by graceful shutdown paths to ensure the final write completes on disk. */
export async function flushSaveState(): Promise<void> {
  if (activeSaveStatePromise) {
    try { await activeSaveStatePromise; } catch { /* already logged */ }
  }
}

/** 同步 temp+rename 写瘦 state.json。loadState 启动阶段用（不能异步）。 */
export function writeSlimStateJsonSync(data: Partial<State>): void {
  const slimContent = JSON.stringify({ ...data, logs: undefined, conversations: undefined });
  const tempPath = `${statePath}.migrate.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, slimContent);
  try {
    renameSync(tempPath, statePath);
  } catch (err) {
    try { unlinkSync(tempPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}

/** 同步 temp+rename 写瘦 state.json，记忆迁移后立即落盘用（S2-b）。
 *  排除 logs（始终内存态）、conversations（会话已迁移则不写，未迁移则保留——按标记判断）、
 *  memories/nextMemoryId（调用前已 delete，不出现）。 */
export function writeSlimStateJsonSyncForMemory(data: State): void {
  const convMigrated = Array.isArray(data.appliedMigrations)
    && data.appliedMigrations.includes(CONVERSATIONS_SQLITE_MIGRATION);
  const slimContent = JSON.stringify({
    ...data,
    logs: undefined,
    ...(convMigrated ? { conversations: undefined } : {}),
  });
  const tempPath = `${statePath}.mem-migrate.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, slimContent);
    renameSync(tempPath, statePath);
  } catch (err) {
    try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    reportError("persistence", "warn", "写瘦 state.json 失败(内存已迁移,下次启动重试)", err);
  }
}

/** 顶层启动写盘：供 server.ts 在初始化完成后调用，避免模块加载期 TDZ。 */
export function saveInitialState() {
  saveState();
}
