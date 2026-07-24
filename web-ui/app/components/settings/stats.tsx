// components/settings/stats.tsx — 用量统计分区（纯搬迁自 routes/settings.tsx）

import { useTranslation } from "react-i18next";
import { Database, Loader2 } from "lucide-react";
import { SectionHeader } from "~/components/settings/shared";

export interface StatsPayload {
  totals: {
    conversations: number;
    messages: number;
    userMessages: number;
    assistantMessages: number;
    characters: number;
    inputTokens: number;
    outputTokens: number;
    launchCount: number;
    requests: number;
    failedRequests: number;
  };
  daily: Array<{ date: string; messages: number; conversations: number; characters: number }>;
  models: Array<{ id: string; name?: string; providerName?: string; count: number }>;
  requestGroups?: Array<{ name: string; ok: number; failed: number }>;
  providers: Array<{ name: string; ok: number; failed: number }>;
}

export function StatsSection({ stats }: { stats: StatsPayload | null }) {
  const { t } = useTranslation();
  if (!stats) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t("settings:stats.loading")}
      </div>
    );
  }
  const dailyByDate = new Map(stats.daily.map((item) => [item.date, item]));
  const today = new Date();
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() - 52 * 7);
  const activeCounts = stats.daily
    .map((item) => item.messages)
    .filter((count) => count > 0)
    .sort((a, b) => a - b);
  const quantile = (ratio: number, fallback: number) =>
    activeCounts[Math.floor(activeCounts.length * ratio)] ?? fallback;
  const q1 = quantile(0.25, 1);
  const q2 = quantile(0.5, 2);
  const q3 = quantile(0.75, 3);
  const formatKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const heatmapWeeks = Array.from({ length: 53 }, (_, weekIndex) =>
    Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(start);
      date.setDate(start.getDate() + weekIndex * 7 + dayIndex);
      const key = formatKey(date);
      const item = dailyByDate.get(key);
      const isFuture = date > today;
      const count = isFuture ? 0 : (item?.messages ?? 0);
      const level = isFuture
        ? -1
        : count === 0
          ? 0
          : count <= q1
            ? 1
            : count <= q2
              ? 2
              : count <= q3
                ? 3
                : 4;
      return { key, date, count, level };
    }),
  );
  const monthLabels = heatmapWeeks.map((week) => {
    const firstOfMonth = week.find((day) => day.date.getDate() === 1);
    if (!firstOfMonth) return "";
    return firstOfMonth.date.getMonth() === 0
      ? String(firstOfMonth.date.getFullYear())
      : firstOfMonth.date.toLocaleString(undefined, { month: "short" });
  });
  const heatmapClass = (level: number) => {
    if (level < 0) return "bg-muted/40";
    if (level === 0) return "bg-muted";
    return ["bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"][level - 1];
  };
  return (
    <>
      <SectionHeader
        icon={Database}
        title={t("settings:stats.title")}
        subtitle={t("settings:stats.subtitle")}
      />
      <div className="grid gap-4 md:grid-cols-5">
        {[
          [t("settings:stats.t_conversations"), stats.totals.conversations],
          [t("settings:stats.t_messages"), stats.totals.messages],
          [t("settings:stats.t_input_tokens"), stats.totals.inputTokens],
          [t("settings:stats.t_output_tokens"), stats.totals.outputTokens],
          [t("settings:stats.t_launches"), stats.totals.launchCount],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border bg-card p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-lg border bg-card p-4">
        <div className="mb-3 text-sm font-medium">{t("settings:stats.heatmap")}</div>
        <div className="pb-1">
          <div className="grid w-full grid-cols-[24px_minmax(0,1fr)] gap-x-2 overflow-hidden">
            <div />
            <div
              className="grid justify-between gap-[2px]"
              style={{ gridTemplateColumns: "repeat(53, minmax(10px, 14px))" }}
            >
              {monthLabels.map((label, index) => (
                <div
                  key={`${label}-${index}`}
                  className="h-5 overflow-visible whitespace-nowrap text-[0.6875rem] text-muted-foreground"
                >
                  {label}
                </div>
              ))}
            </div>
            <div
              className="grid gap-[2px] pt-[2px]"
              style={{ gridTemplateRows: "repeat(7, 12px)" }}
            >
              {[
                "",
                t("settings:stats.day_mon"),
                "",
                t("settings:stats.day_wed"),
                "",
                t("settings:stats.day_fri"),
                "",
              ].map((label, index) => (
                <div
                  key={`${label}-${index}`}
                  className="flex h-3 items-center justify-end text-[0.6875rem] text-muted-foreground"
                >
                  {label}
                </div>
              ))}
            </div>
            <div
              className="grid justify-between gap-[2px] pt-[2px]"
              style={{ gridTemplateColumns: "repeat(53, minmax(10px, 14px))" }}
            >
              {heatmapWeeks.map((week, weekIndex) => (
                <div
                  key={weekIndex}
                  className="grid gap-[2px]"
                  style={{ gridTemplateRows: "repeat(7, 12px)" }}
                >
                  {week.map((day) => (
                    <div
                      key={day.key}
                      title={t("settings:stats.day_count", { date: day.key, count: day.count })}
                      className={`size-3 rounded-[3px] sm:size-3.5 ${heatmapClass(day.level)}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-1 text-[0.6875rem] text-muted-foreground">
          <span>{t("settings:stats.less")}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className={`size-[12px] rounded-[4px] ${heatmapClass(level)}`} />
          ))}
          <span>{t("settings:stats.more")}</span>
        </div>
        {stats.daily.length === 0 ? (
          <div className="mt-3 text-xs text-muted-foreground">
            {t("settings:stats.heatmap_empty")}
          </div>
        ) : null}
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 text-sm font-medium">{t("settings:stats.model_usage")}</div>
          <div className="space-y-2">
            {stats.models.slice(0, 8).map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">
                  {[item.providerName, item.name || item.id].filter(Boolean).join(" / ")}
                </span>
                <span className="text-muted-foreground">{item.count}</span>
              </div>
            ))}
            {stats.models.length === 0 ? (
              <div className="text-sm text-muted-foreground">{t("settings:stats.no_models")}</div>
            ) : null}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 text-sm font-medium">{t("settings:stats.request_groups")}</div>
          <div className="mb-4 space-y-2">
            {(stats.requestGroups ?? []).map((item) => (
              <div key={item.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{item.name}</span>
                <span className="text-muted-foreground">
                  {t("settings:stats.ok_failed", { ok: item.ok, failed: item.failed })}
                </span>
              </div>
            ))}
            {(stats.requestGroups ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">{t("settings:stats.no_groups")}</div>
            ) : null}
          </div>
          <div className="mb-3 text-sm font-medium">{t("settings:stats.provider_requests")}</div>
          <div className="space-y-2">
            {stats.providers.slice(0, 8).map((item) => (
              <div key={item.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{item.name}</span>
                <span className="text-muted-foreground">
                  {item.ok} / {item.failed}
                </span>
              </div>
            ))}
            {stats.providers.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                {t("settings:stats.no_provider_requests")}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
