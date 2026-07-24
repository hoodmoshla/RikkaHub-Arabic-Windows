import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  CopyPlus,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileImage,
  FileClock,
  Globe,
  Github,
  GripVertical,
  Heart,
  KeyRound,
  Loader2,
  MessageSquareText,
  Mic,
  NotebookText,
  Smartphone,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  Square,
  Sparkles,
  WandSparkles,
  Zap,
  Brain,
  X,
  XCircle,
} from "lucide-react";
import { Link } from "react-router";
import { MemorySection } from "~/components/memory/memory-section";
import { toast } from "sonner";

import { AvatarCropper } from "~/components/avatar-cropper";
import { FontPickerPair } from "~/components/font-picker";
import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { JsonTree, tryParseJson } from "~/components/ui/json-tree";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Slider } from "~/components/ui/slider";
import { Switch } from "~/components/ui/switch";
import { KeybindingSettings } from "~/components/keybinding-settings";
import { AboutSection, DonateSection } from "~/components/settings/about";
import { DataSection } from "~/components/settings/data";
import { GeneralSection } from "~/components/settings/general";
import { LogsSection, type RequestLog } from "~/components/settings/logs";
import { ProxySection } from "~/components/settings/proxy";
import { DefaultModelsSection } from "~/components/settings/default-models";
import { SearchSection } from "~/components/settings/search";
import { SpeechSection } from "~/components/settings/speech";
import { clone, moveItem, numberText, PasswordInput, SectionHeader, SortableRow, textValue } from "~/components/settings/shared";
import { StatsSection, type StatsPayload } from "~/components/settings/stats";
import { Textarea } from "~/components/ui/textarea";
import { UIAvatar } from "~/components/ui/ui-avatar";
import { cn } from "~/lib/utils";
import { openExternal } from "~/lib/external-link";
import { getSystemInfo } from "~/lib/system-info";
import api, { appendWebAuthQuery } from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import type {
  AsrProviderProfile,
  AsrProviderType,
  AssistantAvatar,
  AssistantProfile,
  ProviderModel,
  ProviderProfile,
  SearchServiceOption,
  Settings,
  TtsProviderProfile,
  TtsProviderType,
} from "~/types";
import { ModelEditDialog } from "~/components/model-edit-dialog";
import Markdown from "~/components/markdown/markdown";
import { playAudio, stopAudio, useAudioPlaybackKey } from "~/lib/global-audio";
import { UpdateDialog, type UpdateInfo } from "~/components/update-dialog";

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
type ProviderKind = "openai" | "claude" | "google";

type ProviderTestMode = "non_stream" | "stream" | "tools";

interface ProviderTestCheck {
  mode: ProviderTestMode;
  ok: boolean;
  status: number;
  endpoint: string;
  preview: string;
}

interface ProviderTestInfo {
  endpoint: string;
  responseApiEndpoint: string;
  testModelId: string;
  modelCount: number;
  preview: string;
  checks?: ProviderTestCheck[];
}

interface SkillFileInfo {
  path: string;
  size: number;
  type: "file" | "directory";
}

interface SkillProfile {
  name: string;
  description: string;
  compatibility?: string;
  allowedTools?: string[];
  content?: string;
}

