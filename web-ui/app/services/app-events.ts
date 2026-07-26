// 单一应用事件通道(连接预算纪律,服务端对照 pc-server/api/sse.ts 顶部注释)。
//
// WebView2 对同源 HTTP/1.1 仅 6 并发连接。此前设置/记忆/错误/列表失效各占一条常驻
// SSE,加上会话详情流共 5 条,只给图片/上传/API 留 1 个名额——多图会话一打开就连接
// 池饥饿(1.0.4 前的老问题在重构后复活)。现在四域共用一条 /api/events,全应用常驻
// 连接固定为 2:本通道 + 当前会话流。
//
// 【纪律】新增服务端推送一律在此注册事件名,禁止再开新的常驻 SSE 端点。
//
// 快照重放:服务端连接即推各域完整快照,但订阅方(React effect)可能晚于首帧注册;
// 通道缓存各快照事件的最新一帧,注册时立即补发,消除时序耦合。增量事件(app_error)
// 不重放——重放会造成重复 toast/计数。
import { sse } from "./api";
import type {
  AppErrorPushEventDto,
  AppErrorSnapshotEventDto,
  ConversationListInvalidateEventDto,
  MemorySnapshot,
  Settings,
} from "~/types";

export interface AppEventMap {
  settings: Settings;
  memory: MemorySnapshot;
  app_errors_snapshot: AppErrorSnapshotEventDto;
  app_error: AppErrorPushEventDto;
  invalidate: ConversationListInvalidateEventDto;
}

type AppEventName = keyof AppEventMap;

const REPLAY_EVENTS: ReadonlySet<AppEventName> = new Set([
  "settings",
  "memory",
  "app_errors_snapshot",
  "invalidate",
]);

const listeners = new Map<AppEventName, Set<(data: never) => void>>();
const lastSnapshot = new Map<AppEventName, unknown>();
let started = false;

function dispatch(event: string, data: unknown): void {
  const name = event as AppEventName;
  if (REPLAY_EVENTS.has(name)) lastSnapshot.set(name, data);
  const set = listeners.get(name);
  if (!set) return;
  for (const listener of set) (listener as (d: unknown) => void)(data);
}

/** 建立通道(幂等)。重连由 sse() 内建,连接即重推全部快照 = 状态自动补偿。 */
export function startAppEvents(): void {
  if (started) return;
  started = true;
  void sse<unknown>("events", {
    onMessage: ({ event, data }) => dispatch(event, data),
    onError: (error) => {
      console.error("App events SSE error:", error);
    },
  });
}

/** 注册事件监听并确保通道已建立。返回反注册函数(不断开共享通道)。 */
export function onAppEvent<K extends AppEventName>(
  event: K,
  listener: (data: AppEventMap[K]) => void,
): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(listener as (data: never) => void);
  if (REPLAY_EVENTS.has(event) && lastSnapshot.has(event)) {
    listener(lastSnapshot.get(event) as AppEventMap[K]);
  }
  startAppEvents();
  return () => {
    set.delete(listener as (data: never) => void);
  };
}
