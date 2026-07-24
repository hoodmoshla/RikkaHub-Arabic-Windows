// components/settings/data.tsx — 数据备份分区（WebDAV/S3/导入导出，纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CheckCircle2,
  Database,
  Download,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Separator } from "~/components/ui/separator";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import api, { appendWebAuthQuery } from "~/services/api";
import type { Settings } from "~/types";
import { SectionHeader } from "~/components/settings/shared";

interface WebDavConfig {
  url: string;
  username: string;
  password: string;
  path: string;
  items: string[];
}

interface S3Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  pathStyle: boolean;
  items: string[];
}

interface S3BackupItem {
  href: string;
  displayName: string;
  size: number;
  lastModified: string;
}

interface WebDavBackupItem {
  href: string;
  displayName: string;
  size: number;
  lastModified: string;
}

export function DataSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const schemaInputRef = React.useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = React.useState(false);
  const [exportProgress, setExportProgress] = React.useState(0);
  const [exportedBytes, setExportedBytes] = React.useState(0);
  const [exportTotalBytes, setExportTotalBytes] = React.useState(0);
  const [importing, setImporting] = React.useState(false);
  const [importPhase, setImportPhase] = React.useState<"idle" | "uploading" | "processing">("idle");
  const [showExportDialog, setShowExportDialog] = React.useState(false);
  const [schemaStatus, setSchemaStatus] = React.useState<{
    hasAndroidSchema: boolean;
    schemaInfo: { identityHash: string; version: number } | null;
    conversationCount: number;
  } | null>(null);
  const [registeringSchema, setRegisteringSchema] = React.useState(false);
  const [schemaExpanded, setSchemaExpanded] = React.useState(false);
  const [importProgress, setImportProgress] = React.useState(0); // 0-100 during upload
  const defaultWebDav = (settings.webDavConfig ?? {
    url: "",
    username: "",
    password: "",
    path: "rikkahub_backups",
    items: ["DATABASE", "FILES"],
  }) as WebDavConfig;
  const [webDavDraft, setWebDavDraft] = React.useState<WebDavConfig>(defaultWebDav);
  const [webDavItems, setWebDavItems] = React.useState<WebDavBackupItem[]>([]);
  const [webDavBusy, setWebDavBusy] = React.useState("");
  const [webDavBackupProgress, setWebDavBackupProgress] = React.useState<{
    message: string;
    percent: number;
  } | null>(null);
  const [showWebDavPassword, setShowWebDavPassword] = React.useState(false);
  const webDavDirtyRef = React.useRef(false);

  const defaultS3 = (settings.s3Config ?? {
    endpoint: "",
    accessKeyId: "",
    secretAccessKey: "",
    bucket: "",
    region: "auto",
    pathStyle: true,
    items: ["DATABASE", "FILES"],
  }) as S3Config;
  const [s3Draft, setS3Draft] = React.useState<S3Config>(defaultS3);
  const [s3Items, setS3Items] = React.useState<S3BackupItem[]>([]);
  const [s3Busy, setS3Busy] = React.useState("");
  const [s3BackupProgress, setS3BackupProgress] = React.useState<{
    message: string;
    percent: number;
  } | null>(null);
  const [showS3Secret, setShowS3Secret] = React.useState(false);
  const s3DirtyRef = React.useRef(false);

  React.useEffect(() => {
    setWebDavDraft(defaultWebDav);
    webDavDirtyRef.current = false;
  }, [
    defaultWebDav.url,
    defaultWebDav.username,
    defaultWebDav.password,
    defaultWebDav.path,
    JSON.stringify(defaultWebDav.items ?? []),
  ]);

  React.useEffect(() => {
    fetch(appendWebAuthQuery("/api/data/export/status"))
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s) setSchemaStatus(s);
      })
      .catch(() => {});
  }, []);

  const consumeBackupSse = async (
    url: string,
    onProgress: (message: string, percent: number) => void,
    body?: string,
  ) => {
    const response = await fetch(appendWebAuthQuery(url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: body ?? undefined,
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n+/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const eventName =
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
        if (eventName === "progress") {
          onProgress(String(data.message ?? ""), Number(data.percent ?? 0));
        } else if (eventName === "done") {
          return data;
        } else if (eventName === "error") {
          throw new Error(String(data.error ?? t("settings:data.op_failed")));
        }
      }
    }
    throw new Error(t("settings:data.conn_closed"));
  };

  const patchWebDav = (patch: Partial<WebDavConfig>) => {
    webDavDirtyRef.current = true;
    setWebDavDraft({ ...webDavDraft, ...patch });
  };

  const saveWebDav = React.useCallback(
    async (announce = false) => {
      if (!announce && !webDavDirtyRef.current) return;
      const result = await api.post<{ config: WebDavConfig }>("data/webdav/config", webDavDraft);
      webDavDirtyRef.current = false;
      onSettings({ ...settings, webDavConfig: result.config } as Settings);
      if (announce) toast.success(t("settings:data.webdav_saved"));
    },
    [onSettings, settings, webDavDraft, t],
  );

  React.useEffect(() => {
    if (!webDavDirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void saveWebDav(false).catch((error: Error) =>
        toast.error(error.message || t("settings:data.webdav_autosave_failed")),
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [saveWebDav, webDavDraft, t]);

  const refreshWebDavList = async () => {
    setWebDavBusy("list");
    try {
      await saveWebDav(false);
      const result = await api.get<{ items: WebDavBackupItem[] }>("data/webdav/list", {
        timeout: false,
      });
      setWebDavItems(result.items);
    } finally {
      setWebDavBusy("");
    }
  };

  const testWebDav = async () => {
    setWebDavBusy("test");
    try {
      await saveWebDav(false);
      await api.post("data/webdav/test", { config: webDavDraft }, { timeout: false });
      toast.success(t("settings:data.webdav_conn_ok"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.webdav_conn_failed"));
    } finally {
      setWebDavBusy("");
    }
  };

  const warnIfNoSchema = async () => {
    try {
      const res = await fetch(appendWebAuthQuery("/api/data/export/status"));
      if (res.ok) {
        const s = await res.json();
        if (!s.hasAndroidSchema && s.conversationCount > 0) {
          toast(t("settings:data.no_schema_warn"), { duration: 6000 });
        }
      }
    } catch {
      /* */
    }
  };

  const backupWebDav = async () => {
    await warnIfNoSchema();
    setWebDavBusy("backup");
    setWebDavBackupProgress({ message: t("settings:data.preparing"), percent: 0 });
    try {
      await saveWebDav(false);
      const data = await consumeBackupSse("/api/data/webdav/backup/stream", (message, percent) => {
        setWebDavBackupProgress({ message, percent });
      });
      if (Array.isArray(data.items)) setWebDavItems(data.items as WebDavBackupItem[]);
      toast.success(t("settings:data.webdav_backup_done"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.webdav_backup_failed"));
    } finally {
      setWebDavBusy("");
      setWebDavBackupProgress(null);
    }
  };

  const restoreWebDav = async (item: WebDavBackupItem) => {
    if (!window.confirm(t("settings:data.restore_confirm", { name: item.displayName }))) return;
    setWebDavBusy(`restore:${item.displayName}`);
    setWebDavBackupProgress({ message: t("settings:data.preparing"), percent: 0 });
    try {
      const data = await consumeBackupSse(
        "/api/data/webdav/restore/stream",
        (message, percent) => {
          setWebDavBackupProgress({ message, percent });
        },
        JSON.stringify({ fileName: item.displayName }),
      );
      if (data.settings) onSettings(data.settings as Settings);
      toast.success(t("settings:data.webdav_restored"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("settings:data.webdav_restore_failed"),
      );
    } finally {
      setWebDavBusy("");
      setWebDavBackupProgress(null);
    }
  };

  const deleteWebDav = async (item: WebDavBackupItem) => {
    if (!window.confirm(t("settings:data.delete_confirm", { name: item.displayName }))) return;
    setWebDavBusy(`delete:${item.displayName}`);
    try {
      const result = await api.post<{ items: WebDavBackupItem[] }>(
        "data/webdav/delete",
        { fileName: item.displayName },
        { timeout: false },
      );
      setWebDavItems(result.items);
      toast.success(t("settings:data.webdav_deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.webdav_delete_failed"));
    } finally {
      setWebDavBusy("");
    }
  };

  React.useEffect(() => {
    setS3Draft(defaultS3);
    s3DirtyRef.current = false;
  }, [
    defaultS3.endpoint,
    defaultS3.region,
    defaultS3.accessKeyId,
    defaultS3.secretAccessKey,
    defaultS3.bucket,
    defaultS3.pathStyle,
    JSON.stringify(defaultS3.items ?? []),
  ]);

  const patchS3 = (patch: Partial<S3Config>) => {
    s3DirtyRef.current = true;
    setS3Draft({ ...s3Draft, ...patch });
  };
  const saveS3 = React.useCallback(
    async (announce = false) => {
      if (!announce && !s3DirtyRef.current) return;
      const result = await api.post<{ config: S3Config }>("data/s3/config", s3Draft);
      s3DirtyRef.current = false;
      onSettings({ ...settings, s3Config: result.config } as Settings);
      if (announce) toast.success(t("settings:data.s3_saved"));
    },
    [onSettings, settings, s3Draft, t],
  );
  React.useEffect(() => {
    if (!s3DirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void saveS3(false).catch((error: Error) =>
        toast.error(error.message || t("settings:data.s3_autosave_failed")),
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [saveS3, s3Draft, t]);
  const refreshS3List = async () => {
    setS3Busy("list");
    try {
      await saveS3(false);
      const result = await api.get<{ items: S3BackupItem[] }>("data/s3/list", { timeout: false });
      setS3Items(result.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_list_failed"));
    } finally {
      setS3Busy("");
    }
  };
  const testS3 = async () => {
    setS3Busy("test");
    try {
      await saveS3(false);
      await api.post("data/s3/test", { config: s3Draft }, { timeout: false });
      toast.success(t("settings:data.s3_conn_ok"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_conn_failed"));
    } finally {
      setS3Busy("");
    }
  };
  const backupS3 = async () => {
    await warnIfNoSchema();
    setS3Busy("backup");
    setS3BackupProgress({ message: t("settings:data.preparing"), percent: 0 });
    try {
      await saveS3(false);
      const data = await consumeBackupSse("/api/data/s3/backup/stream", (message, percent) => {
        setS3BackupProgress({ message, percent });
      });
      if (Array.isArray(data.items)) setS3Items(data.items as S3BackupItem[]);
      toast.success(t("settings:data.s3_backup_done"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_backup_failed"));
    } finally {
      setS3Busy("");
      setS3BackupProgress(null);
    }
  };
  const restoreS3 = async (item: S3BackupItem) => {
    if (!window.confirm(t("settings:data.s3_restore_confirm", { name: item.displayName }))) return;
    setS3Busy(`restore:${item.displayName}`);
    setS3BackupProgress({ message: t("settings:data.preparing"), percent: 0 });
    try {
      const data = await consumeBackupSse(
        "/api/data/s3/restore/stream",
        (message, percent) => {
          setS3BackupProgress({ message, percent });
        },
        JSON.stringify({ fileName: item.displayName }),
      );
      if (data.settings) onSettings(data.settings as Settings);
      toast.success(t("settings:data.s3_restored"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_restore_failed"));
    } finally {
      setS3Busy("");
      setS3BackupProgress(null);
    }
  };
  const deleteS3 = async (item: S3BackupItem) => {
    if (!window.confirm(t("settings:data.delete_confirm", { name: item.displayName }))) return;
    setS3Busy(`delete:${item.displayName}`);
    try {
      const result = await api.post<{ items: S3BackupItem[] }>(
        "data/s3/delete",
        { fileName: item.displayName },
        { timeout: false },
      );
      setS3Items(result.items);
      toast.success(t("settings:data.s3_deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.s3_delete_failed"));
    } finally {
      setS3Busy("");
    }
  };

  const handleExportClick = async () => {
    try {
      const res = await fetch(appendWebAuthQuery("/api/data/export/status"));
      if (res.ok) setSchemaStatus(await res.json());
    } catch {
      /* */
    }
    setShowExportDialog(true);
  };

  const handleRegisterSchema = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setRegisteringSchema(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(appendWebAuthQuery("/api/data/register-schema"), {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("settings:data.register_failed"));
      setSchemaStatus((prev) =>
        prev
          ? { ...prev, hasAndroidSchema: true, schemaInfo: data.schemaInfo }
          : { hasAndroidSchema: true, schemaInfo: data.schemaInfo, conversationCount: 0 },
      );
      toast.success(
        t("settings:data.register_ok", {
          version: data.schemaInfo.version,
          hash: data.schemaInfo.identityHash.slice(0, 8),
        }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings:data.register_failed"));
    } finally {
      setRegisteringSchema(false);
    }
  };

  const doExport = async () => {
    setShowExportDialog(false);
    setExporting(true);
    setExportProgress(0);
    setExportedBytes(0);
    setExportTotalBytes(0);
    const prepToast = toast.loading(t("settings:data.export_preparing"));
    try {
      // Download the zip via XHR so we can read onprogress (loaded / total) and surface a
      // progress bar — Bun's response carries a Content-Length so the browser knows the
      // total up front. ky/fetch don't expose download progress without a custom
      // ReadableStream consumer; XHR is simpler and well-supported by Tauri's webview.
      const result: { blob: Blob; fileName: string } = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", appendWebAuthQuery("/api/data/export"));
        xhr.responseType = "blob";
        xhr.onprogress = (ev) => {
          if (ev.lengthComputable && ev.total > 0) {
            setExportTotalBytes(ev.total);
            setExportedBytes(ev.loaded);
            setExportProgress(Math.round((ev.loaded / ev.total) * 100));
          } else {
            // Server didn't send Content-Length (shouldn't happen with our endpoint, but be
            // defensive). At least bump the byte counter so the user sees something moving.
            setExportedBytes(ev.loaded);
          }
        };
        xhr.onerror = () => reject(new Error(t("settings:data.export_network_error")));
        xhr.onabort = () => reject(new Error(t("settings:data.export_cancelled")));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            // X-Export-Filename is set by the server with the canonical zip filename, so we
            // don't have to recompute the timestamp on the client (and risk it drifting).
            const headerName = xhr.getResponseHeader("X-Export-Filename") || "";
            const fallback = `rikkahub-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
            resolve({ blob: xhr.response as Blob, fileName: headerName || fallback });
          } else {
            reject(new Error(t("settings:data.export_http_error", { status: xhr.status })));
          }
        };
        xhr.send();
      });

      // Hand off the blob to a hidden <a download> click; the browser writes it to its
      // default Downloads folder. We can't get the real filesystem path back from the
      // browser API, but we tell the user the filename and where to look.
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toast.dismiss(prepToast);
      // Long-lived success toast so the user has time to read the filename before it dismisses.
      // 8s is enough to copy the name into a file manager search box if they want.
      toast.success(t("settings:data.export_done", { name: result.fileName }), { duration: 8000 });
    } catch (error) {
      toast.dismiss(prepToast);
      toast.error(error instanceof Error ? error.message : t("settings:data.export_failed"));
    } finally {
      setExporting(false);
      setExportProgress(0);
      setExportedBytes(0);
      setExportTotalBytes(0);
    }
  };

  const importData = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!window.confirm(t("settings:data.import_confirm"))) return;

    setImporting(true);
    setImportPhase("uploading");
    setImportProgress(0);
    try {
      // Stream the file body directly to /api/data/import as application/octet-stream rather
      // than wrap it in multipart/form-data. Two reasons:
      //   1. Users have reported 10+ GB backups. `Buffer.from(await file.arrayBuffer())` on
      //      the server doubles JS heap memory; with streaming, the server writes chunks
      //      straight to disk and never holds the full body in memory.
      //   2. fetch() can't report upload progress. XMLHttpRequest can. We need the progress
      //      bar so the user doesn't think the app froze during a multi-GB upload.
      // The backend's data/import endpoint detects octet-stream via Content-Type and routes
      // to the streaming path; multipart still works as a fallback.
      const result = await new Promise<{
        status: string;
        source?: string;
        summary?: string[];
        settings: Settings;
      }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        // Auth token goes via the query-string helper since XHR doesn't run through the
        // ky beforeRequest hook that would otherwise inject the Authorization header.
        xhr.open("POST", appendWebAuthQuery("/api/data/import"));
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        // X-Filename lets the server log the original name (useful for triage); the magic
        // bytes still determine format. Filename is URI-encoded so non-ASCII names survive.
        xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setImportProgress(pct);
          }
        };
        xhr.upload.onload = () => {
          // Upload finished, but server is still processing — switch phase so the UI shows
          // the indeterminate "processing" hint instead of stuck-at-100% progress bar.
          setImportPhase("processing");
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (err) {
              reject(new Error("Invalid server response"));
            }
          } else {
            // Try to surface the server-side error message rather than the raw status code.
            let serverError = `HTTP ${xhr.status}`;
            try {
              const parsed = JSON.parse(xhr.responseText) as { error?: string };
              if (parsed.error) serverError = parsed.error;
            } catch {
              /* keep status code */
            }
            reject(new Error(serverError));
          }
        };
        xhr.onerror = () => reject(new Error(t("settings:data.import_network_error")));
        xhr.onabort = () => reject(new Error(t("settings:data.import_cancelled")));
        // No timeout — large backups may take 10+ minutes through upload + extract + SQLite.
        xhr.timeout = 0;
        xhr.send(file);
      });
      onSettings(result.settings);
      if (result.source === "android-zip") {
        const lines = (result.summary ?? []).filter(Boolean);
        toast.success(
          lines.length
            ? t("settings:data.import_android_lines", { lines: lines.join("；") })
            : t("settings:data.import_android"),
        );
      } else {
        toast.success(t("settings:data.import_done"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.import_failed"));
    } finally {
      setImporting(false);
      setImportPhase("idle");
      setImportProgress(0);
    }
  };

  return (
    <>
      {showExportDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowExportDialog(false)}
        >
          <div
            className="mx-4 max-w-md rounded-lg bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold">{t("settings:data.export_confirm_title")}</h3>
            <div className="mt-3 text-sm text-muted-foreground">
              {schemaStatus?.hasAndroidSchema
                ? t("settings:data.export_with_schema", { count: schemaStatus.conversationCount })
                : t("settings:data.export_without_schema")}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowExportDialog(false)}>
                {t("settings:data.cancel")}
              </Button>
              <Button onClick={() => void doExport()}>
                <Download className="mr-1 size-4" />
                {schemaStatus?.hasAndroidSchema
                  ? t("settings:data.confirm_export")
                  : t("settings:data.export_no_chat")}
              </Button>
            </div>
          </div>
        </div>
      )}
      <SectionHeader
        icon={Database}
        title={t("settings:data.title")}
        subtitle={t("settings:data.subtitle")}
      />
      <div className="mb-4 rounded-lg border p-4">
        <div
          className="flex items-center gap-2 cursor-pointer"
          onClick={() => schemaStatus?.hasAndroidSchema && setSchemaExpanded(!schemaExpanded)}
        >
          <div className="text-sm font-medium">{t("settings:data.android_compat")}</div>
          {schemaStatus?.hasAndroidSchema ? (
            <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-900 dark:text-green-300">
              {t("settings:data.ready")}
            </span>
          ) : (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              {t("settings:data.unregistered")}
            </span>
          )}
          {schemaStatus?.hasAndroidSchema && (
            <span className="ml-auto text-xs text-muted-foreground">
              {schemaExpanded ? t("settings:data.collapse") : t("settings:data.expand")}
            </span>
          )}
        </div>
        {schemaStatus?.hasAndroidSchema && !schemaExpanded && (
          <div className="mt-2 text-xs text-muted-foreground">
            {t("settings:data.compat_summary", {
              version: schemaStatus.schemaInfo?.version,
              hash: schemaStatus.schemaInfo?.identityHash.slice(0, 8),
            })}
          </div>
        )}
        {(!schemaStatus?.hasAndroidSchema || schemaExpanded) && (
          <div className="mt-2 space-y-2">
            {!schemaStatus?.hasAndroidSchema && (
              <div
                className="text-xs text-muted-foreground"
                dangerouslySetInnerHTML={{ __html: t("settings:data.unregistered_warn") }}
              />
            )}
            {schemaStatus?.hasAndroidSchema && (
              <div className="text-xs text-muted-foreground">
                {t("settings:data.current_format", {
                  version: schemaStatus.schemaInfo?.version,
                  hash: schemaStatus.schemaInfo?.identityHash.slice(0, 8),
                })}
              </div>
            )}
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <div className="text-xs font-medium">
                {schemaStatus?.hasAndroidSchema
                  ? t("settings:data.update_format")
                  : t("settings:data.how_to_register")}
              </div>
              <ol className="mt-1.5 list-inside list-decimal space-y-1 text-xs text-muted-foreground">
                <li>{t("settings:data.step1")}</li>
                <li>{t("settings:data.step2")}</li>
                <li>{t("settings:data.step3")}</li>
              </ol>
              <div className="mt-2 text-xs font-bold text-amber-700 dark:text-amber-300">
                {t("settings:data.register_note")}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => schemaInputRef.current?.click()}
                disabled={registeringSchema}
              >
                {registeringSchema ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : (
                  <Upload className="mr-1 size-3" />
                )}
                {t("settings:data.upload_phone_backup")}
              </Button>
              <input
                ref={schemaInputRef}
                className="sr-only"
                type="file"
                accept="application/zip,.zip"
                onChange={(e) => void handleRegisterSchema(e)}
              />
            </div>
          </div>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">{t("settings:data.backup_title")}</div>
          <div className="mt-1 text-xs text-muted-foreground">{t("settings:data.backup_desc")}</div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void handleExportClick()}
              disabled={exporting || importing}
            >
              {exporting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {t("settings:data.export_backup")}
            </Button>
            <Button
              variant="outline"
              onClick={() => importInputRef.current?.click()}
              disabled={importing || exporting}
            >
              {importing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {t("settings:data.import_backup")}
            </Button>
            <input
              ref={importInputRef}
              className="sr-only"
              type="file"
              accept="application/json,.json,application/zip,.zip"
              onChange={(event) => void importData(event)}
            />
          </div>
          {exporting ? (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {exportTotalBytes > 0
                    ? t("settings:data.downloading")
                    : t("settings:data.preparing_file")}
                </span>
                {exportTotalBytes > 0 ? (
                  <span>
                    {(exportedBytes / (1024 * 1024)).toFixed(1)} /{" "}
                    {(exportTotalBytes / (1024 * 1024)).toFixed(1)} MB · {exportProgress}%
                  </span>
                ) : null}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full bg-primary transition-all",
                    exportTotalBytes === 0 && "animate-pulse w-full",
                  )}
                  style={exportTotalBytes > 0 ? { width: `${exportProgress}%` } : undefined}
                />
              </div>
              {exportTotalBytes === 0 ? (
                <div className="text-[0.6875rem] text-muted-foreground">
                  {t("settings:data.pack_slow")}
                </div>
              ) : null}
            </div>
          ) : null}
          {importing ? (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {importPhase === "uploading" && t("settings:data.uploading")}
                  {importPhase === "processing" && t("settings:data.extracting")}
                  {importPhase === "idle" && t("settings:data.preparing")}
                </span>
                {importPhase === "uploading" ? <span>{importProgress}%</span> : null}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full bg-primary transition-all",
                    importPhase === "processing" && "animate-pulse w-full",
                  )}
                  style={importPhase === "uploading" ? { width: `${importProgress}%` } : undefined}
                />
              </div>
              {importPhase === "processing" ? (
                <div className="text-[0.6875rem] text-muted-foreground">
                  {t("settings:data.extract_slow")}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">{t("settings:data.chat_files_title")}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings:data.chat_files_desc")}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm font-medium">{t("settings:data.web_service_title")}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t("settings:data.web_service_desc", {
              status: settings.webServerJwtEnabled
                ? t("settings:data.enabled")
                : t("settings:data.disabled"),
            })}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 md:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                {t("settings:data.webdav_title")}
                {!schemaStatus?.hasAndroidSchema && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[0.625rem] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                    {t("settings:data.chat_unsyncable")}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t("settings:data.webdav_desc")}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {webDavBusy ? t("settings:data.processing") : t("settings:common.autosaved")}
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:data.server_url")}
              </span>
              <Input
                value={webDavDraft.url}
                onChange={(event) => patchWebDav({ url: event.target.value })}
                placeholder="https://example.com/dav"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:data.backup_path")}
              </span>
              <Input
                value={webDavDraft.path}
                onChange={(event) => patchWebDav({ path: event.target.value })}
                placeholder="rikkahub_backups"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:proxy.username")}
              </span>
              <Input
                value={webDavDraft.username}
                onChange={(event) => patchWebDav({ username: event.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:proxy.password")}
              </span>
              <div className="flex gap-2">
                <Input
                  type={showWebDavPassword ? "text" : "password"}
                  value={webDavDraft.password}
                  onChange={(event) => patchWebDav({ password: event.target.value })}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowWebDavPassword((value) => !value)}
                >
                  {showWebDavPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["DATABASE", "FILES"] as const).map((item) => (
              <label
                key={item}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <Checkbox
                  checked={(webDavDraft.items ?? []).includes(item)}
                  onCheckedChange={(checked) => {
                    const items = new Set(webDavDraft.items ?? []);
                    if (checked) items.add(item);
                    else items.delete(item);
                    patchWebDav({ items: [...items] });
                  }}
                />
                {item === "DATABASE"
                  ? t("settings:data.item_database")
                  : t("settings:data.item_files")}
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void testWebDav()}
              disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}
            >
              {webDavBusy === "test" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              {t("settings:data.test_conn")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void refreshWebDavList()}
              disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}
            >
              {webDavBusy === "list" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {t("settings:data.refresh_backups")}
            </Button>
            <Button
              onClick={() => void backupWebDav()}
              disabled={Boolean(webDavBusy) || !webDavDraft.url.trim()}
            >
              {webDavBusy === "backup" && !webDavBackupProgress ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {t("settings:data.backup_now")}
            </Button>
          </div>
          {(webDavBusy === "backup" || webDavBusy.startsWith("restore:")) &&
          webDavBackupProgress ? (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{webDavBackupProgress.message}</span>
                {webDavBackupProgress.percent > 0 ? (
                  <span>{webDavBackupProgress.percent}%</span>
                ) : null}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full bg-primary transition-all",
                    webDavBackupProgress.percent === 0 && "animate-pulse w-full",
                  )}
                  style={
                    webDavBackupProgress.percent > 0
                      ? { width: `${webDavBackupProgress.percent}%` }
                      : undefined
                  }
                />
              </div>
            </div>
          ) : null}
          <div className="mt-4 rounded-md border">
            {webDavItems.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                {t("settings:data.no_remote_backups")}
              </div>
            ) : null}
            {webDavItems.map((item, index) => (
              <React.Fragment key={item.displayName}>
                {index > 0 ? <Separator /> : null}
                <div className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{item.displayName}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(item.lastModified || 0).toLocaleString()} ·{" "}
                      {Math.round((item.size || 0) / 1024)} KB
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void restoreWebDav(item)}
                      disabled={Boolean(webDavBusy)}
                    >
                      {webDavBusy === `restore:${item.displayName}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      {t("settings:data.restore")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void deleteWebDav(item)}
                      disabled={Boolean(webDavBusy)}
                    >
                      {webDavBusy === `delete:${item.displayName}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                {t("settings:data.s3_title")}
                {!schemaStatus?.hasAndroidSchema && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[0.625rem] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                    {t("settings:data.chat_unsyncable")}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{t("settings:data.s3_desc")}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Path-style</span>
              <Switch
                checked={s3Draft.pathStyle}
                onCheckedChange={(pathStyle) => patchS3({ pathStyle })}
              />
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t("settings:data.endpoint_label")}
              </span>
              <Input
                value={s3Draft.endpoint}
                onChange={(event) => patchS3({ endpoint: event.target.value })}
                placeholder="https://s3.example.com"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Region</span>
              <Input
                value={s3Draft.region}
                onChange={(event) => patchS3({ region: event.target.value })}
                placeholder="auto"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Bucket</span>
              <Input
                value={s3Draft.bucket}
                onChange={(event) => patchS3({ bucket: event.target.value })}
                placeholder="my-rikkahub-bucket"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Access Key ID</span>
              <Input
                value={s3Draft.accessKeyId}
                onChange={(event) => patchS3({ accessKeyId: event.target.value })}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Secret Access Key</span>
              <div className="flex gap-2">
                <Input
                  type={showS3Secret ? "text" : "password"}
                  value={s3Draft.secretAccessKey}
                  onChange={(event) => patchS3({ secretAccessKey: event.target.value })}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowS3Secret((value) => !value)}
                >
                  {showS3Secret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void testS3()}
              disabled={Boolean(s3Busy) || !s3Draft.bucket.trim() || !s3Draft.accessKeyId.trim()}
            >
              {s3Busy === "test" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              {t("settings:data.test_conn")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void refreshS3List()}
              disabled={Boolean(s3Busy) || !s3Draft.bucket.trim()}
            >
              {s3Busy === "list" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {t("settings:data.refresh_backups")}
            </Button>
            <Button
              onClick={() => void backupS3()}
              disabled={Boolean(s3Busy) || !s3Draft.bucket.trim() || !s3Draft.accessKeyId.trim()}
            >
              {s3Busy === "backup" && !s3BackupProgress ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {t("settings:data.backup_now")}
            </Button>
          </div>
          {(s3Busy === "backup" || s3Busy.startsWith("restore:")) && s3BackupProgress ? (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{s3BackupProgress.message}</span>
                {s3BackupProgress.percent > 0 ? <span>{s3BackupProgress.percent}%</span> : null}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full bg-primary transition-all",
                    s3BackupProgress.percent === 0 && "animate-pulse w-full",
                  )}
                  style={
                    s3BackupProgress.percent > 0
                      ? { width: `${s3BackupProgress.percent}%` }
                      : undefined
                  }
                />
              </div>
            </div>
          ) : null}
          <div className="mt-3 overflow-hidden rounded-md border">
            {s3Items.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                {t("settings:data.no_remote_backups_s3")}
              </div>
            ) : null}
            {s3Items.map((item, index) => (
              <React.Fragment key={item.displayName}>
                {index > 0 ? <Separator /> : null}
                <div className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{item.displayName}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(item.lastModified || 0).toLocaleString()} ·{" "}
                      {Math.round((item.size || 0) / 1024)} KB
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void restoreS3(item)}
                      disabled={Boolean(s3Busy)}
                    >
                      {s3Busy === `restore:${item.displayName}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      {t("settings:data.restore")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void deleteS3(item)}
                      disabled={Boolean(s3Busy)}
                    >
                      {s3Busy === `delete:${item.displayName}` ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
