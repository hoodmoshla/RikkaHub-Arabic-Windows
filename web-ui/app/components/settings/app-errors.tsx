// components/settings/app-errors.tsx — 应用错误中心分区(P2-1 批3)。
// 数据来自 useAppErrorsStore(/api/events 通道全局订阅);与请求日志同页呈现:
// 请求日志回答"哪个 HTTP 请求失败了",错误中心回答"应用哪里在降级/出错"。
// 2026-07-30 用户拍板:不做独立大标题板块——改为默认折叠的细条卡片,嵌在请求日志
// 标题下方,视觉上是日志页的一条特殊行;有错误时标头显示按最高严重级着色的计数徽标。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ShieldAlert } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import { useAppErrorsStore } from "~/stores";
import type { AppErrorDto } from "~/types";

const SEVERITY_STYLE: Record<AppErrorDto["severity"], string> = {
  error: "bg-destructive/10 text-destructive",
  warn: "bg-amber-500/10 text-amber-600",
  info: "bg-muted text-muted-foreground",
};

export function AppErrorsSection() {
  const { t } = useTranslation();
  const errors = useAppErrorsStore((s) => s.errors);
  const clearErrors = useAppErrorsStore((s) => s.clearErrors);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState<AppErrorDto | null>(null);
  // 徽标颜色取当前记录里的最高严重级,让折叠态一眼可辨轻重
  const worst: AppErrorDto["severity"] = errors.some((e) => e.severity === "error")
    ? "error"
    : errors.some((e) => e.severity === "warn")
      ? "warn"
      : "info";
  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 p-3 text-left"
      >
        <ShieldAlert className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{t("settings:app_errors.title")}</span>
        {errors.length > 0 ? (
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", SEVERITY_STYLE[worst])}>
            {errors.length}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t("settings:app_errors.badge_empty")}</span>
        )}
        <ChevronDown
          className={cn("ml-auto size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="border-t px-3 pb-3">
          <div className="flex items-center justify-between gap-3 py-2.5">
            <p className="text-xs text-muted-foreground">{t("settings:app_errors.subtitle")}</p>
            {errors.length > 0 ? (
              <button
                type="button"
                onClick={() => void clearErrors()}
                className="shrink-0 rounded-md border px-2.5 py-1 text-xs text-destructive transition hover:bg-destructive/10"
              >
                {t("settings:app_errors.clear")}
              </button>
            ) : null}
          </div>
          <div className="space-y-2">
            {errors.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t("settings:app_errors.empty")}
              </div>
            ) : null}
            {errors.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setActive(entry)}
                className="block w-full rounded-lg border bg-background p-3 text-left transition hover:shadow-sm"
              >
            <div className="flex items-center gap-2">
              <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", SEVERITY_STYLE[entry.severity])}>
                {t(`settings:app_errors.severity_${entry.severity}`)}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{entry.domain}</span>
              {entry.count > 1 ? <span className="text-xs text-muted-foreground">×{entry.count}</span> : null}
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
            </div>
            <div className="mt-1 truncate text-sm">{entry.message}</div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <Dialog
        open={active !== null}
        onOpenChange={(open) => {
          if (!open) setActive(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{active?.message ?? ""}</DialogTitle>
          </DialogHeader>
          {active ? (
            <div className="space-y-3 text-xs">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                <span>{t(`settings:app_errors.severity_${active.severity}`)}</span>
                <span className="font-mono">{active.domain}</span>
                <span>{new Date(active.at).toLocaleString()}</span>
                {active.count > 1 ? <span>{t("settings:app_errors.merged_count", { count: active.count })}</span> : null}
              </div>
              {active.detail ? (
                <pre className="max-h-[400px] overflow-auto rounded-lg border bg-muted/30 p-2 whitespace-pre-wrap">{active.detail}</pre>
              ) : (
                <div className="text-muted-foreground">{t("settings:app_errors.no_detail")}</div>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
