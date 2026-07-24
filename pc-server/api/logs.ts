// api/logs.ts — 请求日志与统计计数（addLog、stats 归一化）
// 纪律：只负责 state.logs / state.stats 的累加与归一化。

import type { RequestLog, RequestStats } from "../foundation/types";
import { id, isRecord } from "../foundation/utils";
import { saveState, state } from "../persistence/json-store";

function classifyRequestGroup(kind: string, toolName: string): string {
  if (kind.startsWith("mcp:")) return "MCP 请求";
  if (kind.startsWith("search:") || kind.startsWith("tool:search") || kind.startsWith("tool:scrape") || toolName === "search_web" || toolName === "scrape_web") return "搜索引擎请求";
  return "模型请求";
}

export function defaultRequestStats(): RequestStats {
  return { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} };
}

// 把一条请求日志的计数累加进 stats(既用于实时累加,也用于老用户一次性迁移)。
function bumpStatsCounters(stats: RequestStats, log: { ok: boolean; providerName: string; kind?: string; toolName?: string }): void {
  stats.totalRequests += 1;
  if (!log.ok) stats.failedRequests += 1;
  const prov = stats.byProvider[log.providerName] ?? { ok: 0, failed: 0 };
  if (log.ok) prov.ok += 1; else prov.failed += 1;
  stats.byProvider[log.providerName] = prov;
  const group = classifyRequestGroup(String(log.kind ?? ""), String(log.toolName ?? ""));
  const grp = stats.byGroup[group] ?? { ok: 0, failed: 0 };
  if (log.ok) grp.ok += 1; else grp.failed += 1;
  stats.byGroup[group] = grp;
}

// 老用户的 state.json 没有 stats 字段(统计以前藏在持久化 logs 里)。加载时把旧 logs
// 的统计一次性累加进 stats —— 之后 logs 改内存态会丢弃,但累计统计得以保留,老用户重启
// 后统计页不会归零。新版本已有 stats 字段时直接沿用,不重复迁移(避免双算)。
export function normalizeRequestStats(raw: unknown, legacyLogs: RequestLog[]): RequestStats {
  if (isRecord(raw) && (typeof raw.totalRequests === "number" || isRecord(raw.byProvider) || isRecord(raw.byGroup))) {
    const base = defaultRequestStats();
    base.totalRequests = typeof raw.totalRequests === "number" ? raw.totalRequests : 0;
    base.failedRequests = typeof raw.failedRequests === "number" ? raw.failedRequests : 0;
    if (isRecord(raw.byProvider)) {
      for (const [k, v] of Object.entries(raw.byProvider)) {
        if (isRecord(v) && typeof v.ok === "number" && typeof v.failed === "number") base.byProvider[k] = { ok: v.ok, failed: v.failed };
      }
    }
    if (isRecord(raw.byGroup)) {
      for (const [k, v] of Object.entries(raw.byGroup)) {
        if (isRecord(v) && typeof v.ok === "number" && typeof v.failed === "number") base.byGroup[k] = { ok: v.ok, failed: v.failed };
      }
    }
    return base;
  }
  const migrated = defaultRequestStats();
  for (const log of legacyLogs) bumpStatsCounters(migrated, log);
  return migrated;
}

export function addLog(input: Omit<RequestLog, "id" | "at">) {
  bumpStatsCounters(state.stats, input);
  state.logs.unshift({ id: id(), at: Date.now(), ...input });
  state.logs = state.logs.slice(0, 100);
  saveState();
}
