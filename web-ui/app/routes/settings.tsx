import * as React from "react";
import { useTranslation } from "react-i18next";
import i18n from "~/i18n";

import { ArrowLeft, Bot, CheckCircle2, CopyPlus, Database, FileClock, Globe, Heart, KeyRound, Loader2, Mic, Search, Settings2, UserRound, Brain } from "lucide-react";
import { Link } from "react-router";
import { MemorySection } from "~/components/memory/memory-section";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { AboutSection, DonateSection } from "~/components/settings/about";
import { AssistantsSection } from "~/components/settings/assistants";
import { McpExtensionsSection } from "~/components/settings/extensions";
import { ProvidersSection } from "~/components/settings/providers";
import { DataSection } from "~/components/settings/data";
import { GeneralSection } from "~/components/settings/general";
import { LogsSection, type RequestLog } from "~/components/settings/logs";
import { AppErrorsSection } from "~/components/settings/app-errors";
import { ProxySection } from "~/components/settings/proxy";
import { DefaultModelsSection } from "~/components/settings/default-models";
import { SearchSection } from "~/components/settings/search";
import { SpeechSection } from "~/components/settings/speech";
import { StatsSection, type StatsPayload } from "~/components/settings/stats";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import { confirmDialog } from "~/stores/confirm-store";
import type { Settings } from "~/types";

type Section =
  | "general"
  | "providers"
  | "models"
  | "assistants"
  | "search"
  | "mcp"
  | "speech"
  | "memory"
  | "data"
  | "stats"
  | "logs"
  | "proxy"
  | "donate"
  | "about"
  | "plan";

const navItems: Array<{
  id: Section;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "general", labelKey: "settings:nav.general", icon: UserRound },
  { id: "assistants", labelKey: "settings:nav.assistants", icon: Bot },
  { id: "providers", labelKey: "settings:nav.providers", icon: KeyRound },
  { id: "models", labelKey: "settings:nav.models", icon: Settings2 },
  { id: "search", labelKey: "settings:nav.search", icon: Search },
  { id: "mcp", labelKey: "settings:nav.mcp", icon: CopyPlus },
  { id: "speech", labelKey: "settings:nav.speech", icon: Mic },
  { id: "memory", labelKey: "settings:nav.memory", icon: Brain },
  { id: "data", labelKey: "settings:nav.data", icon: Database },
  { id: "stats", labelKey: "settings:nav.stats", icon: Database },
  { id: "logs", labelKey: "settings:nav.logs", icon: FileClock },
  { id: "proxy", labelKey: "settings:nav.proxy", icon: Globe },
  { id: "donate", labelKey: "settings:nav.donate", icon: Heart },
  { id: "about", labelKey: "settings:nav.about", icon: CheckCircle2 },
];

export function meta() {
  return [{ title: i18n.t("settings:nav.meta_title") }];
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const streamedSettings = useSettingsStore((state) => state.settings);
  const setStreamedSettings = useSettingsStore((state) => state.setSettings);
  const [settings, setSettings] = React.useState<Settings | null>(streamedSettings);
  const [section, setSection] = React.useState<Section>("general");
  const [logs, setLogs] = React.useState<RequestLog[]>([]);
  const [stats, setStats] = React.useState<StatsPayload | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const querySection = params.get("section");
    if (querySection && navItems.some((item) => item.id === querySection)) {
      setSection(querySection as Section);
    }
  }, []);

  React.useEffect(() => {
    if (streamedSettings) setSettings(streamedSettings);
  }, [streamedSettings]);

  React.useEffect(() => {
    if (settings) return;
    api
      .get<Settings>("settings")
      .then(setSettings)
      .catch((error: Error) => toast.error(error.message));
  }, [settings]);

  React.useEffect(() => {
    if (section !== "logs") return;
    api
      .get<RequestLog[]>("logs")
      .then(setLogs)
      .catch((error: Error) => toast.error(error.message));
  }, [section]);

  const clearLogs = React.useCallback(async () => {
    if (!(await confirmDialog({ title: t("settings:logs.clear_confirm"), danger: true }))) return;
    try {
      await api.delete("logs");
      setLogs([]);
      toast.success(t("settings:logs.cleared"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [t]);

  React.useEffect(() => {
    if (section !== "stats") return;
    api
      .get<StatsPayload>("stats")
      .then(setStats)
      .catch((error: Error) => toast.error(error.message));
  }, [section]);

  if (!settings) {
    return (
      <div className="flex h-svh items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t("settings:providers.loading")}
      </div>
    );
  }

  const updateLocal = (next: Settings) => {
    setSettings(next);
    setStreamedSettings(next);
  };

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      <aside className="flex w-64 flex-col border-r border-divider bg-sidebar text-sidebar-foreground">
        {/* pt-9 让出沉浸式标题栏高度,标题栏透明后内容仍顶到窗口顶但不会被盖住。
            border-divider:用比 --border 更淡的分界色,让区域分隔退到背景里。 */}
        <div className="flex items-center gap-2 border-b border-divider px-4 pb-3 pt-9">
          <Button asChild size="icon-sm" variant="ghost">
            <Link to="/">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div>
            <div className="text-sm font-semibold">RikkaHub PC</div>
            <div className="text-xs text-muted-foreground">{t("settings:nav.subtitle")}</div>
          </div>
        </div>
        <nav className="space-y-1 p-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "relative flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-all duration-200",
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/70",
                  active &&
                    "before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-r-full before:bg-sidebar-primary",
                )}
                onClick={() => setSection(item.id)}
              >
                <Icon
                  className={cn(
                    "size-4 transition-colors",
                    active ? "text-sidebar-primary" : "text-muted-foreground",
                  )}
                />
                {t(item.labelKey)}
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        <ScrollArea className="h-svh">
          <div className="mx-auto w-full max-w-5xl px-6 pb-6 pt-9">
            {/* pt-9 与左侧 aside 顶部对齐,让出沉浸式透明标题栏高度,避免各板块内容贴顶。 */}
            {section === "general" && (
              <GeneralSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "providers" && (
              <ProvidersSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "models" && (
              <DefaultModelsSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "assistants" && (
              <AssistantsSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "search" && <SearchSection settings={settings} onSettings={updateLocal} />}
            {section === "mcp" && (
              <McpExtensionsSection settings={settings} onSettings={updateLocal} />
            )}
            {section === "speech" && <SpeechSection settings={settings} onSettings={updateLocal} />}
            {section === "memory" && <MemorySection settings={settings} onSettings={updateLocal} />}
            {section === "data" && <DataSection settings={settings} onSettings={updateLocal} />}
            {section === "stats" && <StatsSection stats={stats} />}
            {section === "logs" && (
              <>
                <AppErrorsSection />
                <div className="h-6" />
                <LogsSection logs={logs} onClear={clearLogs} />
              </>
            )}
            {section === "proxy" && <ProxySection settings={settings} onSettings={updateLocal} />}
            {section === "donate" && <DonateSection />}
            {section === "about" && <AboutSection />}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}

