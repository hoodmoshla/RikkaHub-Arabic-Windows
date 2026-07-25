// 应用错误通道 store(P2-1 批2):订阅 errors/stream,按 severity 路由 toast,
// 并持有错误中心快照(批3 在日志页展示)。
// 契约:连接快照只入 store 不弹 toast(重连不重复打扰);增量 app_error 才路由 toast。
// 风暴抑制在后端做(30s 同 domain+message 合并,窗口内不重复广播),前端无需再去抖。
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { toast } from "sonner";

import api, { sse } from "~/services/api";
import type { AppErrorDto, AppErrorPushEventDto, AppErrorSnapshotEventDto } from "~/types";

interface AppErrorsStoreState {
  errors: AppErrorDto[];
  setErrors: (errors: AppErrorDto[]) => void;
  pushError: (entry: AppErrorDto) => void;
  clearErrors: () => Promise<void>;
  /** 前端自身 catch 到的错误走同一中心(不回传后端,仅本地聚合)。 */
  reportLocalError: (entry: AppErrorDto) => void;
}

export const useAppErrorsStore = create<AppErrorsStoreState>((set) => ({
  errors: [],
  setErrors: (errors) => set({ errors }),
  pushError: (entry) => set((s) => ({ errors: [entry, ...s.errors].slice(0, 200) })),
  clearErrors: async () => {
    set({ errors: [] });
    try {
      await api.post("errors/clear", {});
    } catch {
      // 清空是尽力而为;后端不可达时本地已清,重连快照会再同步
    }
  },
  reportLocalError: (entry) => set((s) => ({ errors: [entry, ...s.errors].slice(0, 200) })),
}));

type AppErrorStreamEvent = AppErrorSnapshotEventDto | AppErrorPushEventDto;

function routeToast(entry: AppErrorDto) {
  const suffix = entry.count > 1 ? ` (×${entry.count})` : "";
  if (entry.severity === "error") toast.error(entry.message + suffix);
  else if (entry.severity === "warn") toast.warning(entry.message + suffix);
  // info 级只进错误中心,不打扰
}

/** 订阅应用错误 SSE(/api/errors/stream)。根组件调用一次;重连由 sse() 内建。 */
export function useAppErrorsSubscription() {
  const setErrors = useAppErrorsStore((s) => s.setErrors);
  const pushError = useAppErrorsStore((s) => s.pushError);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let closed = false;
    abortRef.current = new AbortController();
    void sse<AppErrorStreamEvent>(
      "errors/stream",
      {
        onMessage: ({ data }) => {
          if (closed) return;
          if (data.type === "snapshot") {
            setErrors(data.errors);
            return;
          }
          if (data.type === "app_error") {
            pushError(data.error);
            routeToast(data.error);
          }
        },
        onError: (error) => {
          console.error("App errors SSE error:", error);
        },
      },
      { signal: abortRef.current.signal },
    );

    return () => {
      closed = true;
      abortRef.current?.abort();
    };
  }, [setErrors, pushError]);
}