interface AssistantMemoryInfo {
  id: number;
  assistantId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Best-effort model-type inference from model id; falls back to CHAT when nothing matches.
// Used to pre-fill the per-model type selector when the user toggles a model on. Users can
// always override in the model row (parity with Android, which makes this manual).
function inferModelType(modelId: string): "CHAT" | "IMAGE" | "EMBEDDING" {
  const id = String(modelId ?? "").toLowerCase();
  if (!id) return "CHAT";
  if (
    /(text-embedding|^embedding|-embed(ding)?|bge|e5|gte|m3-embedding|nomic-embed|jina-embed)/.test(
      id,
    )
  )
    return "EMBEDDING";
  if (
    /(gpt-image|dall-e|dalle|imagen|stable-diffusion|sd[\d-]|flux|midjourney|kolors|qwen-image|wanx|hunyuan-dit|seedream|cogview|recraft)/.test(
      id,
    )
  )
    return "IMAGE";
  return "CHAT";
}

function applyAutoModelType<M extends { modelId?: string; type?: string }>(model: M): M {
  if (model.type && model.type !== "CHAT") return model;
  const inferred = inferModelType(String(model.modelId ?? ""));
  if (inferred === "CHAT") return model;
  return { ...model, type: inferred };
}

// ── Manual-models cache (in-memory, per provider) ────────────────────────────
// Only manually-added models (manuallyAdded === true) are cached here — fetched models are
// NOT. The point: a manual model has no upstream source to re-fetch from, so once the user
// creates it we must never let it vanish from the list just because they toggled it off (or
// navigated away and back, which clears the in-memory fetchedModels state). Toggling a
// manual model off removes it from draft.models (the enabled list) but it stays here, so the
// row remains visible with a dimmed checkbox. Fetched models keep their original behavior:
// off + a page switch → gone (the user can just re-fetch).
//
// Module scope ⇒ survives component unmount (page/provider switches) but not an app restart.
// On restart we fall back to draft.models; a manual model that was toggled off (and thus not
// in draft.models) is lost — accepted, since this is an in-memory-only convenience.
const manualModelsByProvider = new Map<string, Map<string, ProviderModel>>();

function rememberManualModel(providerId: string, model: ProviderModel): void {
  let bucket = manualModelsByProvider.get(providerId);
  if (!bucket) {
    bucket = new Map();
    manualModelsByProvider.set(providerId, bucket);
  }
  // Keep the identity-stable id on update; refresh everything else from the incoming model
  // so edits (display name, abilities, …) propagate to the cached copy too.
  const existing = bucket.get(model.modelId);
  bucket.set(model.modelId, existing ? { ...existing, ...model, id: existing.id } : model);
}

function forgetManualModel(providerId: string, modelId: string): void {
  manualModelsByProvider.get(providerId)?.delete(modelId);
}

function providerKind(provider: ProviderProfile): string {
  return textValue(provider.type) || "openai";
}

function formatTemplatePreviewDate(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(date);
}

function formatTemplatePreviewTime(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(date);
}

function renderMessageTemplatePreview(
  template: string,
  message: string,
  role: string,
  assistant: AssistantProfile,
  model?: ProviderModel | null,
) {
  const now = new Date();
  const values: Record<string, string> = {
    message,
    role,
    time: formatTemplatePreviewTime(now),
    date: formatTemplatePreviewDate(now),
    cur_time: formatTemplatePreviewTime(now),
    cur_date: formatTemplatePreviewDate(now),
    cur_datetime: new Intl.DateTimeFormat(undefined, {
      dateStyle: "full",
      timeStyle: "medium",
    }).format(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    user: "User",
    nickname: "User",
    char: assistant.name?.trim() || "Assistant",
    model_id: model?.modelId || "gpt-4o",
    model_name: model?.displayName || model?.modelId || "GPT-4o",
    system_version: `${(() => {
      const p = navigator.platform || "web";
      const n = /Win/i.test(p)
        ? "Windows"
        : /Linux/i.test(p)
          ? "Linux"
          : /Mac/i.test(p)
            ? "macOS"
            : "";
      return n ? `${n} PC` : "PC";
    })()} (${navigator.platform || "web"})`,
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => values[key] ?? match);
}

function balanceOptionOf(provider: ProviderProfile): Record<string, unknown> {
  return provider.balanceOption && typeof provider.balanceOption === "object"
    ? (provider.balanceOption as Record<string, unknown>)
    : {};
}

function defaultPathForKind(kind: ProviderKind, responseApi = false): string {
  if (kind === "openai") return responseApi ? "/responses" : "/chat/completions";
  if (kind === "claude") return "/messages";
  return "/models/{model}:generateContent";
}

// 预置供应商的"获取 API Key"官网映射。按 baseUrl 子串匹配(大小写无关)。
// 供应商表单的 API Key 标签旁,命中即显示一个靠右的"获取 API Key"链接,跳转官网。
// 新增预置供应商时只需在这里加一行 { 子串: 官网 URL }。
const PROVIDER_GET_KEY_URLS: Array<{ match: RegExp; url: string }> = [
  { match: /naapi\.cc/i, url: "https://naapi.cc/" },
];
function providerGetKeyUrl(baseUrl: string): string | null {
  for (const entry of PROVIDER_GET_KEY_URLS) {
    if (entry.match.test(baseUrl)) return entry.url;
  }
  return null;
}

function endpointPreview(provider: ProviderProfile): string {
  const kind = providerKind(provider) as ProviderKind;
  const base = textValue(provider.baseUrl).replace(/\/+$/, "");
  if (!base) return defaultPathForKind(kind, provider.useResponseApi === true);
  if (kind === "openai")
    return `${base}${provider.useResponseApi === true ? "/responses" : textValue(provider.chatCompletionsPath) || "/chat/completions"}`;
  if (kind === "claude") return `${base}/messages`;
  return `${base}/models/{model}:generateContent?key=${textValue(provider.apiKey) ? "***" : "<API_KEY>"}`;
}

function modelListEndpointPreview(provider: ProviderProfile): string {
  const kind = providerKind(provider) as ProviderKind;
  const base = textValue(provider.baseUrl).replace(/\/+$/, "");
  if (!base) return kind === "google" ? "/models?pageSize=100&key=<API_KEY>" : "/models";
  if (kind === "google")
    return `${base}/models?pageSize=100&key=${textValue(provider.apiKey) ? "***" : "<API_KEY>"}`;
  return `${base}/models`;
}

function createProvider(): ProviderProfile {
  return {
    id: crypto.randomUUID(),
    type: "openai",
    enabled: true,
    name: "自定义供应商",
    builtIn: false,
    shortDescription: "用户添加的 OpenAI-compatible API",
    description: "",
    apiKey: "",
    baseUrl: "https://api.example.com/v1",
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    // 与安卓 OpenAI provider 默认值一致 (commit e63d017)
    includeHistoryReasoning: true,
    models: [],
    balanceOption: { enabled: false, apiPath: "/credits", resultPath: "data.total_credits" },
  };
}

function normalizeKindPatch(provider: ProviderProfile, kind: ProviderKind): ProviderProfile {
  const nextBaseUrl =
    kind === "claude"
      ? "https://api.anthropic.com/v1"
      : kind === "google"
        ? "https://generativelanguage.googleapis.com/v1beta"
        : textValue(provider.baseUrl) || "https://api.openai.com/v1";
  return {
    ...provider,
    type: kind,
    baseUrl: nextBaseUrl,
    useResponseApi: kind === "openai" ? provider.useResponseApi === true : false,
    chatCompletionsPath: defaultPathForKind(
      kind,
      kind === "openai" && provider.useResponseApi === true,
    ),
  };
}

export function meta() {
  return [{ title: "RikkaHub PC 设置" }];
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
    if (!window.confirm(t("settings:logs.clear_confirm"))) return;
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
            {section === "logs" && <LogsSection logs={logs} onClear={clearLogs} />}
            {section === "proxy" && <ProxySection settings={settings} onSettings={updateLocal} />}
            {section === "donate" && <DonateSection />}
            {section === "about" && <AboutSection />}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}

function ProvidersSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  // URL ?providerId= deep-link is only honored on first mount, so subsequent settings updates
  // (autosave, SSE) don't snap the selection back to the URL value or the default first provider.
  const initialProviderId = React.useMemo(() => {
    if (typeof window === "undefined") return settings.providers[0]?.id ?? "";
    const providerId = new URLSearchParams(window.location.search).get("providerId");
    if (providerId && settings.providers.some((provider) => provider.id === providerId))
      return providerId;
    return settings.providers[0]?.id ?? "";
    // Intentionally empty deps: capture only the initial value. We don't want to re-derive on
    // every settings update because that pulls selectedId back to the default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const urlProviderId = React.useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("providerId");
  }, []);
  const focusedModelId = React.useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("modelId") ?? "";
  }, []);
  const [selectedId, setSelectedId] = React.useState(initialProviderId);
  const selected =
    settings.providers.find((provider) => provider.id === selectedId) ?? settings.providers[0];
  const [draft, setDraft] = React.useState<ProviderProfile | null>(
    selected ? clone(selected) : null,
  );
  const [testing, setTesting] = React.useState(false);
  const [fetchingModels, setFetchingModels] = React.useState(false);
  const [testResult, setTestResult] = React.useState("");
  const [testChecks, setTestChecks] = React.useState<ProviderTestCheck[]>([]);
  const [testInfo, setTestInfo] = React.useState<ProviderTestInfo | null>(null);
  const [checkingBalance, setCheckingBalance] = React.useState(false);
  const [balanceResult, setBalanceResult] = React.useState("");
  const [fetchedModels, setFetchedModels] = React.useState<ProviderModel[]>([]);
  // Free-text filter for the model list. Cleared whenever the user switches provider.
  const [modelFilter, setModelFilter] = React.useState("");
  const [testModelId, setTestModelId] = React.useState("");
  const [imageTestResult, setImageTestResult] = React.useState<{
    url: string;
    durationMs: number;
    modelId: string;
    prompt: string;
  } | null>(null);
  const dirtyRef = React.useRef(false);
  const lastSelectedRef = React.useRef(selectedId);

  // Only honor ?providerId=... deep-link navigation when the URL parameter is actually present
  // AND it differs from current selection. Otherwise (no URL param), do not reassert anything —
  // the user's clicks must win.
  React.useEffect(() => {
    if (!urlProviderId) return;
    if (urlProviderId === selectedId) return;
    if (!settings.providers.some((provider) => provider.id === urlProviderId)) return;
    setSelectedId(urlProviderId);
  }, [urlProviderId, selectedId, settings.providers]);

  // providersRef lets this realignment effect read the freshest providers list without
  // depending on settings.providers — otherwise every autosave → onSettings round-trip
  // re-fires the effect and overwrites mid-flight keystrokes. Same class of bug as
  // McpServerEditor; see there for the full rationale.
  const providersRef = React.useRef(settings.providers);
  providersRef.current = settings.providers;
  React.useEffect(() => {
    const next =
      providersRef.current.find((provider) => provider.id === selectedId) ?? providersRef.current[0];
    const selectedChanged = lastSelectedRef.current !== selectedId;
    lastSelectedRef.current = selectedId;
    setDraft(next ? clone(next) : null);
    dirtyRef.current = false;
    if (selectedChanged) {
      setFetchedModels([]);
      setModelFilter("");
      setTestResult("");
      setTestChecks([]);
      setTestInfo(null);
      setBalanceResult("");
      setImageTestResult(null);
      setTestModelId(next?.models?.find((model) => model.modelId !== "auto")?.modelId ?? "");
    }
  }, [selectedId]);

  if (!draft) return null;
  const balanceOption = balanceOptionOf(draft);
  const kind = providerKind(draft) as ProviderKind;
  const selectedModelIds = new Set((draft.models ?? []).map((model) => model.modelId));
  // Display source: merge fetchedModels with draft.models, deduping by modelId. Fetched
  // entries win on overlap (canonical upstream view); manually-added extras are appended.
  // Persisted per-row customizations are still applied downstream via the `persisted` lookup.
  // Manual models that were toggled off (absent from draft.models) are re-merged from the
  // in-memory manual cache so they stay visible instead of disappearing — see
  // manualModelsByProvider above. Fetched models are NOT cached: toggled off + a page switch
  // still clears them (re-fetch to bring them back), preserving the original behavior.
  const displayModels: ProviderModel[] = (() => {
    const fetched = fetchedModels;
    const drafts = draft.models ?? [];
    const fetchedIds = new Set(fetched.map((m) => m.modelId));
    // Start from fetched (canonical) + drafts not in fetched.
    const base = fetched.length === 0 ? drafts : [...fetched, ...drafts.filter((m) => !fetchedIds.has(m.modelId))];
    // Re-add cached manual models that have dropped out of draft.models (toggled off).
    const baseIds = new Set(base.map((m) => m.modelId));
    const cachedManual = manualModelsByProvider.get(draft.id);
    const danglingManual = cachedManual
      ? Array.from(cachedManual.values()).filter((m) => !baseIds.has(m.modelId))
      : [];
    const merged = danglingManual.length > 0 ? [...base, ...danglingManual] : base;
    // Manual models float to the top — they're user-authored (no upstream source) and tend to
    // be the ones the user cares about most; newly-added ones already sit at the head of
    // draft.models, so this surfaces them immediately instead of burying them under the
    // fetched list. Stable order preserved within each group.
    if (merged.length <= 1) return merged;
    const manual: ProviderModel[] = [];
    const rest: ProviderModel[] = [];
    for (const model of merged) {
      (model.manuallyAdded === true ? manual : rest).push(model);
    }
    return manual.length > 0 ? [...manual, ...rest] : rest;
  })();
  // Free-text filter (name or id). Applied on top of displayModels for the list view.
  const visibleModels = (() => {
    const query = modelFilter.trim().toLowerCase();
    if (!query) return displayModels;
    return displayModels.filter(
      (model) =>
        (model.displayName ?? "").toLowerCase().includes(query) ||
        (model.modelId ?? "").toLowerCase().includes(query),
    );
  })();
  // Whether every currently-visible (filtered) model is already enabled — drives the
  // select-all toggle label + click behavior. Acts on visibleModels, not the full set,
  // so "select filtered" works intuitively when searching.
  const allFilteredEnabled =
    visibleModels.length > 0 && visibleModels.every((model) => selectedModelIds.has(model.modelId));
  const fetchedModelIds = new Set(fetchedModels.map((model) => model.modelId));
  const mergedTestModels = [
    ...fetchedModels,
    ...(draft.models ?? []).filter(
      (model) => model.modelId !== "auto" && !fetchedModelIds.has(model.modelId),
    ),
  ].filter((model) => model.modelId !== "auto");
  const effectiveTestModelId =
    (testModelId && mergedTestModels.some((model) => model.modelId === testModelId)
      ? testModelId
      : mergedTestModels[0]?.modelId) || "";
  // The selected test model's persisted record drives whether we run the image-gen test path
  // (and hide the 3-mode chat panel) vs the chat test path.
  const effectiveTestModelType = (() => {
    const persisted = (draft.models ?? []).find((item) => item.modelId === effectiveTestModelId);
    const merged = mergedTestModels.find((item) => item.modelId === effectiveTestModelId);
    return String(persisted?.type ?? merged?.type ?? "CHAT").toUpperCase();
  })();
  const isImageTestMode = effectiveTestModelType === "IMAGE";

  const patchDraft = (patch: Partial<ProviderProfile>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };
  const save = async () => {
    const nextProvider = draft;
    await api.post("settings/provider", nextProvider);
    onSettings({
      ...settings,
      providers: settings.providers.map((provider) =>
        provider.id === nextProvider.id ? nextProvider : provider,
      ),
    });
    dirtyRef.current = false;
  };
  React.useEffect(() => {
    if (!draft || !dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void api
        .post("settings/provider", draft)
        .then(() => {
          dirtyRef.current = false;
          onSettings({
            ...settings,
            providers: settings.providers.map((provider) =>
              provider.id === draft.id ? draft : provider,
            ),
          });
        })
        .catch((error: Error) => toast.error(error.message || t("settings:providers.autosave_failed")));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, onSettings, settings]);
  const test = async () => {
    setTesting(true);
    setTestChecks([]);
    setTestInfo(null);
    setImageTestResult(null);
    // If user picked an IMAGE-type model, run a dedicated image-generation test instead of
    // the 3-mode chat test. Matches Android, which never tries chat completions for IMAGE models.
    const requestedModelId = effectiveTestModelId;
    const selectedTestModel =
      (draft.models ?? []).find((item) => item.modelId === requestedModelId) ??
      mergedTestModels.find((item) => item.modelId === requestedModelId) ??
      null;
    if (selectedTestModel && (selectedTestModel.type as string) === "IMAGE") {
      setTestResult(t("settings:providers.test_img_starting"));
      try {
        await save();
        const started = Date.now();
        const response = await api.post<{
          status: string;
          image: { url: string; mime: string; fileName: string };
        }>(
          "settings/provider/test/image",
          { providerId: draft.id, modelId: requestedModelId },
          { timeout: false },
        );
        const durationMs = Date.now() - started;
        const url = response.image?.url ?? "";
        setImageTestResult({
          url,
          durationMs,
          modelId: requestedModelId,
          prompt: "A red apple on a white background",
        });
        setTestResult(
          t("settings:providers.test_img_done", {
            model: requestedModelId,
            duration: (durationMs / 1000).toFixed(2),
            file: response.image?.fileName ?? "-",
          }),
        );
        onSettings(await api.get<Settings>("settings"));
        toast.success(t("settings:providers.test_img_ok"));
      } catch (error) {
        const message = error instanceof Error ? error.message : t("settings:providers.test_img_failed");
        setTestResult(message);
        toast.error(message);
      } finally {
        setTesting(false);
      }
      return;
    }
    setTestResult(t("settings:providers.test_starting"));
    try {
      await save();
      const response = await fetch(appendWebAuthQuery("/api/settings/provider/test/stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ providerId: draft.id, modelId: requestedModelId || undefined }),
      });
      if (!response.ok || !response.body) {
        if (response.status !== 404) {
          const text = await response.text();
          throw new Error(text || `HTTP ${response.status}`);
        }
        const fallback = await api.post<ProviderTestInfo>(
          "settings/provider/test",
          { providerId: draft.id, modelId: requestedModelId || undefined },
          { timeout: false },
        );
        const checks = (fallback.checks ?? [])
          .map(
            (item) =>
              `${item.ok ? "✓" : "×"} ${item.mode}: ${item.status || "failed"}\n${item.preview}`,
          )
          .join("\n\n");
        setTestInfo(fallback);
        setTestChecks(fallback.checks ?? []);
        setTestModelId(fallback.testModelId);
        setTestResult(
          t("settings:providers.test_done_fallback", {
            model: fallback.testModelId,
            endpoint: fallback.endpoint,
            chatEndpoint: fallback.responseApiEndpoint,
            count: fallback.modelCount,
            checks,
            preview: fallback.preview,
          }),
        );
        onSettings(await api.get<Settings>("settings"));
        toast.success(t("settings:providers.test_done_ok"));
        return;
      }
      const checks: ProviderTestCheck[] = [];
      let info: ProviderTestInfo | null = null;
      const renderResult = (prefix = "") => {
        setTestInfo(info);
        setTestChecks([...checks]);
        const header = info
          ? t("settings:providers.test_header", {
              model: info.testModelId || effectiveTestModelId,
              endpoint: info.endpoint,
              chatEndpoint: info.responseApiEndpoint,
              count: info.modelCount,
            })
          : t("settings:providers.test_header_pending", {
              model: effectiveTestModelId || t("settings:providers.auto_selecting"),
            });
        const checkText = checks
          .map(
            (item) =>
              `${item.ok ? "✓" : "×"} ${item.mode}: ${item.status || "failed"}\n${item.preview}`,
          )
          .join("\n\n");
        const preview = info?.preview ? t("settings:providers.test_preview", { preview: info.preview }) : "";
        setTestResult([prefix, header, checkText, preview].filter(Boolean).join("\n\n"));
      };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\n\n+/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const event =
            block
              .split(/\r?\n/)
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim() ?? "message";
          const dataText = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!dataText) continue;
          const data = JSON.parse(dataText) as Record<string, unknown>;
          if (event === "progress") {
            renderResult(String(data.message ?? t("settings:providers.testing")));
          } else if (event === "models") {
            info = data as unknown as ProviderTestInfo;
            if (info.testModelId) setTestModelId(info.testModelId);
            renderResult(t("settings:providers.models_read"));
          } else if (event === "check") {
            checks.push(data as unknown as ProviderTestCheck);
            renderResult(t("settings:providers.test_in_progress"));
          } else if (event === "done") {
            info = data as unknown as ProviderTestInfo;
            if (Array.isArray(info.checks)) checks.splice(0, checks.length, ...info.checks);
            if (info.testModelId) setTestModelId(info.testModelId);
            renderResult(t("settings:providers.test_complete"));
          } else if (event === "error") {
            throw new Error(String(data.error ?? t("settings:providers.test_error")));
          }
        }
      }
      onSettings(await api.get<Settings>("settings"));
      toast.success(t("settings:providers.test_success"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settings:providers.test_failed");
      setTestInfo(null);
      setTestChecks([]);
      setTestResult(message);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };
  const fetchModels = async () => {
    if (!textValue(draft.apiKey).trim()) {
      toast.error(t("settings:providers.key_required_fetch"));
      return;
    }
    setFetchingModels(true);
    try {
      await api.post("settings/provider", draft);
      const result = await api.post<{ endpoint: string; models: ProviderModel[] }>(
        "settings/provider/models",
        { providerId: draft.id },
      );
      setFetchedModels(result.models);
      setTestModelId(result.models.find((model) => model.modelId !== "auto")?.modelId ?? "");
      toast.success(t("settings:providers.fetched_models", { count: result.models.length }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:providers.fetch_failed"));
    } finally {
      setFetchingModels(false);
    }
  };
  const handleToggleEnabled = async (enabled: boolean) => {
    // 关闭：直接关
    if (!enabled) {
      patchDraft({ enabled: false });
      return;
    }
    // 已有已启用模型（历史 / 用户此前已勾选）：直接启用，不自动拉取
    if ((draft.models ?? []).length > 0) {
      patchDraft({ enabled: true });
      return;
    }
    // 空列表：先持久化当前配置（让服务端拿到最新 baseUrl / apiKey），再拉取上游模型
    if (!textValue(draft.apiKey).trim()) {
      toast.error(t("settings:providers.key_required_enable"));
      return;
    }
    setFetchingModels(true);
    try {
      await api.post("settings/provider", draft);
      const result = await api.post<{ endpoint: string; models: ProviderModel[] }>(
        "settings/provider/models",
        { providerId: draft.id },
      );
      if (!result.models.length) {
        toast.error(t("settings:providers.no_models_enable"));
        return;
      }
      // 与单个勾选时一致地分类 CHAT / IMAGE / EMBEDDING
      const models = result.models.map(applyAutoModelType);
      setFetchedModels(result.models);
      patchDraft({ enabled: true, models });
      toast.success(t("settings:providers.enabled_models", { count: models.length }));
    } catch (error) {
      // 不 patch enabled —— 保持关闭
      toast.error(error instanceof Error ? error.message : t("settings:providers.enable_fetch_failed"));
    } finally {
      setFetchingModels(false);
    }
  };
  const checkBalance = async () => {
    setCheckingBalance(true);
    setBalanceResult(t("settings:providers.balance_querying"));
    try {
      await save();
      const result = await api.post<{ value: string; endpoint: string; preview: string }>(
        "settings/provider/balance",
        { providerId: draft.id },
        { timeout: false },
      );
      setBalanceResult(t("settings:providers.balance_done", { value: result.value, endpoint: result.endpoint, preview: result.preview }));
      toast.success(t("settings:providers.balance_ok", { value: result.value }));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settings:providers.balance_failed");
      setBalanceResult(message);
      toast.error(message);
    } finally {
      setCheckingBalance(false);
    }
  };
  const toggleModel = (model: ProviderModel, checked: boolean) => {
    const models = checked
      ? // Auto-fill type for newly enabled models (CHAT/IMAGE/EMBEDDING) — user can override per-row.
        [...(draft.models ?? []), applyAutoModelType(model)].filter(
          (item, index, arr) => arr.findIndex((x) => x.modelId === item.modelId) === index,
        )
      : (draft.models ?? []).filter((item) => item.modelId !== model.modelId);
    patchDraft({ models });
  };
  const toggleModelAbility = (modelId: string, ability: "TOOL" | "REASONING", enabled: boolean) => {
    const models = (draft.models ?? []).map((item) => {
      if (item.modelId !== modelId) return item;
      const current = Array.isArray(item.abilities) ? item.abilities : [];
      const next = enabled
        ? Array.from(new Set([...current, ability]))
        : current.filter((value) => value !== ability);
      return { ...item, abilities: next };
    });
    patchDraft({ models });
  };
  // Batch enable/disable for the "select all" toolbar. Acts on a given set of models
  // (the currently-visible filtered set): enable adds any missing ones (auto-typed),
  // disable removes them. Mirrors toggleModel's dedupe + applyAutoModelType semantics.
  const setModelsEnabled = (modelsToToggle: ProviderModel[], enabled: boolean) => {
    const ids = new Set(modelsToToggle.map((model) => model.modelId));
    if (enabled) {
      const existingIds = new Set((draft.models ?? []).map((model) => model.modelId));
      const additions = modelsToToggle
        .filter((model) => !existingIds.has(model.modelId))
        .map(applyAutoModelType);
      if (additions.length === 0) return;
      patchDraft({ models: [...(draft.models ?? []), ...additions] });
    } else {
      const remaining = (draft.models ?? []).filter((model) => !ids.has(model.modelId));
      if (remaining.length === (draft.models ?? []).length) return;
      patchDraft({ models: remaining });
    }
  };
  // -------- Model add/edit dialog state ----------------------------------------------------
  // Single dialog instance reused for both add (+ button) and edit (row click). The mode +
  // modelIdLocked flags determine the dialog UX. State is reset every time the dialog opens
  // (see ModelEditDialog's useEffect on `open`), so reusing one instance is safe.
  type ModelDialogState = {
    mode: "add" | "edit";
    model: ProviderModel;
    modelIdLocked: boolean;
  };
  const [modelDialog, setModelDialog] = React.useState<ModelDialogState | null>(null);

  const openAddModelDialog = () => {
    if (!draft) return;
    const uuid =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setModelDialog({
      mode: "add",
      modelIdLocked: false,
      model: {
        id: uuid,
        modelId: "",
        displayName: "",
        type: "CHAT",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        abilities: [],
        tools: [],
        customHeaders: [],
        customBodies: [],
        manuallyAdded: true,
      },
    });
  };

  const openEditModelDialog = (model: ProviderModel) => {
    if (!draft) return;
    // Prefer the persisted entry (with the user's prior customizations) over the fetched one.
    // If model isn't enabled yet, fall back to the fetched row — saving will auto-enable.
    const persisted = (draft.models ?? []).find((item) => item.modelId === model.modelId);
    const source = persisted ?? model;
    // Manually-added models keep ID editable; everything else (fetched, legacy) is locked
    // because the modelId is sent verbatim to the upstream API and editing it would silently
    // break request routing. See server.ts:6158, 6168, 6313.
    const isManual = source.manuallyAdded === true;
    setModelDialog({
      mode: "edit",
      modelIdLocked: !isManual,
      model: { ...source },
    });
  };

  const handleModelDialogSave = (model: ProviderModel) => {
    if (!draft || !modelDialog) return;
    const existing = (draft.models ?? []).find((item) => item.id === model.id);
    let models: ProviderModel[];
    if (existing) {
      // Edit existing persisted model — replace by UUID id (stable across re-fetches).
      models = (draft.models ?? []).map((item) => (item.id === model.id ? model : item));
    } else if (modelDialog.mode === "add") {
      // Brand-new manual add — also reject duplicate modelId to avoid confusing dedup behavior
      // downstream (toggleModel matches by modelId, not id, so a clash would orphan the new one).
      const clash = (draft.models ?? []).some((item) => item.modelId === model.modelId);
      if (clash) {
        toast.error(t("settings:providers.model_id_exists", { id: model.modelId }));
        return;
      }
      models = [model, ...(draft.models ?? [])];
    } else {
      // Edit dialog opened on a fetched-but-not-yet-enabled row → save auto-enables.
      // Dedup by modelId in case the user toggled the checkbox in parallel.
      const without = (draft.models ?? []).filter((item) => item.modelId !== model.modelId);
      models = [...without, model];
    }
    patchDraft({ models });
    // Cache manual models so toggling them off later doesn't erase them from the list
    // (they have no upstream source to re-fetch from). Also refreshes the cached copy on edit
    // so display-name/ability changes propagate. Fetched models are intentionally not cached.
    if (model.manuallyAdded === true) rememberManualModel(draft.id, model);
    toast.success(modelDialog.mode === "add" ? t("settings:providers.model_added") : t("settings:providers.model_saved"));
  };

  const handleModelDialogDelete = () => {
    if (!draft || !modelDialog) return;
    const target = modelDialog.model;
    // Remove by both id AND modelId to be safe — if the model came from a fetched row whose
    // id wasn't yet in draft.models, the id match alone wouldn't find anything.
    patchDraft({
      models: (draft.models ?? []).filter(
        (item) => item.id !== target.id && item.modelId !== target.modelId,
      ),
    });
    // Drop from the manual cache too, otherwise the deleted row would linger in the list.
    if (target.manuallyAdded === true) forgetManualModel(draft.id, target.modelId);
    toast.success(t("settings:providers.model_deleted"));
  };
  const addProvider = async () => {
    const next = createProvider();
    next.name = t("settings:providers.custom_name");
    next.shortDescription = t("settings:providers.custom_desc");
    await api.post("settings/provider", next);
    onSettings({ ...settings, providers: [...settings.providers, next] });
    setSelectedId(next.id);
    toast.success(t("settings:providers.added"));
  };
  const moveProvider = async (from: number, to: number) => {
    const nextProviders = moveItem(settings.providers, from, to);
    onSettings({ ...settings, providers: nextProviders });
    await api.post("settings/provider/reorder", {
      ids: nextProviders.map((provider) => provider.id),
    });
  };
  const testModeLabels: Record<ProviderTestMode, string> = {
    non_stream: t("settings:providers.mode_non_stream"),
    stream: t("settings:providers.mode_stream"),
    tools: t("settings:providers.mode_tools"),
  };

  return (
    <>
      <SectionHeader
        icon={KeyRound}
        title={t("settings:providers.title")}
        subtitle={t("settings:providers.subtitle")}
      />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="rounded-lg border bg-card p-2">
          <Button className="mb-2 w-full justify-start" variant="outline" onClick={addProvider}>
            <Plus className="size-4" />
            {t("settings:providers.add")}
          </Button>
          {settings.providers.map((provider, index) => (
            <SortableRow
              key={provider.id}
              id={provider.id}
              index={index}
              active={provider.id === draft.id}
              onSelect={() => setSelectedId(provider.id)}
              onMove={moveProvider}
            >
              <span className="grid min-w-0 grid-cols-[28px_10px_minmax(0,1fr)_16px] items-center gap-2 text-left">
                <AIIcon name={provider.name} size={24} className="justify-self-start" />
                <span
                  className={`size-2 rounded-full ${provider.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                />
                <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                {provider.builtIn ? <Check className="size-3 text-primary" /> : null}
              </span>
            </SortableRow>
          ))}
        </div>
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-medium">{draft.name}</div>
              <div className="text-xs text-muted-foreground">
                {textValue(draft.shortDescription) || providerKind(draft)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t("settings:providers.enabled_label")}</span>
              <Switch
                checked={draft.enabled}
                disabled={fetchingModels}
                onCheckedChange={(enabled) => void handleToggleEnabled(enabled)}
              />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:providers.name")}</span>
              <Input
                value={draft.name}
                onChange={(event) => patchDraft({ name: event.target.value })}
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-medium">{t("settings:providers.type")}</span>
              <Select
                value={kind}
                onValueChange={(value) =>
                  setDraft(normalizeKindPatch(draft, value as ProviderKind))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI-compatible</SelectItem>
                  <SelectItem value="claude">Anthropic Claude</SelectItem>
                  <SelectItem value="google">Google Gemini</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-2 md:col-span-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">API Key</span>
                {providerGetKeyUrl(textValue(draft.baseUrl)) ? (
                  <button
                    type="button"
                    onClick={() => void openExternal(providerGetKeyUrl(textValue(draft.baseUrl))!)}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    title={t("settings:providers.get_key_title")}
                  >
                    <ExternalLink className="size-3" />
                    {t("settings:providers.get_key")}
                  </button>
                ) : null}
              </div>
              <PasswordInput
                value={textValue(draft.apiKey)}
                onChange={(apiKey) => patchDraft({ apiKey })}
              />
            </label>
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-medium">Base URL</span>
              <Input
                value={textValue(draft.baseUrl)}
                onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                placeholder={
                  kind === "claude" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"
                }
              />
              <span className="block break-all text-xs text-muted-foreground">
                {t("settings:providers.chat_url", { url: endpointPreview(draft) })}
              </span>
              <span className="block break-all text-xs text-muted-foreground">
                {t("settings:providers.models_url", { url: modelListEndpointPreview(draft) })}
              </span>
            </label>
            <div className="space-y-2 rounded-md border px-3 py-2">
              <span className="text-sm font-medium">Chat Completions Path</span>
              <Input
                disabled={kind !== "openai" || draft.useResponseApi === true}
                value={
                  textValue(draft.chatCompletionsPath) ||
                  defaultPathForKind(kind, draft.useResponseApi === true)
                }
                onChange={(event) => patchDraft({ chatCompletionsPath: event.target.value })}
              />
            </div>
            <div className="flex items-end justify-between gap-3 rounded-md border px-3 py-2">
              <div>
                <div className="text-sm font-medium">Response API</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.response_api_desc")}
                </div>
              </div>
              <Switch
                disabled={kind !== "openai"}
                checked={draft.useResponseApi === true}
                onCheckedChange={(useResponseApi) =>
                  patchDraft({
                    useResponseApi,
                    chatCompletionsPath: defaultPathForKind("openai", useResponseApi),
                  })
                }
              />
            </div>
            {kind === "openai" ? (
              <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-3 md:col-span-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-sm font-medium">{t("settings:providers.history_reasoning_title")}</div>
                  <div className="text-xs leading-relaxed text-muted-foreground">
                    {t("settings:providers.history_reasoning_desc")}
                  </div>
                </div>
                <Switch
                  className="mt-1 shrink-0"
                  checked={draft.includeHistoryReasoning !== false}
                  onCheckedChange={(includeHistoryReasoning) =>
                    patchDraft({ includeHistoryReasoning })
                  }
                />
              </div>
            ) : null}
            {kind === "claude" ? (
              <div className="grid gap-3 rounded-md border px-3 py-3 md:col-span-2 md:grid-cols-[1fr_180px]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{t("settings:providers.prompt_cache_title")}</div>
                    <div className="text-xs text-muted-foreground">
                      {t("settings:providers.prompt_cache_desc")}
                    </div>
                  </div>
                  <Switch
                    checked={draft.promptCaching === true}
                    onCheckedChange={(promptCaching) => patchDraft({ promptCaching })}
                  />
                </div>
                <label className="space-y-2">
                  <span className="text-sm font-medium">{t("settings:providers.cache_ttl")}</span>
                  <Select
                    value={textValue(draft.promptCacheTtl) || "5m"}
                    onValueChange={(promptCacheTtl) =>
                      patchDraft({ promptCacheTtl: promptCacheTtl as "5m" | "1h" })
                    }
                    disabled={draft.promptCaching !== true}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5m">{t("settings:providers.cache_5m")}</SelectItem>
                      <SelectItem value="1h">{t("settings:providers.cache_1h")}</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>
            ) : null}
          </div>
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{t("settings:providers.models_title")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.models_desc", { count: draft.models?.length ?? 0 })}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={openAddModelDialog}
                  title={t("settings:providers.add_model_title")}
                >
                  <Plus className="size-4" />
                  {t("settings:providers.add_model")}
                </Button>
                <Button variant="outline" onClick={fetchModels} disabled={fetchingModels}>
                  {fetchingModels ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {t("settings:providers.fetch_models")}
                </Button>
              </div>
            </div>
            {/* Search + select-all toolbar. Only relevant when there's something to show;
                hidden while the list is empty (no fetch yet, no manual models). */}
            {(fetchedModels.length > 0 || (draft.models ?? []).length > 0) && (
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={modelFilter}
                    onChange={(event) => setModelFilter(event.target.value)}
                    placeholder={t("settings:providers.models_search_placeholder")}
                    className="h-8 pl-9 pr-8"
                  />
                  {modelFilter ? (
                    <button
                      type="button"
                      onClick={() => setModelFilter("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-4" />
                    </button>
                  ) : null}
                </div>
                {/* Visible/total counts — surfaces how many survive the current filter. */}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("settings:providers.models_selection_count", {
                    enabled: draft.models?.length ?? 0,
                    total: displayModels.length,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setModelsEnabled(visibleModels, !allFilteredEnabled)}
                  disabled={visibleModels.length === 0}
                  title={
                    allFilteredEnabled
                      ? modelFilter
                        ? t("settings:providers.models_deselect_all_filtered")
                        : t("settings:providers.models_deselect_all")
                      : modelFilter
                        ? t("settings:providers.models_select_all_filtered")
                        : t("settings:providers.models_select_all")
                  }
                >
                  {allFilteredEnabled
                    ? modelFilter
                      ? t("settings:providers.models_deselect_all_filtered")
                      : t("settings:providers.models_deselect_all")
                    : modelFilter
                      ? t("settings:providers.models_select_all_filtered")
                      : t("settings:providers.models_select_all")}
                </Button>
              </div>
            )}
            <div className="max-h-72 space-y-2 overflow-auto">
              {visibleModels.map((model) => {
                const focused =
                  focusedModelId &&
                  (model.modelId === focusedModelId || model.id === focusedModelId);
                const enabled = selectedModelIds.has(model.modelId);
                const persisted = (draft.models ?? []).find(
                  (item) => item.modelId === model.modelId,
                );
                const currentType =
                  (persisted?.type as "CHAT" | "IMAGE" | "EMBEDDING" | undefined) ?? "CHAT";
                const currentAbilities = Array.isArray(persisted?.abilities)
                  ? persisted!.abilities
                  : [];
                const hasTool = currentAbilities.includes("TOOL");
                const hasReasoning = currentAbilities.includes("REASONING");
                return (
                  <div
                    key={model.id ?? model.modelId}
                    // The row itself is the click target for the edit dialog. The checkbox and
                    // ability buttons inside stop propagation so they keep their own semantics.
                    role="button"
                    tabIndex={0}
                    onClick={() => openEditModelDialog(model)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openEditModelDialog(model);
                      }
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition hover:border-primary/40 hover:bg-muted/40",
                      focused && "border-primary bg-primary/5 shadow-sm",
                    )}
                  >
                    <span onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={enabled}
                        onCheckedChange={(checked) => toggleModel(model, checked === true)}
                      />
                    </span>
                    <AIIcon name={model.modelId} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {model.displayName || model.modelId}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {model.modelId}
                      </span>
                    </span>
                    {enabled && currentType === "CHAT" ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            toggleModelAbility(model.modelId, "TOOL", !hasTool);
                          }}
                          className={cn(
                            "h-7 rounded-md border px-2 text-xs transition",
                            hasTool
                              ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                              : "border-border text-muted-foreground hover:bg-muted",
                          )}
                          title={hasTool ? t("settings:providers.tool_enabled") : t("settings:providers.tool_disabled")}
                        >
                          {t("settings:providers.tool_short")}
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            toggleModelAbility(model.modelId, "REASONING", !hasReasoning);
                          }}
                          className={cn(
                            "h-7 rounded-md border px-2 text-xs transition",
                            hasReasoning
                              ? "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                              : "border-border text-muted-foreground hover:bg-muted",
                          )}
                          title={hasReasoning ? t("settings:providers.reasoning_enabled") : t("settings:providers.reasoning_disabled")}
                        >
                          {t("settings:providers.reasoning_short")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {displayModels.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t("settings:providers.no_models")}
                </div>
              ) : visibleModels.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t("settings:providers.models_no_match")}
                </div>
              ) : null}
            </div>
          </div>
          <div className="space-y-2 rounded-md border px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:providers.test_model")}</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={test} disabled={testing}>
                  {testing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Database className="size-4" />
                  )}
                  {t("settings:providers.test")}
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (!window.confirm(t("settings:providers.delete_confirm", { name: draft.name }))) return;
                    await api.delete(`settings/provider/${encodeURIComponent(draft.id)}`);
                    const providers = settings.providers.filter((item) => item.id !== draft.id);
                    onSettings({ ...settings, providers });
                    setSelectedId(providers[0]?.id ?? "");
                    toast.success(t("settings:providers.deleted"));
                  }}
                  disabled={settings.providers.length <= 1}
                >
                  <Trash2 className="size-4" />
                  {t("settings:providers.delete")}
                </Button>
                <span className="px-2 text-xs text-muted-foreground">{t("settings:providers.autosaved")}</span>
              </div>
            </div>
            <Select value={effectiveTestModelId} onValueChange={setTestModelId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("settings:providers.test_model_ph")} />
              </SelectTrigger>
              <SelectContent>
                {mergedTestModels.map((model) => (
                  <SelectItem key={model.id ?? model.modelId} value={model.modelId}>
                    {model.displayName || model.modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{t("settings:providers.balance_title")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.balance_desc")}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={balanceOption.enabled === true}
                  onCheckedChange={(enabled) =>
                    patchDraft({ balanceOption: { ...balanceOptionOf(draft), enabled } })
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void checkBalance()}
                  disabled={checkingBalance || balanceOption.enabled !== true}
                >
                  {checkingBalance ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Database className="size-4" />
                  )}
                  {t("settings:providers.query")}
                </Button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm font-medium">{t("settings:providers.balance_api_path")}</span>
                <Input
                  value={textValue(balanceOption.apiPath) || "/credits"}
                  onChange={(event) =>
                    patchDraft({
                      balanceOption: { ...balanceOptionOf(draft), apiPath: event.target.value },
                    })
                  }
                />
              </label>
              <label className="space-y-2">
                <span className="text-sm font-medium">{t("settings:providers.balance_result_path")}</span>
                <Input
                  value={textValue(balanceOption.resultPath)}
                  onChange={(event) =>
                    patchDraft({
                      balanceOption: { ...balanceOptionOf(draft), resultPath: event.target.value },
                    })
                  }
                />
              </label>
            </div>
          </div>
          {(testing || testChecks.length > 0 || testInfo) &&
          !isImageTestMode &&
          !imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{t("settings:providers.test_summary")}</div>
                <div className="text-xs text-muted-foreground">
                  {testInfo?.testModelId
                    ? t("settings:providers.test_summary_model", { model: testInfo.testModelId })
                    : testing
                      ? t("settings:providers.testing")
                      : t("settings:providers.awaiting")}
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                {(["non_stream", "stream", "tools"] as ProviderTestMode[]).map((mode) => {
                  const check = testChecks.find((item) => item.mode === mode);
                  const pending = testing && !check;
                  return (
                    <div
                      key={mode}
                      className={cn(
                        "rounded-md border bg-background px-3 py-2",
                        check?.ok === true && "border-emerald-500/30 bg-emerald-500/5",
                        check?.ok === false && "border-destructive/30 bg-destructive/5",
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {pending ? (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : check?.ok ? (
                          <CheckCircle2 className="size-4 text-emerald-500" />
                        ) : check ? (
                          <Trash2 className="size-4 text-destructive" />
                        ) : (
                          <span className="size-2 rounded-full bg-muted-foreground/40" />
                        )}
                        <span>{testModeLabels[mode]}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {check
                          ? check.ok
                            ? t("settings:providers.check_ok", { status: check.status })
                            : t("settings:providers.check_failed", { status: check.status || t("settings:providers.not_connected") })
                          : pending
                            ? t("settings:providers.in_progress")
                            : t("settings:providers.not_tested")}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {isImageTestMode && testing && !imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin align-middle" />
              {t("settings:providers.img_test_generating_pre")}<span className="font-medium text-foreground">
                {effectiveTestModelId}
              </span>{" "}
              {t("settings:providers.img_test_generating_post")}
            </div>
          ) : null}
          {imageTestResult ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">{t("settings:providers.img_test_result")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("settings:providers.img_test_model", { model: imageTestResult.modelId, duration: (imageTestResult.durationMs / 1000).toFixed(2) })}
                </div>
              </div>
              <div className="flex flex-wrap items-start gap-3">
                {imageTestResult.url ? (
                  <img
                    src={appendWebAuthQuery(imageTestResult.url)}
                    alt={t("settings:providers.img_alt")}
                    className="h-40 w-40 rounded-md border object-cover"
                  />
                ) : null}
                <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                  <div className="mb-1 font-medium text-foreground">{t("settings:providers.prompt_label")}</div>
                  <div className="whitespace-pre-wrap">{imageTestResult.prompt}</div>
                </div>
              </div>
            </div>
          ) : null}
          {testResult ? (
            <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
              {testResult}
            </pre>
          ) : null}
          {balanceResult ? (
            <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
              {balanceResult}
            </pre>
          ) : null}
        </div>
      </div>
      {modelDialog ? (
        <ModelEditDialog
          open={Boolean(modelDialog)}
          onOpenChange={(open) => {
            if (!open) setModelDialog(null);
          }}
          mode={modelDialog.mode}
          modelIdLocked={modelDialog.modelIdLocked}
          initialModel={modelDialog.model}
          onSave={handleModelDialogSave}
          onDelete={modelDialog.mode === "edit" ? handleModelDialogDelete : undefined}
        />
      ) : null}
    </>
  );
}

function AssistantsSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const [assistantId, setAssistantId] = React.useState(settings.assistantId);
  const assistant = (settings.assistants.find((item) => item.id === assistantId) ??
    settings.assistants[0]) as AssistantProfile | undefined;
  const [draft, setDraft] = React.useState<AssistantProfile | null>(
    assistant ? clone(assistant) : null,
  );
  const dirtyRef = React.useRef(false);

  React.useEffect(() => {
    const next =
      settings.assistants.find((item) => item.id === assistantId) ?? settings.assistants[0];
    dirtyRef.current = false;
    setDraft(next ? clone(next) : null);
  }, [assistantId, settings.assistants]);

  const save = async () => {
    if (!draft) return;
    const nextAssistants = settings.assistants.map((item) => (item.id === draft.id ? draft : item));
    const nextSettings = { ...settings, assistants: nextAssistants };
    await api.post("settings/assistant/detail", draft);
    onSettings(nextSettings);
    dirtyRef.current = false;
  };

  React.useEffect(() => {
    if (!draft || !dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save().catch((error: Error) =>
        toast.error(error.message || t("settings:assistants.autosave_failed")),
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, settings.assistants]);

  if (!draft) return null;

  const patchDraft = (patch: Partial<AssistantProfile>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };

  const addAssistant = async () => {
    const created = {
      ...clone(settings.assistants[0]),
      id: crypto.randomUUID(),
      name: t("settings:assistants.new_assistant_name"),
      avatar: { type: "dummy" },
      useAssistantAvatar: true,
      systemPrompt: "",
      chatModelId: null,
      allowConversationSystemPrompt: false,
    };
    await api.post("settings/assistant/detail", created);
    onSettings({
      ...settings,
      assistantId: created.id,
      assistants: [...settings.assistants, created],
    });
    setAssistantId(created.id);
    toast.success(t("settings:assistants.added"));
  };
  const moveAssistant = async (from: number, to: number) => {
    const assistants = moveItem(settings.assistants, from, to);
    onSettings({ ...settings, assistants });
    await api.post("settings/assistants/reorder", { ids: assistants.map((item) => item.id) });
  };
  const removeAssistant = async () => {
    const nameLabel = draft.name || t("settings:assistants.default_name");
    // M4:先查该助手记忆数,有记忆则让用户选"同时删除 / 保留为孤儿"(默认保留,防误删助手连带丢记忆)
    let memoryCount = 0;
    try {
      const result = await api.get<{ memories: unknown[] }>(`memory/assistant/${encodeURIComponent(draft.id)}`);
      memoryCount = result.memories?.length ?? 0;
    } catch { /* 记忆查询失败按 0 处理 */ }
    let deleteMemories = false;
    if (memoryCount > 0) {
      if (!window.confirm(t("settings:assistants.delete_confirm_with_memories", { name: nameLabel, n: memoryCount }))) return;
      // 第二步:确定=同时删记忆,取消=保留为孤儿(记忆板块可管理)
      deleteMemories = window.confirm(t("settings:assistants.delete_memories_confirm", { n: memoryCount }));
    } else {
      if (!window.confirm(t("settings:assistants.delete_confirm", { name: nameLabel }))) return;
    }
    await api.delete(`settings/assistant/${encodeURIComponent(draft.id)}${deleteMemories ? "?deleteMemories=true" : ""}`);
    const assistants = settings.assistants.filter((item) => item.id !== draft.id);
    onSettings({
      ...settings,
      assistants,
      assistantId:
        settings.assistantId === draft.id ? (assistants[0]?.id ?? "") : settings.assistantId,
    });
    setAssistantId(assistants[0]?.id ?? "");
    toast.success(t("settings:assistants.deleted"));
  };
  const parameterControl = (
    key: "temperature" | "topP",
    label: string,
    max: number,
    step: number,
  ) => {
    const value = typeof draft[key] === "number" ? draft[key] : key === "temperature" ? 1 : 1;
    const commit = (raw: string) => {
      if (raw.trim() === "") return;
      const next = Number(raw);
      if (!Number.isFinite(next)) return;
      patchDraft({ [key]: Math.min(max, Math.max(0, next)) } as Partial<AssistantProfile>);
    };
    return (
      <label className="space-y-2">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-3">
          <Slider
            min={0}
            max={max}
            step={step}
            value={[value]}
            onValueChange={([next]) =>
              patchDraft({ [key]: next ?? null } as Partial<AssistantProfile>)
            }
          />
          <Input
            key={`${key}-${value}`}
            className="w-24"
            defaultValue={numberText(value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit(event.currentTarget.value);
            }}
          />
        </div>
      </label>
    );
  };
  const messageTemplateValue =
    typeof draft.messageTemplate === "string" ? draft.messageTemplate : "{{ message }}";
  const messageTemplateMissingMessage = !messageTemplateValue.includes("{{ message }}");
  const previewModel = React.useMemo(() => {
    const wanted = draft.chatModelId ?? settings.chatModelId;
    return (
      settings.providers
        .flatMap((provider) => provider.models)
        .find((modelItem) => modelItem.id === wanted || modelItem.modelId === wanted) ?? null
    );
  }, [draft.chatModelId, settings.chatModelId, settings.providers]);
  const messageTemplatePreview = React.useMemo(
    () => [
      {
        role: "user",
        text: renderMessageTemplatePreview(
          messageTemplateValue,
          t("settings:assistants.preview_user_input"),
          "user",
          draft,
          previewModel,
        ),
      },
      {
        role: "assistant",
        text: t("settings:assistants.preview_assistant_response"),
      },
    ],
    [draft, messageTemplateValue, previewModel],
  );
  const presetMessages = Array.isArray(draft.presetMessages)
    ? (draft.presetMessages as Array<Record<string, unknown>>)
    : [];
  const assistantRegexes = Array.isArray(draft.regexes)
    ? (draft.regexes as Array<Record<string, unknown>>)
    : [];
  const customHeaders = Array.isArray(draft.customHeaders)
    ? (draft.customHeaders as Array<Record<string, unknown>>)
    : [];
  const customBodies = Array.isArray(draft.customBodies)
    ? (draft.customBodies as Array<Record<string, unknown>>)
    : [];
  const updatePresetMessage = (index: number, patch: Record<string, unknown>) => {
    patchDraft({
      presetMessages: presetMessages.map((message, itemIndex) =>
        itemIndex === index ? { ...message, ...patch } : message,
      ),
    });
  };
  const updateRegex = (index: number, patch: Record<string, unknown>) => {
    patchDraft({
      regexes: assistantRegexes.map((regex, itemIndex) =>
        itemIndex === index ? { ...regex, ...patch } : regex,
      ),
    });
  };
  const updateCustomHeader = (index: number, patch: Record<string, unknown>) => {
    patchDraft({
      customHeaders: customHeaders.map((header, itemIndex) =>
        itemIndex === index ? { ...header, ...patch } : header,
      ),
    });
  };
  const updateCustomBody = (index: number, patch: Record<string, unknown>) => {
    patchDraft({
      customBodies: customBodies.map((body, itemIndex) =>
        itemIndex === index ? { ...body, ...patch } : body,
      ),
    });
  };
  return (
    <>
      <SectionHeader
        icon={Bot}
        title={t("settings:assistants.title")}
        subtitle={t("settings:assistants.subtitle")}
      />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="rounded-lg border bg-card p-2">
          <Button className="mb-2 w-full justify-start" variant="outline" onClick={addAssistant}>
            <CopyPlus className="size-4" />
            {t("settings:assistants.add")}
          </Button>
          {settings.assistants.map((item, index) => (
            <SortableRow
              key={item.id}
              id={item.id}
              index={index}
              active={item.id === draft.id}
              onSelect={() => setAssistantId(item.id)}
              onMove={moveAssistant}
            >
              <span className="flex items-center gap-2">
                <UIAvatar size="sm" name={item.name || "Assistant"} avatar={item.avatar} />
                <span className="truncate">
                  {item.name || t("settings:assistants.default_name")}
                </span>
              </span>
            </SortableRow>
          ))}
        </div>
        <div className="space-y-5 rounded-lg border bg-card p-5">
          <AvatarCropper
            value={draft.avatar}
            fallbackName={draft.name || "Assistant"}
            onChange={async (avatar) => {
              const nextDraft = { ...draft, avatar, useAssistantAvatar: true };
              setDraft(nextDraft);
              await api.post("settings/assistant/detail", nextDraft);
              onSettings({
                ...settings,
                assistantId: nextDraft.id,
                assistants: settings.assistants.map((item) =>
                  item.id === nextDraft.id ? nextDraft : item,
                ),
              });
            }}
          />
          <Separator />
          <label className="block space-y-2">
            <span className="text-sm font-medium">{t("settings:assistants.name")}</span>
            <Input
              value={draft.name}
              onChange={(event) => patchDraft({ name: event.target.value })}
            />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium">{t("settings:assistants.system_prompt")}</span>
            <Textarea
              className="min-h-52 font-mono text-xs"
              value={textValue(draft.systemPrompt)}
              onChange={(event) => patchDraft({ systemPrompt: event.target.value })}
            />
          </label>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  {t("settings:assistants.message_template_title")}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("settings:assistants.message_template_desc")}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={messageTemplateValue === "{{ message }}"}
                onClick={() => patchDraft({ messageTemplate: "{{ message }}" })}
              >
                <RefreshCw className="size-4" />
                {t("settings:assistants.reset")}
              </Button>
            </div>
            <Textarea
              className="min-h-32 font-mono text-xs"
              value={messageTemplateValue}
              onChange={(event) => patchDraft({ messageTemplate: event.target.value })}
            />
            {messageTemplateMissingMessage ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {t("settings:assistants.template_missing_warn", { token: "{{ message }}" })}
              </div>
            ) : null}
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="mb-2 text-sm font-medium">
                {t("settings:assistants.template_preview")}
              </div>
              <div className="space-y-2">
                {messageTemplatePreview.map((item) => (
                  <div key={item.role} className="rounded-md bg-background p-3 text-xs">
                    <div className="mb-1 text-muted-foreground">{item.role}</div>
                    <pre className="whitespace-pre-wrap font-sans leading-relaxed">{item.text}</pre>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                <span>{t("settings:assistants.available_vars")}</span>
                {[
                  "role",
                  "message",
                  "time",
                  "date",
                  "cur_datetime",
                  "user",
                  "char",
                  "model_name",
                ].map((variable) => (
                  <code key={variable} className="rounded bg-muted px-1.5 py-0.5 font-mono">
                    {`{{ ${variable} }}`}
                  </code>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  {t("settings:assistants.preset_messages_title")}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("settings:assistants.preset_messages_desc")}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  patchDraft({
                    presetMessages: [...presetMessages, { role: "ASSISTANT", content: "" }],
                  })
                }
              >
                <Plus className="size-4" />
                {t("settings:assistants.add_button")}
              </Button>
            </div>
            <div className="space-y-3">
              {presetMessages.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  {t("settings:assistants.no_preset")}
                </div>
              ) : null}
              {presetMessages.map((message, index) => (
                <div
                  key={String(message.id ?? index)}
                  className="rounded-md border bg-muted/20 p-3"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <Select
                      value={textValue(message.role).toUpperCase() || "ASSISTANT"}
                      onValueChange={(role) => updatePresetMessage(index, { role })}
                    >
                      <SelectTrigger className="h-8 w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SYSTEM">System</SelectItem>
                        <SelectItem value="USER">User</SelectItem>
                        <SelectItem value="ASSISTANT">Assistant</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() =>
                        patchDraft({
                          presetMessages: presetMessages.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                      title={t("settings:assistants.delete_preset")}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <Textarea
                    className="min-h-24"
                    value={textValue(message.content)}
                    onChange={(event) =>
                      updatePresetMessage(index, { content: event.target.value })
                    }
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{t("settings:assistants.regex_title")}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("settings:assistants.regex_desc")}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  patchDraft({
                    regexes: [
                      ...assistantRegexes,
                      {
                        id: crypto.randomUUID(),
                        name: "",
                        enabled: true,
                        findRegex: "",
                        replaceString: "",
                        affectingScope: ["ASSISTANT"],
                        visualOnly: false,
                      },
                    ],
                  })
                }
              >
                <Plus className="size-4" />
                {t("settings:assistants.add_button")}
              </Button>
            </div>
            <div className="space-y-3">
              {assistantRegexes.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  {t("settings:assistants.no_regex")}
                </div>
              ) : null}
              {assistantRegexes.map((regex, index) => {
                const scopes = Array.isArray(regex.affectingScope)
                  ? regex.affectingScope.map(String)
                  : [];
                const toggleScope = (scope: "USER" | "ASSISTANT", checked: boolean) => {
                  const nextScopes = new Set(scopes);
                  if (checked) nextScopes.add(scope);
                  else nextScopes.delete(scope);
                  updateRegex(index, { affectingScope: [...nextScopes] });
                };
                return (
                  <div
                    key={String(regex.id ?? index)}
                    className="rounded-md border bg-muted/20 p-3"
                  >
                    <div className="mb-3 flex items-center gap-2">
                      <Switch
                        checked={regex.enabled !== false}
                        onCheckedChange={(checked) => updateRegex(index, { enabled: checked })}
                      />
                      <Input
                        className="h-8"
                        value={textValue(regex.name)}
                        onChange={(event) => updateRegex(index, { name: event.target.value })}
                        placeholder={t("settings:assistants.regex_name_ph")}
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={() =>
                          patchDraft({
                            regexes: assistantRegexes.filter((_, itemIndex) => itemIndex !== index),
                          })
                        }
                        title={t("settings:assistants.delete_regex")}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Find Regex</span>
                        <Input
                          value={textValue(regex.findRegex)}
                          onChange={(event) =>
                            updateRegex(index, { findRegex: event.target.value })
                          }
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-xs text-muted-foreground">Replace String</span>
                        <Input
                          value={textValue(regex.replaceString)}
                          onChange={(event) =>
                            updateRegex(index, { replaceString: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                      <label className="flex items-center gap-2">
                        <Checkbox
                          checked={scopes.includes("USER")}
                          onCheckedChange={(checked) => toggleScope("USER", checked === true)}
                        />
                        User
                      </label>
                      <label className="flex items-center gap-2">
                        <Checkbox
                          checked={scopes.includes("ASSISTANT")}
                          onCheckedChange={(checked) => toggleScope("ASSISTANT", checked === true)}
                        />
                        Assistant
                      </label>
                      <label className="flex items-center gap-2">
                        <Checkbox
                          checked={regex.visualOnly === true}
                          onCheckedChange={(checked) =>
                            updateRegex(index, { visualOnly: checked === true })
                          }
                        />
                        {t("settings:assistants.visual_only")}
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {parameterControl("temperature", "Temperature", 2, 0.05)}
            {parameterControl("topP", "Top P", 1, 0.01)}
            <label className="space-y-2">
              <span className="text-sm font-medium">Max Tokens</span>
              <Input
                value={numberText(draft.maxTokens)}
                placeholder={t("settings:assistants.max_tokens_ph")}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  setDraft({
                    ...draft,
                    maxTokens: raw === "" ? null : Math.max(1, Number(raw) || 1),
                  });
                }}
              />
              <div className="text-xs text-muted-foreground">
                {t("settings:assistants.max_tokens_desc")}
              </div>
            </label>
          </div>
          <label className="space-y-2">
            <span className="text-sm font-medium">
              {t("settings:assistants.context_message_size")}
            </span>
            <div className="flex items-center gap-3">
              <Slider
                min={0}
                max={512}
                step={1}
                value={[
                  typeof draft.contextMessageSize === "number"
                    ? draft.contextMessageSize
                    : 0,
                ]}
                onValueChange={([next]) =>
                  patchDraft({ contextMessageSize: next ?? 0 })
                }
              />
              <Input
                className="w-24"
                inputMode="numeric"
                value={
                  typeof draft.contextMessageSize === "number" &&
                  draft.contextMessageSize > 0
                    ? String(draft.contextMessageSize)
                    : ""
                }
                placeholder={t(
                  "settings:assistants.context_message_unlimited",
                )}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (raw === "") {
                    patchDraft({ contextMessageSize: 0 });
                    return;
                  }
                  const parsed = Math.floor(Number(raw));
                  patchDraft({
                    contextMessageSize:
                      Number.isFinite(parsed) && parsed > 0
                        ? Math.min(512, parsed)
                        : 0,
                  });
                }}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {t("settings:assistants.context_message_desc")}
            </div>
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            {[
              ["enableRecentChatsReference", t("settings:assistants.opt.recent_chats")],
              ["streamOutput", t("settings:assistants.opt.stream_output")],
              ["enableTimeReminder", t("settings:assistants.opt.time_reminder")],
              ["useAssistantAvatar", t("settings:assistants.opt.use_avatar")],
              ["allowConversationSystemPrompt", t("settings:assistants.opt.allow_conv_prompt")],
            ].map(([key, label]) => (
              <label
                key={key}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <span className="text-sm">{label}</span>
                <Switch
                  checked={draft[key] === true}
                  onCheckedChange={(checked) =>
                    patchDraft({ [key]: checked } as Partial<AssistantProfile>)
                  }
                />
              </label>
            ))}
          </div>
          {/* 1.3.2 记忆管理(含 enableMemory 开关)已移至独立的「记忆」板块,见 nav.memory */}
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">{t("settings:assistants.local_tools_title")}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("settings:assistants.local_tools_desc")}
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {[
                ["time_info", t("settings:assistants.tools.time_info.title"), t("settings:assistants.tools.time_info.desc")],
                [
                  "javascript_engine",
                  t("settings:assistants.tools.js_engine.title"),
                  t("settings:assistants.tools.js_engine.desc"),
                ],
                ["clipboard", t("settings:assistants.tools.clipboard.title"), t("settings:assistants.tools.clipboard.desc")],
                ["tts", t("settings:assistants.tools.tts.title"), t("settings:assistants.tools.tts.desc")],
                ["ask_user", t("settings:assistants.tools.ask_user.title"), t("settings:assistants.tools.ask_user.desc")],
              ].map(([type, label, desc]) => {
                const enabled =
                  Array.isArray(draft.localTools) &&
                  draft.localTools.some((tool) =>
                    isPlainRecord(tool) ? tool.type === type : tool === type,
                  );
                return (
                  <label
                    key={type}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <span>
                      <span className="block text-sm">{label}</span>
                      <span className="block text-xs text-muted-foreground">{desc}</span>
                    </span>
                    <Switch
                      checked={enabled}
                      onCheckedChange={(checked) => {
                        const current = Array.isArray(draft.localTools) ? draft.localTools : [];
                        const next = checked
                          ? [
                              ...current.filter(
                                (tool) =>
                                  !(isPlainRecord(tool) ? tool.type === type : tool === type),
                              ),
                              { type },
                            ]
                          : current.filter(
                              (tool) => !(isPlainRecord(tool) ? tool.type === type : tool === type),
                            );
                        patchDraft({ localTools: next });
                      }}
                    />
                  </label>
                );
              })}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-3 text-sm font-medium">{t("settings:assistants.custom_request_title")}</div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm">Headers</div>
                    <div className="text-xs text-muted-foreground">
                      {t("settings:assistants.headers_desc")}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      patchDraft({ customHeaders: [...customHeaders, { name: "", value: "" }] })
                    }
                  >
                    <Plus className="size-4" />
                    {t("settings:assistants.add_button")}
                  </Button>
                </div>
                {customHeaders.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                    {t("settings:assistants.no_header")}
                  </div>
                ) : null}
                {customHeaders.map((header, index) => (
                  <div
                    key={index}
                    className="grid gap-2 rounded-md border bg-muted/20 p-3 md:grid-cols-[1fr_1fr_auto]"
                  >
                    <Input
                      value={textValue(header.name ?? header.key)}
                      onChange={(event) => updateCustomHeader(index, { name: event.target.value })}
                      placeholder="Header name"
                    />
                    <Input
                      value={textValue(header.value)}
                      onChange={(event) => updateCustomHeader(index, { value: event.target.value })}
                      placeholder="Header value"
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() =>
                        patchDraft({
                          customHeaders: customHeaders.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm">Bodies</div>
                    <div className="text-xs text-muted-foreground">
                      {t("settings:assistants.bodies_desc")}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      patchDraft({ customBodies: [...customBodies, { key: "", value: '""' }] })
                    }
                  >
                    <Plus className="size-4" />
                    {t("settings:assistants.add_button")}
                  </Button>
                </div>
                {customBodies.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                    {t("settings:assistants.no_body")}
                  </div>
                ) : null}
                {customBodies.map((body, index) => (
                  <div key={index} className="rounded-md border bg-muted/20 p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Input
                        value={textValue(body.key ?? body.name)}
                        onChange={(event) => updateCustomBody(index, { key: event.target.value })}
                        placeholder="Body key"
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={() =>
                          patchDraft({
                            customBodies: customBodies.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <Textarea
                      className="min-h-24 font-mono text-xs"
                      value={
                        typeof body.value === "string"
                          ? body.value
                          : JSON.stringify(body.value ?? "", null, 2)
                      }
                      onChange={(event) => updateCustomBody(index, { value: event.target.value })}
                      placeholder={t("settings:assistants.body_value_ph")}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">{t("settings:assistants.ext_summary_title")}</div>
            <div className="mt-2 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
              <div>{t("settings:assistants.ext_injection")}: {(draft.modeInjectionIds ?? []).length}</div>
              <div>{t("settings:assistants.ext_lorebook")}: {(draft.lorebookIds ?? []).length}</div>
              <div>MCP: {(draft.mcpServers ?? []).length}</div>
              <div>
                Local tools: {Array.isArray(draft.localTools) ? draft.localTools.length : 0}
              </div>
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={removeAssistant}
              disabled={settings.assistants.length <= 1}
            >
              <Trash2 className="size-4" />
              {t("settings:assistants.delete")}
            </Button>
            <div className="flex items-center px-2 text-xs text-muted-foreground">{t("settings:assistants.autosaved")}</div>
          </div>
        </div>
      </div>
    </>
  );
}


function McpExtensionsSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  type Tab = "mcp" | "mode" | "lorebook" | "quick" | "skills";
  const tabFromQuery = React.useMemo<Tab>(() => {
    if (typeof window === "undefined") return "mcp";
    const value = new URLSearchParams(window.location.search).get("tab");
    return value === "mcp" ||
      value === "mode" ||
      value === "lorebook" ||
      value === "quick" ||
      value === "skills"
      ? value
      : "mcp";
  }, []);
  const [tab, setTab] = React.useState<Tab>(tabFromQuery);
  const [selectedAssistantId, setSelectedAssistantId] = React.useState(settings.assistantId);
  const selectedAssistant =
    settings.assistants.find((item) => item.id === selectedAssistantId) ?? settings.assistants[0];

  React.useEffect(() => {
    if (!settings.assistants.some((item) => item.id === selectedAssistantId))
      setSelectedAssistantId(settings.assistantId);
  }, [selectedAssistantId, settings.assistantId, settings.assistants]);

  return (
    <>
      <SectionHeader
        icon={CopyPlus}
        title={t("settings:mcp.title")}
        subtitle={t("settings:mcp.subtitle")}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(
          [
            ["mcp", "MCP", CopyPlus],
            ["mode", t("settings:mcp.tab.mode"), WandSparkles],
            ["lorebook", t("settings:mcp.tab.lorebook"), Database],
            ["quick", t("settings:mcp.tab.quick"), MessageSquareText],
            ["skills", "Skills", Bot],
          ] as Array<[Tab, string, React.ComponentType<{ className?: string }>]>
        ).map(([idValue, label, Icon]) => (
          <Button
            key={String(idValue)}
            variant={tab === idValue ? "default" : "outline"}
            size="sm"
            onClick={() => setTab(idValue as Tab)}
          >
            {React.createElement(Icon as React.ComponentType<{ className?: string }>, {
              className: "size-4",
            })}
            {label}
          </Button>
        ))}
        <div className="ml-auto min-w-56">
          <Select value={selectedAssistant.id} onValueChange={setSelectedAssistantId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {settings.assistants.map((assistant) => (
                <SelectItem key={assistant.id} value={assistant.id}>
                  {assistant.name || t("settings:assistants.default_name")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {tab === "mcp" && (
        <McpServerEditor
          settings={settings}
          assistant={selectedAssistant}
          onSettings={onSettings}
        />
      )}
      {tab === "mode" && (
        <ModeInjectionEditor
          settings={settings}
          assistant={selectedAssistant}
          onSettings={onSettings}
        />
      )}
      {tab === "lorebook" && (
        <LorebookEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />
      )}
      {tab === "quick" && (
        <QuickMessageEditor
          settings={settings}
          assistant={selectedAssistant}
          onSettings={onSettings}
        />
      )}
      {tab === "skills" && (
        <SkillsEditor settings={settings} assistant={selectedAssistant} onSettings={onSettings} />
      )}
    </>
  );
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? [], null, 2);
}

function parseJson<T>(value: string, fallback: T, errorMsg = "Invalid JSON"): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    void fallback;
    throw new Error(errorMsg);
  }
}

async function pullSettings(onSettings: (settings: Settings) => void) {
  const next = await api.get<Settings>("settings");
  onSettings(next);
  return next;
}

function mcpName(server: Record<string, unknown>) {
  const common =
    server.commonOptions && typeof server.commonOptions === "object"
      ? (server.commonOptions as Record<string, unknown>)
      : {};
  return textValue(common.name) || "MCP Server";
}

function mcpStatus(server: Record<string, unknown>) {
  const common =
    server.commonOptions && typeof server.commonOptions === "object"
      ? (server.commonOptions as Record<string, unknown>)
      : {};
  if (common.enable === false) return { ok: false, key: "off" };
  if (common.connected === false || textValue(common.lastSyncError))
    return { ok: false, key: "error" };
  return { ok: true, key: "connected" };
}

function McpServerEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const servers = (settings.mcpServers ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(servers[0]?.id));
  const selected =
    servers.find((item) => String(item.id) === selectedId) ?? servers[0] ?? createMcpServer();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  const [headersText, setHeadersText] = React.useState(
    prettyJson((selected.commonOptions as Record<string, unknown> | undefined)?.headers ?? []),
  );
  const [toolsText, setToolsText] = React.useState(
    prettyJson((selected.commonOptions as Record<string, unknown> | undefined)?.tools ?? []),
  );
  const [busy, setBusy] = React.useState(false);
  // dirtyRef drives the debounce autosave (set on every edit, cleared on save completion).
  const dirtyRef = React.useRef(false);
  // Race-condition tracking for in-flight saves. A keystroke landing between "save starts"
  // and "save resolves" used to have its dirtyRef=true overwritten by the post-save reset,
  // so the next debounce cycle skipped and the keystroke was never persisted — it lingered
  // in draft only until the realignment effect below clobbered it with the just-saved
  // (older) snapshot. savingRef lets every edit during the save window flag
  // editedDuringSaveRef; on completion we keep dirtyRef true when it's set, so the next
  // debounce re-saves instead of dropping the keystroke.
  const savingRef = React.useRef(false);
  const editedDuringSaveRef = React.useRef(false);
  // serversRef lets the realignment effect read the freshest servers list WITHOUT taking
  // settings.mcpServers as a dependency. If settings.mcpServers were a dep, the effect
  // would re-fire after every save → pullSettings round-trip and overwrite in-flight
  // keystrokes — the original "URL input eats characters" bug. The old dirtyRef guard
  // tried to defend this but was undone by save() clearing dirtyRef on completion (the
  // keystroke-while-saving window).
  const serversRef = React.useRef(servers);
  serversRef.current = servers;

  const markDirty = () => {
    dirtyRef.current = true;
    if (savingRef.current) editedDuringSaveRef.current = true;
  };

  React.useEffect(() => {
    // Re-load the form only when the user switches server (selectedId). settings.mcpServers
    // is intentionally NOT a dep — see serversRef above.
    const all = serversRef.current;
    const next = all.find((item) => String(item.id) === selectedId) ?? all[0];
    if (!next) return;
    if (String(next.id) !== selectedId) setSelectedId(String(next.id));
    setDraft(clone(next));
    setHeadersText(
      prettyJson((next.commonOptions as Record<string, unknown> | undefined)?.headers ?? []),
    );
    setToolsText(
      prettyJson((next.commonOptions as Record<string, unknown> | undefined)?.tools ?? []),
    );
    dirtyRef.current = false;
    editedDuringSaveRef.current = false;
  }, [selectedId]);

  const common =
    draft.commonOptions && typeof draft.commonOptions === "object"
      ? (draft.commonOptions as Record<string, unknown>)
      : {};
  const tools = Array.isArray(common.tools) ? (common.tools as Array<Record<string, unknown>>) : [];
  // Master switch (commonOptions.enable). When OFF, the per-tool child switches stay
  // visible AND show their last preference, but are read-only & greyed — the user can
  // see what'll come back when they re-enable the master switch.
  const serverEnabled = common.enable !== false;
  // Inline expand state — matches Android McpToolCard (SettingMcpPage.kt:801 `var expanded`).
  // Tracked by tool name (server-unique) so re-renders don't lose the open card.
  const [expandedToolName, setExpandedToolName] = React.useState<string | null>(null);
  const patchDraft = (nextDraft: Record<string, unknown>) => {
    markDirty();
    setDraft(nextDraft);
  };
  // Update one tool's fields (enable / needsApproval) without losing other tools' edits.
  // We mutate both the in-memory tools array (drives the UI) and toolsText (the canonical
  // persistence source consumed by save()) so the debounced auto-save writes the toggle.
  const updateToolAt = (index: number, patch: Partial<Record<string, unknown>>) => {
    const nextTools = tools.map((tool, i) => (i === index ? { ...tool, ...patch } : tool));
    const nextCommon = { ...common, tools: nextTools };
    patchDraft({ ...draft, commonOptions: nextCommon });
    setToolsText(prettyJson(nextTools));
  };
  // Merge the server's authoritative fields (fetched tools, sync status, Transition 1/2
  // enable flips) into the current draft WITHOUT touching user-edited fields (url / name /
  // headers text). Functional setState reads the freshest draft, so keystrokes that landed
  // during the save's network round-trip survive the merge.
  const applyServerResult = (serverData: Record<string, unknown>) => {
    const serverCommon =
      serverData.commonOptions && typeof serverData.commonOptions === "object"
        ? (serverData.commonOptions as Record<string, unknown>)
        : {};
    setDraft((prev) => {
      const prevCommon =
        prev.commonOptions && typeof prev.commonOptions === "object"
          ? (prev.commonOptions as Record<string, unknown>)
          : {};
      return {
        ...prev,
        commonOptions: {
          ...prevCommon,
          tools: serverCommon.tools ?? prevCommon.tools ?? [],
          lastSyncAt: serverCommon.lastSyncAt ?? prevCommon.lastSyncAt,
          lastSyncError: serverCommon.lastSyncError ?? prevCommon.lastSyncError,
          connected: serverCommon.connected ?? prevCommon.connected,
          enable:
            serverCommon.enable !== undefined ? serverCommon.enable : prevCommon.enable,
        },
      };
    });
    setToolsText(prettyJson(serverCommon.tools ?? []));
  };
  const patchCommon = (patch: Record<string, unknown>) => {
    let parsedHeaders: unknown[];
    let parsedTools: unknown[];
    try {
      parsedHeaders = parseJson<unknown[]>(headersText, [], t("settings:mcp.json_invalid"));
      parsedTools = parseJson<unknown[]>(toolsText, [], t("settings:mcp.json_invalid"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.json_invalid"));
      return;
    }
    const nextDraft = { ...draft, commonOptions: { ...common, ...patch } };
    setDraft(nextDraft);
    savingRef.current = true;
    editedDuringSaveRef.current = false;
    void api
      .post<{ server: Record<string, unknown> }>("settings/mcp-server/detail", {
        ...nextDraft,
        commonOptions: {
          ...(nextDraft.commonOptions as Record<string, unknown>),
          headers: parsedHeaders,
          tools: parsedTools,
        },
      })
      .then((result: { server: Record<string, unknown> }) => {
        setSelectedId(String(result.server.id));
        savingRef.current = false;
        // Keep dirty if the user typed during the round-trip; otherwise mark clean.
        dirtyRef.current = editedDuringSaveRef.current;
        applyServerResult(result.server);
        return pullSettings(onSettings);
      })
      .catch((error) => {
        savingRef.current = false;
        dirtyRef.current = true; // retry on next debounce
        toast.error(error instanceof Error ? error.message : t("settings:mcp.save_failed"));
      });
  };
  const save = async (announce = true) => {
    if (!announce && !dirtyRef.current) return;
    setBusy(true);
    savingRef.current = true;
    editedDuringSaveRef.current = false;
    try {
      const payload = {
        ...draft,
        commonOptions: {
          ...common,
          headers: parseJson<unknown[]>(headersText, [], t("settings:mcp.json_invalid")),
          tools: parseJson<unknown[]>(toolsText, [], t("settings:mcp.json_invalid")),
        },
      };
      const result = await api.post<{ server: Record<string, unknown> }>(
        "settings/mcp-server/detail",
        payload,
      );
      setSelectedId(String(result.server.id));
      savingRef.current = false;
      // Keep dirty if the user typed during the round-trip; otherwise mark clean.
      dirtyRef.current = editedDuringSaveRef.current;
      applyServerResult(result.server);
      await pullSettings(onSettings);
      if (announce) toast.success(t("settings:mcp.server.saved"));
    } catch (error) {
      savingRef.current = false;
      dirtyRef.current = true; // retry on next debounce
      if (announce) toast.error(error instanceof Error ? error.message : t("settings:mcp.save_failed"));
      else console.warn("MCP auto-save failed", error);
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, headersText, toolsText]);
  const remove = async () => {
    if (!selected.id || !window.confirm(t("settings:mcp.server.delete_confirm"))) return;
    await api.delete(`settings/mcp-server/${encodeURIComponent(String(selected.id))}`);
    setSelectedId("");
    await pullSettings(onSettings);
    toast.success(t("settings:mcp.server.deleted"));
  };
  const reorder = async (from: number, to: number) => {
    const next = moveItem(servers, from, to);
    onSettings({ ...settings, mcpServers: next as unknown as Settings["mcpServers"] });
    await api.post("settings/mcp-server/reorder", { ids: next.map((item) => String(item.id)) });
    await pullSettings(onSettings);
  };

  return (
    <EditorShell
      items={servers}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.server.empty")}
      onSelect={setSelectedId}
      onMove={reorder}
      titleOf={mcpName}
      renderItem={(item) => {
        const status = mcpStatus(item);
        return (
          <div className="flex min-w-0 items-center gap-2 text-left">
            <span
              className={`size-2 shrink-0 rounded-full ${status.ok ? "bg-emerald-500" : "bg-red-500"}`}
              title={t(`settings:mcp.status_${status.key}`)}
            />
            <span className="truncate">{mcpName(item)}</span>
          </div>
        );
      }}
      onCreate={async () => {
        // Save the new item server-side BEFORE touching any state. Without the immediate
        // POST, the 800 ms debounce loses the race against the `[selectedId, settings.X]`
        // realignment effect at line 3410 — which fires when `setSelectedId(next.id)`
        // changes the dep, doesn't find the new id in `servers` (settings hasn't refreshed
        // yet), and snaps selectedId back to servers[0]. End result: the new item is
        // silently discarded. Eager-saving guarantees the new item lands in `settings`
        // before the realignment effect runs, so it finds and keeps the just-created id.
        const next = createMcpServer();
        try {
          await api.post("settings/mcp-server/detail", next);
          await pullSettings(onSettings);
          setSelectedId(String(next.id));
          setDraft(clone(next));
          setHeadersText("[]");
          setToolsText("[]");
          dirtyRef.current = false;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.server.create_failed"));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">{t("settings:mcp.server.detail")}</div>
            <div className="text-xs text-muted-foreground">
              {t("settings:mcp.server.detail_desc")}
            </div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.name")}</span>
            <Input
              value={textValue(common.name)}
              onChange={(event) =>
                patchDraft({ ...draft, commonOptions: { ...common, name: event.target.value } })
              }
              placeholder={t("settings:mcp.name_ph")}
            />
          </label>
          <label className="flex items-end gap-2 pb-1">
            <span className="pb-2 text-sm text-muted-foreground">{t("settings:mcp.enabled")}</span>
            <Switch
              checked={common.enable !== false}
              onCheckedChange={(checked) => patchCommon({ enable: checked })}
            />
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Select
            value={textValue(draft.type) || "streamable_http"}
            onValueChange={(value) => patchDraft({ ...draft, type: value })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="streamable_http">Streamable HTTP</SelectItem>
              <SelectItem value="sse">SSE</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.server.url")}</span>
          <Input
            value={textValue(draft.url)}
            onChange={(event) => patchDraft({ ...draft, url: event.target.value })}
            placeholder="https://example.com/mcp"
          />
          <span className="block text-xs text-muted-foreground">
            {t("settings:mcp.server.url_desc")}
          </span>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.server.headers_json")}</span>
          <Textarea
            value={headersText}
            onChange={(event) => {
              markDirty();
              setHeadersText(event.target.value);
            }}
            className="min-h-24 font-mono text-xs"
            placeholder='[["Authorization","Bearer ..."]]'
          />
          <span className="block text-xs text-muted-foreground">
            {t("settings:mcp.server.headers_desc")}
          </span>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.server.tools_json")}</span>
          <Textarea
            value={toolsText}
            onChange={(event) => {
              markDirty();
              setToolsText(event.target.value);
            }}
            className="h-44 max-h-44 font-mono text-xs"
            placeholder={t("settings:mcp.server.tools_ph")}
          />
          <span className="block text-xs text-muted-foreground">
            {t("settings:mcp.server.tools_desc")}
            {textValue(common.lastSyncError) ? t("settings:mcp.server.last_error", { error: textValue(common.lastSyncError) }) : ""}
          </span>
        </label>
        <div className="rounded-md border">
          <div className="border-b px-3 py-2 text-sm font-medium">{t("settings:mcp.server.tools_title")}</div>
          <div className="max-h-[28rem] overflow-auto p-2">
            {tools.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">{t("settings:mcp.server.tools_empty")}</div>
            ) : null}
            {/* McpToolCard mirror — first row: name + needs-approval switch + enable switch +
                expand chevron. Expanded body: markdown description + JSON-schema property tags.
                Matches Android SettingMcpPage.kt:795-902 (no Dialog, all inline).
                Master/child semantics: when the MCP server's commonOptions.enable is false,
                the per-tool switches are read-only and greyed out — but they STILL show the
                user's last preference, which the master-on transition will revive. */}
            {tools.map((tool, index) => {
              const name = textValue(tool.name) || "unnamed_tool";
              const description = textValue(tool.description);
              const enabled = tool.enable !== false;
              const needsApproval = tool.needsApproval === true;
              const expanded = expandedToolName === name;
              const schema =
                tool.inputSchema && typeof tool.inputSchema === "object"
                  ? (tool.inputSchema as Record<string, unknown>)
                  : null;
              const properties =
                schema && schema.properties && typeof schema.properties === "object"
                  ? (schema.properties as Record<string, Record<string, unknown>>)
                  : {};
              const required = Array.isArray(schema?.required)
                ? (schema!.required as unknown[]).map(String)
                : [];
              const propertyEntries = Object.entries(properties);
              return (
                <div
                  key={`${name}_${index}`}
                  className={cn(
                    "rounded-md border bg-muted/20 px-3 py-2 mb-2 last:mb-0",
                    !serverEnabled && "opacity-60",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="flex-1 truncate text-sm font-medium" title={name}>
                      {name}
                    </span>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>{t("settings:mcp.server.needs_approval")}</span>
                      <Switch
                        checked={needsApproval}
                        disabled={!serverEnabled}
                        onCheckedChange={(checked) =>
                          updateToolAt(index, { needsApproval: checked })
                        }
                      />
                    </label>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>{t("settings:mcp.enabled")}</span>
                      <Switch
                        checked={enabled}
                        disabled={!serverEnabled}
                        onCheckedChange={(checked) => updateToolAt(index, { enable: checked })}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setExpandedToolName(expanded ? null : name)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={expanded ? t("settings:mcp.server.collapse") : t("settings:mcp.server.expand")}
                    >
                      <ChevronDownChip expanded={expanded} />
                    </button>
                  </div>
                  {expanded ? (
                    <div className="mt-2 space-y-2">
                      {description ? (
                        <div className="text-xs text-muted-foreground">
                          <Markdown content={description} className="message-markdown" />
                        </div>
                      ) : null}
                      {propertyEntries.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {propertyEntries.map(([propName]) => {
                            const isRequired = required.includes(propName);
                            return (
                              <span
                                key={propName}
                                className={cn(
                                  "rounded-md px-2 py-0.5 font-mono text-[0.6875rem]",
                                  isRequired
                                    ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
                                    : "bg-background text-muted-foreground border",
                                )}
                                title={isRequired ? `${propName} (required)` : propName}
                              >
                                {propName}
                              </span>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">
            {busy ? t("settings:mcp.autosaving") : t("settings:mcp.autosaved")}
          </div>
          <Button variant="destructive" onClick={() => void remove()} disabled={!selected.id}>
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function createMcpServer(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    type: "streamable_http",
    url: "",
    commonOptions: { enable: true, name: "MCP Server", headers: [], tools: [] },
  };
}

function ModeInjectionEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const items = (settings.modeInjections ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected =
    items.find((item) => String(item.id) === selectedId) ?? items[0] ?? createModeInjection();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (next) {
      setSelectedId(String(next.id));
      setDraft(clone(next));
    }
  }, [selectedId]);
  return (
    <PromptItemEditor
      settings={settings}
      assistant={assistant}
      onSettings={onSettings}
      items={items}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      draft={draft}
      setDraft={setDraft}
      bindKey="modeInjectionIds"
      savePath="settings/mode-injection/detail"
      deletePath="settings/mode-injection"
      reorderPath="settings/mode-injection/reorder"
      createItem={createModeInjection}
      title={t("settings:mcp.tab.mode")}
    />
  );
}

function createModeInjection(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    type: "mode",
    name: "提示词注入",
    enabled: true,
    priority: 0,
    position: "after_system_prompt",
    role: "USER",
    injectDepth: 4,
    content: "",
  };
}

function createLorebookEntry(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    name: "",
    enabled: true,
    priority: 0,
    position: "after_system_prompt",
    role: "USER",
    injectDepth: 4,
    scanDepth: 4,
    keywords: [],
    useRegex: false,
    caseSensitive: false,
    constantActive: false,
    content: "",
  };
}

function LorebookEntryRow({
  entry,
  index,
  onChange,
  onDelete,
}: {
  entry: Record<string, unknown>;
  index: number;
  onChange: (next: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const patch = (next: Partial<Record<string, unknown>>) => onChange({ ...entry, ...next });
  const keywords = Array.isArray(entry.keywords) ? entry.keywords.map(String) : [];
  const position = textValue(entry.position) || "after_system_prompt";
  const usesStandaloneMessage =
    position === "top_of_chat" || position === "bottom_of_chat" || position === "at_depth";
  const constantActive = entry.constantActive === true;
  const triggerSummary = constantActive
    ? t("settings:mcp.constant_active")
    : keywords.length > 0
      ? t("settings:mcp.keywords_count", { count: keywords.length })
      : t("settings:mcp.no_trigger");
  return (
    <div className="rounded-md border bg-background">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              "size-2 rounded-full",
              entry.enabled === false ? "bg-muted-foreground/40" : "bg-emerald-500",
            )}
          />
          <span className="truncate text-sm font-medium">
            {textValue(entry.name) || t("settings:mcp.entry_n", { n: index + 1 })}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">· {triggerSummary}</span>
        </span>
        <ChevronDownChip expanded={expanded} />
      </button>
      {expanded ? (
        <div className="space-y-3 border-t px-3 py-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.name")}</span>
              <Input
                value={textValue(entry.name)}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder={t("settings:mcp.entry_name_ph")}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.priority")}</span>
              <Input
                type="number"
                value={numberText(entry.priority)}
                onChange={(event) => patch({ priority: Number(event.target.value) })}
                placeholder="0"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.position")}</span>
              <Select value={position} onValueChange={(value) => patch({ position: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="before_system_prompt">{t("settings:mcp.pos.before")}</SelectItem>
                  <SelectItem value="after_system_prompt">{t("settings:mcp.pos.after")}</SelectItem>
                  <SelectItem value="top_of_chat">{t("settings:mcp.pos.top")}</SelectItem>
                  <SelectItem value="bottom_of_chat">{t("settings:mcp.pos.bottom")}</SelectItem>
                  <SelectItem value="at_depth">{t("settings:mcp.pos.depth")}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {usesStandaloneMessage ? (
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.role")}</span>
                <Select
                  value={textValue(entry.role) || "USER"}
                  onValueChange={(value) => patch({ role: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USER">User</SelectItem>
                    <SelectItem value="ASSISTANT">Assistant</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            {position === "at_depth" ? (
              <label className="space-y-1">
                <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.inject_depth")}</span>
                <Input
                  type="number"
                  min={1}
                  value={numberText(entry.injectDepth ?? 4)}
                  onChange={(event) =>
                    patch({ injectDepth: Math.max(1, Number(event.target.value) || 4) })
                  }
                  placeholder="4"
                />
              </label>
            ) : null}
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:mcp.scan_depth")}
              </span>
              <Input
                type="number"
                min={1}
                value={numberText(entry.scanDepth ?? 4)}
                onChange={(event) =>
                  patch({ scanDepth: Math.max(1, Number(event.target.value) || 4) })
                }
                placeholder="4"
              />
            </label>
          </div>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("settings:mcp.keywords_label")}
            </span>
            <KeywordChipInput
              keywords={keywords}
              disabled={constantActive}
              onChange={(next) => patch({ keywords: next })}
            />
          </label>
          <div className="grid gap-2 md:grid-cols-3">
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{t("settings:mcp.use_regex")}</span>
              <Switch
                checked={entry.useRegex === true}
                onCheckedChange={(checked) => patch({ useRegex: checked })}
                disabled={constantActive}
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{t("settings:mcp.case_sensitive")}</span>
              <Switch
                checked={entry.caseSensitive === true}
                onCheckedChange={(checked) => patch({ caseSensitive: checked })}
                disabled={constantActive}
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>{t("settings:mcp.constant_active")}</span>
              <Switch
                checked={constantActive}
                onCheckedChange={(checked) => patch({ constantActive: checked })}
              />
            </label>
          </div>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.inject_content")}</span>
            <Textarea
              value={textValue(entry.content)}
              onChange={(event) => patch({ content: event.target.value })}
              className="min-h-32 font-mono text-xs leading-relaxed"
              placeholder={t("settings:mcp.inject_content_ph")}
            />
          </label>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={entry.enabled !== false}
                onCheckedChange={(checked) => patch({ enabled: checked })}
              />
              <span>{t("settings:mcp.enable_entry")}</span>
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 className="size-4" />
              {t("settings:mcp.delete_entry")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChevronDownChip({ expanded }: { expanded: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("text-muted-foreground transition", expanded ? "rotate-180" : "rotate-0")}
    >
      ▾
    </span>
  );
}

function KeywordChipInput({
  keywords,
  disabled,
  onChange,
}: {
  keywords: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = React.useState("");
  const commit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (keywords.includes(trimmed)) {
      setValue("");
      return;
    }
    onChange([...keywords, trimmed]);
    setValue("");
  };
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1.5",
        disabled && "opacity-50",
      )}
    >
      {keywords.map((keyword) => (
        <span
          key={keyword}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
        >
          {keyword}
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            disabled={disabled}
            onClick={() => onChange(keywords.filter((item) => item !== keyword))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="min-w-32 flex-1 bg-transparent text-xs outline-none"
        placeholder={disabled ? t("settings:mcp.keywords_disabled_ph") : t("settings:mcp.keywords_ph")}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && !value && keywords.length > 0) {
            onChange(keywords.slice(0, -1));
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

function LorebookEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const items = (settings.lorebooks ?? []) as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected =
    items.find((item) => String(item.id) === selectedId) ?? items[0] ?? createLorebook();
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  const dirtyRef = React.useRef(false);
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (!next) return;
    setSelectedId(String(next.id));
    setDraft(clone(next));
    dirtyRef.current = false;
  }, [selectedId]);
  const entries = Array.isArray(draft.entries)
    ? (draft.entries as Array<Record<string, unknown>>)
    : [];
  const patchDraft = (patch: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };
  const setEntries = (next: Array<Record<string, unknown>>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, entries: next });
  };
  const save = async (announce = true) => {
    if (!announce && !dirtyRef.current) return;
    await api.post("settings/lorebook/detail", draft);
    dirtyRef.current = false;
    await pullSettings(onSettings);
    if (announce) toast.success(t("settings:mcp.lorebook.saved"));
  };
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false).catch((error: Error) => console.warn("Lorebook auto-save failed", error));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant.lorebookIds ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      modeInjectionIds: assistant.modeInjectionIds ?? [],
      lorebookIds: [...ids],
      quickMessageIds: assistant.quickMessageIds ?? [],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.lorebook.empty")}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.name) || t("settings:mcp.tab.lorebook")}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, lorebooks: next as unknown as Settings["lorebooks"] });
        await api.post("settings/lorebook/reorder", { ids: next.map((item) => String(item.id)) });
      }}
      onCreate={async () => {
        // Eager-save pattern — same race-condition rationale as MCP and ModeInjection
        // (see settings.tsx:3515 and the PromptItemEditor onCreate comment). The original
        // setState + dirtyRef=true approach loses the new lorebook because the
        // `[selectedId, settings.lorebooks]` realignment effect at line 3857 fires when
        // selectedId changes, doesn't find the new id in settings (not saved yet), and
        // snaps the user back to lorebooks[0] — silently dropping the new entry.
        const next = createLorebook();
        next.name = t("settings:mcp.tab.lorebook");
        try {
          await api.post("settings/lorebook/detail", next);
          await pullSettings(onSettings);
          setSelectedId(String(next.id));
          setDraft(next);
          dirtyRef.current = false;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.lorebook.create_failed"));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.lorebook.detail")}</div>
          <Switch
            checked={(assistant.lorebookIds ?? []).includes(String(draft.id))}
            onCheckedChange={(checked) => void bind(checked)}
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.name")}</span>
            <Input
              value={textValue(draft.name)}
              onChange={(event) => patchDraft({ name: event.target.value })}
              placeholder={t("settings:mcp.lorebook.name_ph")}
            />
          </label>
          <label className="flex items-end gap-2">
            <span className="flex-1 space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.lorebook.enable")}</span>
              <div className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>{draft.enabled === false ? t("settings:mcp.disabled") : t("settings:mcp.enabled")}</span>
                  <Switch
                    checked={draft.enabled !== false}
                    onCheckedChange={(checked) => patchDraft({ enabled: checked })}
                  />
                </div>
              </div>
            </span>
          </label>
        </div>
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.lorebook.desc")}</span>
          <Input
            value={textValue(draft.description)}
            onChange={(event) => patchDraft({ description: event.target.value })}
            placeholder={t("settings:mcp.lorebook.desc_ph")}
          />
        </label>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">{t("settings:mcp.entries_count", { count: entries.length })}</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEntries([...entries, createLorebookEntry()])}
            >
              <Plus className="size-4" />
              {t("settings:mcp.add_entry")}
            </Button>
          </div>
          <div className="space-y-2">
            {entries.length === 0 ? (
              <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                {t("settings:mcp.no_entries")}
              </div>
            ) : null}
            {entries.map((entry, index) => (
              <LorebookEntryRow
                key={String(entry.id ?? index)}
                entry={entry}
                index={index}
                onChange={(next) =>
                  setEntries(entries.map((item, idx) => (idx === index ? next : item)))
                }
                onDelete={() => setEntries(entries.filter((_, idx) => idx !== index))}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">
            {t("settings:mcp.autosaved")}
          </div>
          <Button
            variant="destructive"
            onClick={async () => {
              await api.delete(`settings/lorebook/${draft.id}`);
              await pullSettings(onSettings);
            }}
          >
            <Trash2 className="size-4" />
            {t("settings:mcp.lorebook.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function createLorebook(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    name: "世界书",
    description: "",
    enabled: true,
    entries: [
      {
        id: crypto.randomUUID(),
        name: "",
        enabled: true,
        priority: 0,
        position: "after_system_prompt",
        role: "USER",
        injectDepth: 4,
        scanDepth: 4,
        keywords: [],
        useRegex: false,
        caseSensitive: false,
        content: "",
      },
    ],
  };
}

function QuickMessageEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const items = (settings.quickMessages ?? []) as unknown as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected = items.find((item) => String(item.id) === selectedId) ??
    items[0] ?? { id: crypto.randomUUID(), title: "", content: "" };
  const [draft, setDraft] = React.useState<Record<string, unknown>>(clone(selected));
  const dirtyRef = React.useRef(false);
  // itemsRef: avoid re-running this effect after every autosave → pullSettings round-trip
  // (would overwrite mid-flight keystrokes). See McpServerEditor for rationale.
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (next) {
      setSelectedId(String(next.id));
      setDraft(clone(next));
      dirtyRef.current = false;
    }
  }, [selectedId]);
  const patchDraft = (patch: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };
  const save = React.useCallback(
    async (announce = false) => {
      if (!announce && !dirtyRef.current) return;
      await api.post("settings/quick-message/detail", draft);
      dirtyRef.current = false;
      await pullSettings(onSettings);
      if (announce) toast.success(t("settings:mcp.quick.saved"));
    },
    [draft, onSettings],
  );
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false).catch((error: Error) =>
        console.warn("Quick message auto-save failed", error),
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, save]);
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant.quickMessageIds ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      modeInjectionIds: assistant.modeInjectionIds ?? [],
      lorebookIds: assistant.lorebookIds ?? [],
      quickMessageIds: [...ids],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.quick.empty")}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.title) || t("settings:mcp.tab.quick")}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, quickMessages: next as unknown as Settings["quickMessages"] });
        await api.post("settings/quick-message/reorder", {
          ids: next.map((item) => String(item.id)),
        });
      }}
      onCreate={() => {
        const next = { id: crypto.randomUUID(), title: t("settings:mcp.tab.quick"), content: "" };
        setSelectedId(String(next.id));
        setDraft(next);
        dirtyRef.current = true;
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.quick.detail")}</div>
          <Switch
            checked={(assistant.quickMessageIds ?? []).includes(String(draft.id))}
            onCheckedChange={(checked) => void bind(checked)}
          />
        </div>
        <Input
          value={textValue(draft.title)}
          onChange={(event) => patchDraft({ title: event.target.value })}
          placeholder={t("settings:mcp.quick.title")}
        />
        <Textarea
          value={textValue(draft.content)}
          onChange={(event) => patchDraft({ content: event.target.value })}
          className="min-h-52"
          placeholder={t("settings:mcp.quick.content")}
        />
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">
            {t("settings:mcp.autosaved")}
          </div>
          <Button
            variant="destructive"
            onClick={async () => {
              await api.delete(`settings/quick-message/${draft.id}`);
              await pullSettings(onSettings);
            }}
          >
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function PromptItemEditor({
  settings,
  assistant,
  onSettings,
  items,
  selectedId,
  setSelectedId,
  draft,
  setDraft,
  bindKey,
  savePath,
  deletePath,
  reorderPath,
  createItem,
  title,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
  items: Array<Record<string, unknown>>;
  selectedId: string;
  setSelectedId: (id: string) => void;
  draft: Record<string, unknown>;
  setDraft: (draft: Record<string, unknown>) => void;
  bindKey: "modeInjectionIds";
  savePath: string;
  deletePath: string;
  reorderPath: string;
  createItem: () => Record<string, unknown>;
  title: string;
}) {
  const { t } = useTranslation();
  const dirtyRef = React.useRef(false);
  const promptVariables = [
    "{{cur_datetime}}",
    "{{date}}",
    "{{time}}",
    "{{locale}}",
    "{{timezone}}",
    "{{model_name}}",
    "{{user}}",
    "{{char}}",
  ];
  const position = textValue(draft.position) || "after_system_prompt";
  const usesStandaloneMessage =
    position === "top_of_chat" || position === "bottom_of_chat" || position === "at_depth";
  React.useEffect(() => {
    dirtyRef.current = false;
  }, [selectedId, items]);
  const patchDraft = (patch: Record<string, unknown>) => {
    dirtyRef.current = true;
    setDraft({ ...draft, ...patch });
  };
  const save = React.useCallback(
    async (announce = false) => {
      if (!announce && !dirtyRef.current) return;
      await api.post(savePath, draft);
      dirtyRef.current = false;
      await pullSettings(onSettings);
      if (announce) toast.success(t("settings:mcp.item_saved", { title }));
    },
    [draft, onSettings, savePath, title],
  );
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false).catch((error: Error) => console.warn(`${title} auto-save failed`, error));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, save, title]);
  const appendVariable = (variable: string) => {
    const content = textValue(draft.content);
    const separator = content && !content.endsWith("\n") ? "\n" : "";
    patchDraft({ content: `${content}${separator}${variable}` });
  };
  const bind = async (checked: boolean) => {
    const ids = new Set(assistant[bindKey] ?? []);
    if (checked) ids.add(String(draft.id));
    else ids.delete(String(draft.id));
    await api.post("settings/assistant/injections", {
      assistantId: assistant.id,
      modeInjectionIds:
        bindKey === "modeInjectionIds" ? [...ids] : (assistant.modeInjectionIds ?? []),
      lorebookIds: assistant.lorebookIds ?? [],
      quickMessageIds: assistant.quickMessageIds ?? [],
    });
    await pullSettings(onSettings);
  };
  return (
    <EditorShell
      items={items}
      selectedId={selectedId}
      emptyLabel={t("settings:mcp.empty_item", { title })}
      onSelect={setSelectedId}
      titleOf={(item) => textValue(item.name) || title}
      onMove={async (from, to) => {
        const next = moveItem(items, from, to);
        onSettings({ ...settings, modeInjections: next as unknown as Settings["modeInjections"] });
        await api.post(reorderPath, { ids: next.map((item) => String(item.id)) });
      }}
      onCreate={async () => {
        // Eager save — same pattern as McpServerEditor.onCreate. The original code relied
        // on the 700 ms debounce, but two race conditions guaranteed the save never fired:
        //   1. The `[selectedId, items]` effect at line 4108 unconditionally reset
        //      `dirtyRef.current = false` when selectedId changed, cancelling the pending
        //      save.
        //   2. The wrapper component's `[selectedId, settings.modeInjections]` effect
        //      (e.g. line 3600) couldn't find the new id in settings and snapped
        //      selectedId back to items[0], silently overwriting the draft.
        // Saving first removes both races: by the time we touch any state, the new item
        // is already in settings, so both effects behave correctly.
        const next = createItem();
        next.name = title;
        try {
          await api.post(savePath, next);
          await pullSettings(onSettings);
          setSelectedId(String(next.id));
          setDraft(next);
          dirtyRef.current = false;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("settings:mcp.item_create_failed", { title }));
        }
      }}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{t("settings:mcp.item_detail", { title })}</div>
          <Switch
            checked={(assistant[bindKey] ?? []).includes(String(draft.id))}
            onCheckedChange={(checked) => void bind(checked)}
          />
        </div>
        <Input
          value={textValue(draft.name)}
          onChange={(event) => patchDraft({ name: event.target.value })}
          placeholder={t("settings:mcp.name_ph")}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.priority")}</span>
            <Input
              type="number"
              value={numberText(draft.priority)}
              onChange={(event) => patchDraft({ priority: Number(event.target.value) })}
              placeholder="0"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.position")}</span>
            <Select value={position} onValueChange={(value) => patchDraft({ position: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="before_system_prompt">{t("settings:mcp.pos.before")}</SelectItem>
                <SelectItem value="after_system_prompt">{t("settings:mcp.pos.after")}</SelectItem>
                <SelectItem value="top_of_chat">{t("settings:mcp.pos.top")}</SelectItem>
                <SelectItem value="bottom_of_chat">{t("settings:mcp.pos.bottom")}</SelectItem>
                <SelectItem value="at_depth">{t("settings:mcp.pos.depth")}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {usesStandaloneMessage ? (
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t("settings:mcp.role")}</span>
              <Select
                value={textValue(draft.role) || "USER"}
                onValueChange={(value) => patchDraft({ role: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">User</SelectItem>
                  <SelectItem value="ASSISTANT">Assistant</SelectItem>
                </SelectContent>
              </Select>
            </label>
          ) : null}
          {position === "at_depth" ? (
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:mcp.inject_depth_msg")}
              </span>
              <Input
                type="number"
                min={1}
                value={numberText(draft.injectDepth ?? 4)}
                onChange={(event) =>
                  patchDraft({ injectDepth: Math.max(1, Number(event.target.value) || 4) })
                }
                placeholder="4"
              />
            </label>
          ) : null}
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <span className="text-sm">{t("settings:mcp.enabled")}</span>
          <Switch
            checked={draft.enabled !== false}
            onCheckedChange={(checked) => patchDraft({ enabled: checked })}
          />
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("settings:mcp.template_vars")}</span>
            {promptVariables.map((variable) => (
              <Button
                key={variable}
                type="button"
                size="xs"
                variant="outline"
                onClick={() => appendVariable(variable)}
              >
                {variable}
              </Button>
            ))}
          </div>
          <Textarea
            value={textValue(draft.content)}
            onChange={(event) => patchDraft({ content: event.target.value })}
            className="min-h-64 font-mono text-xs leading-relaxed"
            placeholder={t("settings:mcp.inject_content_template_ph", { cur_datetime: "{{cur_datetime}}" })}
          />
        </div>
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">
            {t("settings:mcp.autosaved")}
          </div>
          <Button
            variant="destructive"
            onClick={async () => {
              await api.delete(`${deletePath}/${draft.id}`);
              await pullSettings(onSettings);
            }}
          >
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function SkillsEditor({
  settings,
  assistant,
  onSettings,
}: {
  settings: Settings;
  assistant: AssistantProfile;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const [skills, setSkills] = React.useState<SkillProfile[]>([]);
  const [selected, setSelected] = React.useState("");
  const [content, setContent] = React.useState("");
  const [files, setFiles] = React.useState<SkillFileInfo[]>([]);
  const [githubUrl, setGithubUrl] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [importingFile, setImportingFile] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const dirtyRef = React.useRef(false);

  const load = React.useCallback(async () => {
    const list = await api.get<SkillProfile[]>("skills");
    setSkills(list);
    if (!selected && list[0]) setSelected(list[0].name);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const selectedSkill = skills.find((skill) => skill.name === selected);

  React.useEffect(() => {
    if (!selected) return;
    if (!selectedSkill) {
      setFiles([]);
      return;
    }
    api
      .get<SkillProfile>(`skills/${encodeURIComponent(selected)}`)
      .then((skill) => {
        setContent(skill.content ?? "");
        dirtyRef.current = false;
      })
      .catch(() => setContent(""));
    api
      .get<{ files: SkillFileInfo[] }>(`skills/${encodeURIComponent(selected)}/files`)
      .then((result) => setFiles(result.files))
      .catch(() => setFiles([]));
  }, [selected, selectedSkill]);

  const save = React.useCallback(
    async (announce = false) => {
      if (!announce && !dirtyRef.current) return;
      const name = textValue(parseSkillName(content) || selected || "new-skill");
      setSaving(true);
      try {
        await api.post("skills/detail", { name, content });
        dirtyRef.current = false;
        await load();
        setSelected(name);
        if (announce) toast.success(t("settings:mcp.skill_saved"));
      } catch (error) {
        if (announce) toast.error(error instanceof Error ? error.message : t("settings:mcp.save_failed"));
        else console.warn("Skill auto-save failed", error);
      } finally {
        setSaving(false);
      }
    },
    [content, load, selected],
  );
  React.useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void save(false);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [content, save]);
  const remove = async () => {
    if (!selected || !window.confirm(t("settings:mcp.delete_skill_confirm"))) return;
    await api.delete(`skills/${encodeURIComponent(selected)}`);
    setSelected("");
    setContent("");
    await load();
    await pullSettings(onSettings);
  };
  const importFromGitHub = async () => {
    if (!githubUrl.trim()) return;
    setImporting(true);
    try {
      const result = await api.post<{ skill: SkillProfile }>(
        "skills/import-github",
        { repoUrl: githubUrl.trim() },
        { timeout: false },
      );
      await load();
      setSelected(result.skill.name);
      setContent(result.skill.content ?? "");
      dirtyRef.current = false;
      setGithubUrl("");
      toast.success(t("settings:mcp.skill_imported", { name: result.skill.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.import_failed"));
    } finally {
      setImporting(false);
    }
  };
  // 对齐安卓 commit af9b1f35 的 importSkillFromFile：支持从本地选择
  // .md/.zip 文件并上传到后端解析。ZIP 包内可含多个技能（每个根目录
  // 下放一份 SKILL.md），全部按原子方式导入。
  const importFromFile = async (file: File) => {
    setImportingFile(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(appendWebAuthQuery("/api/skills/import-file"), {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as {
        imported?: string[];
        skills?: SkillProfile[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || t("settings:mcp.import_failed"));
      await load();
      const first = data.skills?.[0];
      if (first) {
        setSelected(first.name);
        setContent(first.content ?? "");
        dirtyRef.current = false;
      }
      const names = (data.imported ?? []).join("、");
      toast.success(t("settings:mcp.skill_imported", { name: names || file.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:mcp.import_failed"));
    } finally {
      setImportingFile(false);
    }
  };
  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void importFromFile(file);
  };
  const toggle = async (skillName: string, checked: boolean) => {
    const ids = new Set(assistant.enabledSkills as string[] | undefined);
    if (checked) ids.add(skillName);
    else ids.delete(skillName);
    await api.post("settings/assistant/skills", {
      assistantId: assistant.id,
      enabledSkills: [...ids],
    });
    await pullSettings(onSettings);
  };

  return (
    <EditorShell
      items={skills as unknown as Array<Record<string, unknown>>}
      selectedId={selected}
      emptyLabel={t("settings:mcp.empty_skill")}
      onSelect={setSelected}
      titleOf={(item) => textValue(item.name)}
      renderItem={(item) => {
        const name = textValue(item.name);
        const enabled = (assistant.enabledSkills as string[] | undefined)?.includes(name) ?? false;
        return (
          <div className="flex min-w-0 items-center gap-2 text-left">
            <span
              className={`size-2 shrink-0 rounded-full ${enabled ? "bg-emerald-500" : "bg-red-500"}`}
            />
            <span className="block min-w-0 truncate font-medium">{name}</span>
          </div>
        );
      }}
      onCreate={() => {
        const name = "new-skill";
        setSelected(name);
        setContent(
          `---\nname: ${name}\ndescription: ${t("settings:mcp.skill_desc_default")}\n---\n\n${t("settings:mcp.skill_body_default")}\n`,
        );
        setFiles([]);
        dirtyRef.current = true;
      }}
    >
      <div className="space-y-4">
        <div className="rounded-md border p-3">
          <div className="mb-2 text-sm font-medium">{t("settings:mcp.import_github")}</div>
          <div className="flex gap-2">
            <Input
              value={githubUrl}
              onChange={(event) => setGithubUrl(event.target.value)}
              placeholder={t("settings:mcp.github_url_ph")}
              onKeyDown={(event) => {
                if (event.key === "Enter") void importFromGitHub();
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => void importFromGitHub()}
              disabled={importing || !githubUrl.trim()}
            >
              {importing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {t("settings:mcp.import_btn")}
            </Button>
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="mb-2 text-sm font-medium">{t("settings:mcp.import_file")}</div>
          <div
            className="mb-2 text-xs text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: t("settings:mcp.import_file_desc") }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.zip,application/zip"
            className="hidden"
            onChange={handleFileInputChange}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importingFile}
          >
            {importingFile ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {t("settings:mcp.select_file")}
          </Button>
        </div>
        <div className="space-y-2 rounded-md border p-3">
          {skills.map((skill) => (
            <label
              key={skill.name}
              className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/40"
            >
              <Checkbox
                className="mt-0.5"
                checked={
                  (assistant.enabledSkills as string[] | undefined)?.includes(skill.name) ?? false
                }
                onCheckedChange={(checked) => void toggle(skill.name, checked === true)}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
            </label>
          ))}
        </div>
        {selectedSkill?.description ? (
          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            {selectedSkill.description}
          </div>
        ) : null}
        <div className="rounded-md border">
          <div className="border-b px-3 py-2 text-sm font-medium">{t("settings:mcp.file_list")}</div>
          <div className="max-h-40 overflow-auto p-2">
            {files.length === 0 ? (
              <div className="p-2 text-sm text-muted-foreground">{t("settings:mcp.no_files")}</div>
            ) : null}
            {files.map((file) => (
              <div
                key={file.path}
                className="flex items-center justify-between gap-3 rounded px-2 py-1 text-xs hover:bg-muted/40"
              >
                <span className={file.type === "directory" ? "font-medium" : ""}>{file.path}</span>
                <span className="text-muted-foreground">
                  {file.type === "directory" ? t("settings:mcp.directory") : `${file.size} B`}
                </span>
              </div>
            ))}
          </div>
        </div>
        <label className="block space-y-2">
          <span className="text-sm font-medium">SKILL.md</span>
          <Textarea
            value={content}
            onChange={(event) => {
              dirtyRef.current = true;
              setContent(event.target.value);
            }}
            className="h-80 max-h-80 font-mono text-xs"
          />
        </label>
        <div className="flex justify-end gap-2">
          <div className="mr-auto flex items-center px-2 text-xs text-muted-foreground">
            {saving ? t("settings:mcp.autosaving") : t("settings:mcp.autosaved")}
          </div>
          <Button variant="destructive" onClick={() => void remove()} disabled={!selected}>
            <Trash2 className="size-4" />
            {t("settings:mcp.delete")}
          </Button>
        </div>
      </div>
    </EditorShell>
  );
}

function parseSkillName(content: string) {
  const match = content.match(/^---[\s\S]*?\nname:\s*([^\n]+)[\s\S]*?\n---/);
  return match?.[1]?.trim().replace(/^"|"$/g, "");
}

function EditorShell({
  items,
  selectedId,
  emptyLabel,
  onSelect,
  onMove,
  titleOf,
  renderItem,
  onCreate,
  children,
}: {
  items: Array<Record<string, unknown>>;
  selectedId: string;
  emptyLabel: string;
  onSelect: (id: string) => void;
  onMove?: (from: number, to: number) => void | Promise<void>;
  titleOf: (item: Record<string, unknown>) => string;
  renderItem?: (item: Record<string, unknown>) => React.ReactNode;
  onCreate: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="rounded-lg border bg-card p-3">
        <Button className="mb-3 w-full" variant="outline" onClick={onCreate}>
          <Plus className="size-4" />
          {t("settings:mcp.add_new")}
        </Button>
        <div className="space-y-1">
          {items.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {emptyLabel}
            </div>
          ) : null}
          {items.map((item, index) => (
            <SortableRow
              key={String(item.id ?? item.name)}
              id={String(item.id ?? item.name)}
              index={index}
              active={String(item.id ?? item.name) === selectedId}
              onSelect={() => onSelect(String(item.id ?? item.name))}
              onMove={onMove ? (from, to) => void onMove(from, to) : undefined}
            >
              {renderItem ? (
                renderItem(item)
              ) : (
                <div className="truncate text-left">{titleOf(item)}</div>
              )}
            </SortableRow>
          ))}
        </div>
      </div>
      <div className="rounded-lg border bg-card p-5">{children}</div>
    </div>
  );
}
