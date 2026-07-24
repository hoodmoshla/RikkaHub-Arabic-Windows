// backup/import.ts — 备份导入（PC json/zip 与 Android zip，含 Android 会话/文件/记忆导入）
// 纪律：Android 互导契约（FTS5 影子表排除、MemoryEntity、settings 合并、迁移常量）冻结，只准原样搬迁。
// 部分辅助暂经 ../server 导入，3.5 拆 api/ 时收敛。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { AssistantMemory, Conversation, JsonValue, Message, MessageNode, MessagePart, State, StoredFile } from "../foundation/types";
import { guessMimeFromExt, isRecord, mergeById } from "../foundation/utils";
import { dataDir, filesDir, skillsDir } from "../foundation/paths";
import { tempDir } from "../foundation/platform";
import { MEMORY_FILE_SPLIT_MIGRATION, saveState, setState, state } from "../persistence/json-store";
import { GLOBAL_MEMORY_ID, memoryStore } from "../memory/index";
import { clearConvDirtyState, DEFAULT_ASSISTANT_ID, resetConversationsDbTo } from "../conversations";
import { importSkills } from "../tools";
import { ANDROID_AVATAR_TYPE_TO_PC, copyDirRecursive, rewriteAvatarsInSettings } from "./export";
import { broadcastList, broadcastSettings } from "../api/sse";
import { defaultSettings } from "../app-config/defaults";
import { normalizeState } from "../persistence/state-load";
import { generating } from "../conversations/generation-state";

// —— N-5 custom_js 导入告警 —————————————————————————————————————————————
// custom_js 搜索服务的 searchScript/scrapeScript 会在本机进程内执行（search/index.ts 的
// runCustomJsFunction，AsyncFunction 无沙箱）。脚本本是用户自配，但设置随备份导入导出，
// 恶意备份 zip/json 是现实的社工攻击路径。策略：导入前对现有脚本做签名快照，导入后只对
// "新增或脚本内容变化"的服务告警——用户自己配置过且未变的服务不重复提示，避免告警疲劳。
export function customJsScriptSignatures(settings: unknown): Map<string, string> {
  const signatures = new Map<string, string>();
  if (!isRecord(settings) || !Array.isArray(settings.searchServices)) return signatures;
  for (const service of settings.searchServices) {
    if (!isRecord(service) || String(service.type ?? "") !== "custom_js") continue;
    const searchScript = String(service.searchScript ?? "").trim();
    const scrapeScript = String(service.scrapeScript ?? "").trim();
    if (!searchScript && !scrapeScript) continue;
    signatures.set(String(service.id ?? ""), String(Bun.hash(`${searchScript}\u0000${scrapeScript}`)));
  }
  return signatures;
}

export function customJsImportWarning(beforeSignatures: Map<string, string>, settingsAfter: unknown): string | null {
  const afterSignatures = customJsScriptSignatures(settingsAfter);
  if (afterSignatures.size === 0 || !isRecord(settingsAfter) || !Array.isArray(settingsAfter.searchServices)) return null;
  const names: string[] = [];
  for (const service of settingsAfter.searchServices) {
    if (!isRecord(service)) continue;
    const id = String(service.id ?? "");
    const signature = afterSignatures.get(id);
    if (!signature || beforeSignatures.get(id) === signature) continue;
    names.push(String(service.name ?? "custom_js"));
  }
  if (names.length === 0) return null;
  return `安全提醒：本次导入包含 ${names.length} 个自定义 JS 搜索脚本（${names.join("、")}）。这类脚本会在本机执行，请确认备份来源可信；如不确定，请到 设置 → 搜索 中检查或删除对应服务。`;
}

export function applyBackupPayload(body: { state?: Partial<State>; skills?: unknown; files?: unknown } & Partial<State>) {
  const incoming = body.state ?? body;
  if (!incoming || typeof incoming !== "object" || !incoming.settings) {
    throw new Error("Invalid backup file");
  }
  setState(normalizeState(incoming));
  // 记忆:整体替换语义(恢复备份 = 回到备份时的状态)。normalizeState 已把 incoming.memories
  // 解析到 state.memories;交给 memoryStore 接管(replace:先清空再导入),然后从 state 移除。
  // pending 一并清空(备份不含 pending,恢复即丢弃待确认队列——前端应在恢复前弹警告)。
  const incomingMemories = Array.isArray(state.memories) ? state.memories : [];
  memoryStore.importFlatMemories(incomingMemories, "replace");
  delete state.memories;
  delete state.nextMemoryId;
  // 迁移标记:pc-backup.json 不导出 appliedMigrations,normalizeState 后丢失。记忆已由
  // memoryStore 接管,强制补 memory-file-split 标记,避免下次启动误迁移(S2 会兜底,但显式更干净)。
  if (!Array.isArray(state.appliedMigrations)) state.appliedMigrations = [];
  if (!state.appliedMigrations.includes(MEMORY_FILE_SPLIT_MIGRATION)) {
    state.appliedMigrations = [...state.appliedMigrations, MEMORY_FILE_SPLIT_MIGRATION];
  }
  importSkills(body.skills);
  if (Array.isArray(body.files)) {
    mkdirSync(filesDir, { recursive: true });
    for (const file of body.files) {
      if (!isRecord(file) || typeof file.data !== "string") continue;
      const fileId = Number(file.id);
      if (!Number.isFinite(fileId)) continue;
      const ext = extname(String(file.originalName ?? file.name ?? "")) || extname(String(file.path ?? "")) || "";
      const target = join(filesDir, `${fileId}${ext}`);
      writeFileSync(target, Buffer.from(file.data, "base64"));
      state.files = state.files.map((entry) => (entry.id === fileId ? { ...entry, path: target } : entry));
    }
  }
  finalizeConversationImport();
  saveState();
  broadcastSettings();
  broadcastList();
}

/**
 * Try to import an Android-format backup ZIP. The Android client (v2.x) produces a ZIP
 * containing `settings.json` + Room database files + `upload/` + `skills/`. PC and Android
 * use different storage layouts (PC: JSON state.json; Android: SQLite via Room), so we can't
 * literally restore the .db files. Instead we cherry-pick the cross-platform-portable bits:
 *
 *   ✓ settings.json → merged into PC settings (providers, search services, assistants,
 *     mode injections, lorebooks, quick messages, display preferences, etc.)
 *   ✓ upload/<file> → copied verbatim into pc-data/files/ and registered in state.files[]
 *     so they're available as attachments by their old filenames
 *   ✓ skills/<...> → copied into pc-data/skills/ so Agent Skills survive the migration
 *   ✗ rikka_hub.db / -wal / -shm → SKIPPED. Reading Room SQLite would require duplicating
 *     Android's schema mapping; conversation history therefore doesn't migrate. The summary
 *     returned to the UI lists what was and wasn't recovered so the user understands.
 *
 * Uses PowerShell's Expand-Archive (ships on every supported Windows) to extract — no
 * extra dependency in the compiled exe.
 */
// PC lossless restore: read `pc-backup.json` (metadata-only state), apply it via
// `applyBackupPayload`, then re-link the actual file bytes from the zip's `upload/<fileName>`
// entries by copying them into pc-data/files/<newId>.<ext> and rewriting state.files[].path.
//
// This preserves conversations + message tree + tool parts + generatedImages + logs that a
// pure-Android-format zip can't carry (Android stores those in SQLite, which PC doesn't have).
// Out-of-memory safety: file bytes are copied with readFileSync→writeFileSync per file, never
// aggregated into a single buffer.
function applyPcBackupFromExtractDir(extractDir: string, pcBackupPath: string): { settingsImported: boolean; filesImported: number; skillsImported: number; conversationsImported: number; dbReadError: string | null } {
  let settingsImported = false;
  let filesImported = 0;
  let skillsImported = 0;
  let conversationsImported = 0;
  try {
    const body = JSON.parse(readFileSync(pcBackupPath, "utf-8")) as { state?: Partial<State>; skills?: unknown; files?: unknown } & Partial<State>;
    const incoming = body.state ?? body;
    if (!incoming || typeof incoming !== "object" || !incoming.settings) {
      throw new Error("Invalid pc-backup.json: missing state.settings");
    }
    // Wipe state.files first so we can re-add entries from upload/ with fresh IDs and paths
    // that are valid on THIS machine (the path stored in pc-backup.json points at the source
    // machine's filesystem and would be wrong here).
    const incomingState = { ...(incoming as State), files: [], nextFileId: 1 } as State;
    setState(normalizeState(incomingState));
    // 记忆:整体替换语义(PC 备份恢复)。normalizeState 把 incomingState.memories 解析到
    // state.memories;交给 memoryStore 接管(replace),然后从 state 移除。
    const incomingMemories = Array.isArray(state.memories) ? state.memories : [];
    memoryStore.importFlatMemories(incomingMemories, "replace");
    delete state.memories;
    delete state.nextMemoryId;
    // 迁移标记:pc-backup.json 不导出 appliedMigrations,normalizeState 后丢失。强制补
    // memory-file-split,避免下次启动误迁移(S2 会兜底,但显式更干净)。
    if (!Array.isArray(state.appliedMigrations)) state.appliedMigrations = [];
    if (!state.appliedMigrations.includes(MEMORY_FILE_SPLIT_MIGRATION)) {
      state.appliedMigrations = [...state.appliedMigrations, MEMORY_FILE_SPLIT_MIGRATION];
    }
    settingsImported = true;
    if (Array.isArray(incoming.conversations)) {
      conversationsImported = incoming.conversations.length;
    }
    // If pc-backup.json doesn't contain conversations (new format), try rikka_hub.db
    if (!conversationsImported) {
      const dbFile = join(extractDir, "rikka_hub.db");
      if (existsSync(dbFile)) {
        try {
          conversationsImported = importAndroidConversations(extractDir, dbFile, new Map());
        } catch (dbErr) {
          console.warn("[import] rikka_hub.db read failed in PC restore:", dbErr);
        }
      }
    }
    importSkills((body as { skills?: unknown }).skills);
    // Re-link file bytes from upload/<fileName>. We trust the metadata in pc-backup.json's
    // files[] array for mime/extractedText etc., but assign new local ids and paths.
    const uploadDir = join(extractDir, "upload");
    const incomingFiles = Array.isArray((incoming as State).files) ? (incoming as State).files : [];
    if (existsSync(uploadDir) && incomingFiles.length > 0) {
      mkdirSync(filesDir, { recursive: true });
      // Build a lookup by display name → metadata so we can match upload/ entries back to
      // their saved metadata (mime, extractedText, original id).
      const metaByName = new Map<string, StoredFile>();
      for (const meta of incomingFiles) {
        if (meta && typeof meta.fileName === "string") metaByName.set(meta.fileName, meta);
      }
      for (const entry of readdirSync(uploadDir)) {
        const srcPath = join(uploadDir, entry);
        const stats = statSync(srcPath);
        if (!stats.isFile()) continue;
        const newId = state.nextFileId++;
        const ext = extname(entry) || "";
        const targetPath = join(filesDir, `${newId}${ext}`);
        writeFileSync(targetPath, readFileSync(srcPath));
        const meta = metaByName.get(entry);
        state.files.push({
          id: newId,
          path: targetPath,
          fileName: meta?.fileName ?? entry,
          mime: meta?.mime ?? guessMimeFromExt(ext),
          size: meta?.size ?? stats.size,
          extractedText: meta?.extractedText,
        });
        filesImported += 1;
      }
    }
    // Skills are restored via importSkills() above; count them from the skills array if present.
    if (Array.isArray((body as { skills?: unknown }).skills)) {
      skillsImported = ((body as { skills?: unknown[] }).skills as unknown[]).length;
    }
    finalizeConversationImport();
    saveState();
    broadcastSettings();
    broadcastList();
  } catch (err) {
    console.warn("[import] pc-backup.json apply failed", err);
    throw err;
  }
  return { settingsImported, filesImported, skillsImported, conversationsImported, dbReadError: null };
}

export function applyAndroidZipBackupFromPath(zipPath: string): { settingsImported: boolean; filesImported: number; skillsImported: number; conversationsImported: number; dbReadError: string | null } {
  // Caller is expected to have already written the zip to disk (streamed from request.body
  // for the large-file path). We accept a path rather than a Buffer because users have
  // reported backups in the 1-10 GB range — buffering those in JS heap is not feasible.
  const tmpRoot = dirname(zipPath);
  const extractDir = join(tmpRoot, "extracted");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`,
    ].join("; ");
    const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]);
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract backup zip: ${new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 300)}`);
    }
  } else {
    const proc = Bun.spawnSync(["unzip", "-o", zipPath, "-d", extractDir]);
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract backup zip: ${new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 300)}`);
    }
  }

  // PC-origin zip fast path: if pc-backup.json exists, this came from a PC export — restore
  // settings + generatedImages + memories + files metadata (from pc-backup.json) and
  // conversations (from rikka_hub.db), then re-link file bytes from upload/. logs/stats are
  // machine-local (in-memory / per-install accumulator) and are NOT carried in the backup.
  // The Android settings.json path below still exists for Android-origin zips, which don't
  // ship pc-backup.json.
  const pcBackupPath = join(extractDir, "pc-backup.json");
  if (existsSync(pcBackupPath)) {
    return applyPcBackupFromExtractDir(extractDir, pcBackupPath);
  }

  let settingsImported = false;
  let filesImported = 0;
  let skillsImported = 0;
  let conversationsImported = 0;
  let dbReadError: string | null = null;

  const settingsPath = join(extractDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      // APP→PC 导入的 settings 合并(七层策略,灵活处理):
      //   1) ...app 基底:APP 全字段进来,含 PC 不认识的 APP 独有字段(customThemes / fastModelId /
      //      enableSuggestion / webServer* / backupReminderConfig 等),不漏。PC 运行时不读的多余字段
      //      原样保留,saveState 写回、PC→APP 回导还能用。
      //   2) 标量配置(默认模型选择 / 各类 prompt / 主题 / 布尔开关):PC 缺失或仍=出厂默认 = 用户没在
      //      PC 定制 → 采用 APP(APP 是主力端);PC 已定制 → 保 PC。pick() 同时判 null 和 ===。
      //   3) 含 apiKey 的集合(providers/asr/tts):mergeById(PC, APP) PC 优先,保 PC 的 key 与定义,
      //      APP 独有条目追加。searchServices 单独处理——两端 id 都是随机生成(defaultSettings 用 id()、
      //      Android 用 Uuid.random()),mergeById 按 id 去重会翻倍,改按 type 去重(见 mergeSearchByType)。
      //   4) 用户内容集合(assistants/mcpServers/lorebooks/quickMessages/modeInjections/assistantTags):
      //      mergeById(APP, PC) APP 优先(改名/配置进来),PC 独有追加。id 是 UUID 且两端默认空,撞 id
      //      极罕见——MCP 凭证在 commonOptions.headers,撞 id 时可能丢 PC token,可接受。
      //   5) favoriteModels:元素是 model UUID(string)非 {id} 对象,用 Set 去重取并集。
      //   6) displaySetting / searchCommonOptions:对象 shallow merge,APP 字段进来、PC 独有保留;
      //      displaySetting.userNickname 非空、userAvatar 非 Dummy 才覆盖;chatFontFamily 永远保 PC
      //      (APP 是 enum 字符串、PC 是字体名,手机端字体 PC 未必安装)。
      //   7) webDav/s3:两端结构对齐后,PC 已配置保 PC、PC 空采用 APP(APP 也有此功能)。
      //      proxy/jwt/port/promptOptimize* 是 PC 独有(Android 无),永远保 PC。
      // 历史:{...PC,...APP} 浅合并丢 key;Plan B 全 PC 优先把 APP 同 id 助手/MCP/世界书挡在外面;
      //      三轮分流只覆盖 10 个集合,标量全走 PC 基底→默认模型/提示词/主题/收藏/标签全丢;七层方案补齐
      //      后又发现 searchServices 两端随机 id 致 mergeById 翻倍、webDav 误判 PC 独有被丢——本轮修正。
      const pc = state.settings;
      const app = raw as Record<string, JsonValue>;
      const defaults = defaultSettings();
      // 标量:APP 有该字段、且 PC 缺失(null)或仍=出厂默认 → 采用 APP;否则保 PC。APP 没该字段时保 PC。
      const pick = (key: string): unknown => {
        const pcVal = (pc as unknown as Record<string, unknown>)[key];
        if (!(key in app)) return pcVal;
        const defVal = (defaults as unknown as Record<string, unknown>)[key];
        return pcVal == null || pcVal === defVal ? app[key] : pcVal;
      };
      // searchServices 两端 id 都是随机生成(defaultSettings 用 id()、Android 用 Uuid.random()),mergeById
      // 按 id 去重会把 APP 的全部追加 → 搜索服务翻倍。改按 type 去重:同 type 时 APP 配了 apiKey 而 PC
      // 对应项没有 → 用 APP(把 key 带过来);否则保 PC;APP 独有 type 追加。无 type 的脏数据当独有项追加。
      const mergeSearchByType = (
        pcList: { type?: string; apiKey?: JsonValue; id: string }[],
        appList: { type?: string; apiKey?: JsonValue; id: string }[],
      ) => {
        const result = [...pcList];
        const typeToIdx = new Map<string, number>();
        result.forEach((s, i) => {
          const t = String(s.type ?? "");
          if (t && !typeToIdx.has(t)) typeToIdx.set(t, i);
        });
        for (const appSvc of appList) {
          const t = String(appSvc.type ?? "");
          if (!t) { result.push(appSvc); continue; }
          const idx = typeToIdx.get(t);
          if (idx === undefined) {
            typeToIdx.set(t, result.length);
            result.push(appSvc);
          } else if (String(appSvc.apiKey ?? "").trim() && !String(result[idx].apiKey ?? "").trim()) {
            result[idx] = appSvc; // APP 有 key、PC 没有 → 用 APP
          }
        }
        return result;
      };
      const mergedSearchServices = mergeSearchByType(
        (Array.isArray(pc.searchServices) ? pc.searchServices : []) as { type?: string; apiKey?: JsonValue; id: string }[],
        (Array.isArray(app.searchServices) ? app.searchServices : []) as { type?: string; apiKey?: JsonValue; id: string }[],
      );
      // searchServiceSelected 存的是数组下标,合并后顺序变了。PC 段在合并列表前部、顺序不变,故 PC 非默认
      // 时其索引仍有效直接保;PC=默认(0)= 用户没在 PC 选过 → 采用 APP 选中意图:取 APP 选中服务的 type
      // 在合并列表重新定位,找不到回退 0(脏数据 / APP 列表为空时兜底)。
      const resolveSearchSelected = (): number => {
        if (pc.searchServiceSelected !== defaults.searchServiceSelected) return pc.searchServiceSelected;
        const appIdx = Number(app.searchServiceSelected);
        const appList = (Array.isArray(app.searchServices) ? app.searchServices : []) as { type?: string }[];
        const targetType = String(appList[appIdx]?.type ?? "");
        if (!targetType) return 0;
        const found = mergedSearchServices.findIndex((s) => String(s.type ?? "") === targetType);
        return found >= 0 ? found : 0;
      };
      // displaySetting 两端字段不同(PC 有 uiFontFamilyCss/chatInputHeight,APP 有 showDateTimeInMessage/
      // 触觉/通知等)。shallow merge;身份字段 + chatFontFamily 做兜底。APP 的 userAvatar type 可能是
      // Android FQN(...Avatar.Dummy),rewriteAvatarsInSettings 后续转 PC 短格式,这里同时兜住 FQN 与短格式。
      // chatFontFamily:APP 是 enum 字符串(DEFAULT/MONOSPACE/CUSTOM)、PC 是字体名,且手机端字体 PC 未必
      // 安装,类型与可用性都不一致 → 永远保 PC,不接管 APP 值。
      const pcDisplay = (pc.displaySetting ?? {}) as Record<string, JsonValue>;
      const appDisplay = (app.displaySetting as Record<string, JsonValue> | undefined) ?? {};
      const mergedDisplay: Record<string, JsonValue> = { ...pcDisplay };
      for (const [k, v] of Object.entries(appDisplay)) {
        if (k === "userNickname") {
          if (typeof v === "string" && v.trim()) mergedDisplay.userNickname = v;
        } else if (k === "userAvatar") {
          const avatarType = String((v as Record<string, JsonValue> | null)?.type ?? "");
          if (v && !/\.Dummy$/i.test(avatarType) && avatarType.toLowerCase() !== "dummy") {
            mergedDisplay.userAvatar = v;
          }
        } else if (k === "chatFontFamily") {
          // 字体两端语义/可用性不同 → 保 PC
        } else {
          mergedDisplay[k] = v;
        }
      }
      // WebDavConfig 两端结构完全一致(url/username/password/path/items)。PC 已配置(url 非空)= PC 上
      // 验证过能用且含密钥 → 保 PC;PC 空(url 空)= 用户没在 PC 配过 → 采用 APP 的(主力端配置)。
      const mergedWebDav = String((pc.webDavConfig as unknown as Record<string, JsonValue> | null)?.url ?? "").trim()
        ? pc.webDavConfig
        : (app.webDavConfig ?? pc.webDavConfig);
      // S3Config 对齐 APP 后两端结构一致。PC 已配置(endpoint 非空)→ 保 PC;PC 空 → 采用 APP。
      const mergedS3 = String((pc.s3Config as unknown as Record<string, JsonValue> | null)?.endpoint ?? "").trim()
        ? pc.s3Config
        : (app.s3Config ?? pc.s3Config);
      const merged = {
        ...app,
        dynamicColor: pick("dynamicColor"),
        themeId: pick("themeId"),
        developerMode: pick("developerMode"),
        enableWebSearch: pick("enableWebSearch"),
        chatModelId: pick("chatModelId"),
        titleModelId: pick("titleModelId"),
        translateModeId: pick("translateModeId"),
        suggestionModelId: pick("suggestionModelId"),
        imageGenerationModelId: pick("imageGenerationModelId"),
        ocrModelId: pick("ocrModelId"),
        compressModelId: pick("compressModelId"),
        translateThinkingBudget: pick("translateThinkingBudget"),
        titlePrompt: pick("titlePrompt"),
        translatePrompt: pick("translatePrompt"),
        suggestionPrompt: pick("suggestionPrompt"),
        ocrPrompt: pick("ocrPrompt"),
        compressPrompt: pick("compressPrompt"),
        selectedASRProviderId: pick("selectedASRProviderId"),
        selectedTTSProviderId: pick("selectedTTSProviderId"),
        assistantId: pick("assistantId"),
        providers: mergeById(pc.providers ?? [], (Array.isArray(app.providers) ? app.providers : []) as { id: string }[]),
        searchServices: mergedSearchServices,
        searchServiceSelected: resolveSearchSelected(),
        asrProviders: mergeById(pc.asrProviders ?? [], (Array.isArray(app.asrProviders) ? app.asrProviders : []) as { id: string }[]),
        ttsProviders: mergeById(pc.ttsProviders ?? [], (Array.isArray(app.ttsProviders) ? app.ttsProviders : []) as { id: string }[]),
        assistants: mergeById((Array.isArray(app.assistants) ? app.assistants : []) as any[], pc.assistants ?? []),
        mcpServers: mergeById((Array.isArray(app.mcpServers) ? app.mcpServers : []) as any[], pc.mcpServers ?? []),
        lorebooks: mergeById((Array.isArray(app.lorebooks) ? app.lorebooks : []) as any[], pc.lorebooks ?? []),
        quickMessages: mergeById((Array.isArray(app.quickMessages) ? app.quickMessages : []) as any[], pc.quickMessages ?? []),
        modeInjections: mergeById((Array.isArray(app.modeInjections) ? app.modeInjections : []) as any[], pc.modeInjections ?? []),
        assistantTags: mergeById((Array.isArray(app.assistantTags) ? app.assistantTags : []) as any[], pc.assistantTags ?? []),
        favoriteModels: Array.from(new Set([
          ...(Array.isArray(pc.favoriteModels) ? pc.favoriteModels : []),
          ...(Array.isArray(app.favoriteModels) ? (app.favoriteModels as string[]) : []),
        ])),
        displaySetting: mergedDisplay,
        searchCommonOptions: {
          ...(pc.searchCommonOptions ?? {}),
          ...((app.searchCommonOptions as Record<string, JsonValue> | undefined) ?? {}),
        },
        webDavConfig: mergedWebDav,
        s3Config: mergedS3,
        proxyConfig: pc.proxyConfig,
        webServerJwtEnabled: pc.webServerJwtEnabled,
        preferredPort: pc.preferredPort,
        promptOptimizeModelId: pc.promptOptimizeModelId,
        promptOptimizePrompt: pc.promptOptimizePrompt,
        // keybindings 是 PC-only 字段(APP 无对应),导入时必须保 PC 自定义,否则被 normalizeState 重置为默认。
        keybindings: pc.keybindings,
        // memorySettings 同为 PC-only(APP Settings 无此字段),保 PC 设置,否则 normalizeState
        // 的 M1 推断会覆盖用户的 globalEnabled 选择。
        memorySettings: pc.memorySettings,
      } as unknown as State["settings"];
      const adjusted = rewriteAvatarsInSettings(merged, ANDROID_AVATAR_TYPE_TO_PC, "to-pc");
      setState(normalizeState({ ...state, settings: adjusted as State["settings"] }));
      settingsImported = true;
    } catch (err) {
      console.warn("[import] failed to parse Android settings.json", err);
    }
  }

  // Copy upload/ files into pc-data/files/ with fresh ids and register them in state.files.
  // We do this BEFORE importing conversations so that the filename→PC-file-id map is
  // available when rewriting `file://…/upload/<uuid>.png` URLs embedded in message parts —
  // without that rewrite, the imported messages would all show "Failed to load image"
  // because the on-disk file was renamed from `<uuid>.png` to `<numeric-id>.png`.
  const androidFilenameToPcId = new Map<string, number>();
  const uploadDir = join(extractDir, "upload");
  if (existsSync(uploadDir)) {
    mkdirSync(filesDir, { recursive: true });
    for (const entry of readdirSync(uploadDir)) {
      const srcPath = join(uploadDir, entry);
      const stats = statSync(srcPath);
      if (!stats.isFile()) continue;
      const fileId = state.nextFileId++;
      const ext = extname(entry) || "";
      const targetName = `${fileId}${ext}`;
      const targetPath = join(filesDir, targetName);
      writeFileSync(targetPath, readFileSync(srcPath));
      state.files.push({
        id: fileId,
        path: targetPath,
        fileName: entry,
        mime: guessMimeFromExt(ext),
        size: stats.size,
      });
      androidFilenameToPcId.set(entry, fileId);
      filesImported += 1;
    }
  }

  // Conversation history: Android stores them in a Room SQLite db (`rikka_hub.db`) with two
  // tables — ConversationEntity for metadata + message_node for the per-node messages array.
  // We open the file via Bun's native SQLite and rebuild PC's Conversation[] shape, which
  // happens to be a near-1:1 mapping because both sides serialize messages with the same
  // kotlinx.serialization-compatible JSON format. The filename map built from upload/ is
  // passed in so we can rewrite `file://…/upload/<uuid>.png` refs to `/api/files/<id>/content`.
  const dbPath = join(extractDir, "rikka_hub.db");
  if (existsSync(dbPath)) {
    try {
      conversationsImported = importAndroidConversations(extractDir, dbPath, androidFilenameToPcId);
      // Keep a copy of the original Android db for re-export. Open it first to
      // checkpoint any WAL data (Android exports with WAL that may contain schema
      // updates like identity_hash changes), then serialize the consolidated db.
      const cachedDbPath = join(dataDir, "rikka_hub_cached.db");
      try {
        const cacheDb = new Database(dbPath, { readonly: true });
        const bytes = cacheDb.serialize();
        cacheDb.close();
        writeFileSync(cachedDbPath, bytes);
      } catch { /* best-effort */ }
    } catch (err) {
      dbReadError = err instanceof Error ? err.message : String(err);
      console.warn("[import] failed to read Android SQLite database:", dbReadError);
    }
  }

  // skills/ — copy the directory tree verbatim into pc-data/skills/.
  const skillsSrc = join(extractDir, "skills");
  if (existsSync(skillsSrc) && skillsDir) {
    mkdirSync(skillsDir, { recursive: true });
    skillsImported = copyDirRecursive(skillsSrc, skillsDir);
  }

  finalizeConversationImport();
  saveState();
  broadcastSettings();
  broadcastList();

  // Clean up the extracted/ subdir; the caller owns and cleans tmpRoot (which still holds
  // the original streamed zip until they decide to remove the whole thing).
  rmSync(extractDir, { recursive: true, force: true });
  return { settingsImported, filesImported, skillsImported, conversationsImported, dbReadError };
}

/**
 * Reads `rikka_hub.db` (Android Room) and reconstructs PC `Conversation[]` entries by
 * joining ConversationEntity with message_node (ordered by node_index). Returns the count
 * of imported conversations.
 *
 * Conversations are merged into `state.conversations` by id — Android UUIDs effectively
 * never collide with PC-generated ones, so this is functionally an append. If the user
 * imports the same backup twice the second import overwrites prior copies (idempotent).
 *
 * The Android-side `messages` column is JSON `List<UIMessage>` serialized by kotlinx, which
 * matches PC's `Message` shape directly (role enum, parts/annotations/usage as JsonValue
 * passthroughs, ISO-string timestamps). We do shape-coercion as a defensive pass — bad rows
 * are skipped, not thrown, so a single corrupt node doesn't lose the rest of the history.
 */
function importAndroidConversations(extractDir: string, dbPath: string, androidFilenameToPcId: Map<string, number>): number {
  // SQLite resolves WAL siblings as `${dbfile}-wal` / `${dbfile}-shm`, but Android exports
  // them with the original (extension-less) database name `rikka_hub-wal` / `rikka_hub-shm`.
  // Without renaming, any uncommitted writes still sitting in the WAL are silently ignored.
  for (const [src, dest] of [
    ["rikka_hub-wal", "rikka_hub.db-wal"],
    ["rikka_hub-shm", "rikka_hub.db-shm"],
  ]) {
    const s = join(extractDir, src);
    const d = join(extractDir, dest);
    if (existsSync(s) && !existsSync(d)) {
      try { renameSync(s, d); } catch (err) { console.warn(`[import] WAL rename failed: ${err}`); }
    }
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    // Use dynamic column access (SELECT *) so we don't blow up on older Android schemas
    // missing a column. Defaults are applied per-field below.
    const convRows = db.query("SELECT * FROM ConversationEntity").all() as Record<string, unknown>[];
    const nodeStmt = db.query("SELECT * FROM message_node WHERE conversation_id = ? ORDER BY node_index ASC");

    let imported = 0;
    const existingById = new Map(state.conversations.map((conv) => [conv.id, conv]));

    for (const row of convRows) {
      const convId = String(row.id ?? "");
      if (!convId) continue;

      const nodeRows = nodeStmt.all(convId) as Record<string, unknown>[];
      const messageNodes: MessageNode[] = nodeRows.map((node) => {
        const rawMessages = typeof node.messages === "string" ? node.messages : "[]";
        let parsed: unknown[] = [];
        try {
          const decoded = JSON.parse(rawMessages);
          if (Array.isArray(decoded)) parsed = decoded;
        } catch {
          parsed = [];
        }
        const messages: Message[] = parsed
          .map(normalizeAndroidMessage)
          .filter((m): m is Message => m !== null)
          .map((m) => ({
            ...m,
            // Walk parts deeply and rewrite any Android upload paths into PC file refs. Done
            // per-message so a corrupted node only affects itself, not the whole conversation.
            parts: rewriteAndroidFileUrlsDeep(m.parts, androidFilenameToPcId) as MessagePart[],
          }));
        return {
          id: String(node.id ?? Bun.randomUUIDv7()),
          messages,
          selectIndex: typeof node.select_index === "number" ? node.select_index : 0,
        };
      });

      let chatSuggestions: string[] = [];
      try {
        const decoded = JSON.parse(typeof row.suggestions === "string" ? row.suggestions : "[]");
        if (Array.isArray(decoded)) chatSuggestions = decoded.filter((x): x is string => typeof x === "string");
      } catch { /* keep empty */ }

      const conv: Conversation = {
        id: convId,
        assistantId: String(row.assistant_id ?? DEFAULT_ASSISTANT_ID) || DEFAULT_ASSISTANT_ID,
        systemPrompt: row.custom_system_prompt ? String(row.custom_system_prompt) : null,
        title: String(row.title ?? ""),
        messages: messageNodes,
        truncateIndex: 0, // No Android equivalent — start unindented.
        chatSuggestions,
        isPinned: row.is_pinned === 1 || row.is_pinned === true,
        createAt: Number(row.create_at ?? Date.now()),
        updateAt: Number(row.update_at ?? Date.now()),
      };

      existingById.set(conv.id, conv);
      imported += 1;
    }

    // Re-sort by updateAt desc so the imported conversations land in the natural "most
    // recent first" order alongside any PC-side conversations the user already had.
    state.conversations = Array.from(existingById.values()).sort((a, b) => b.updateAt - a.updateAt);

    // 助手记忆:Android 存在同库的 MemoryEntity 表(字段 id / assistant_id / content,无时间戳)。
    // 按 (assistantId, content) 去重 merge 进 memoryStore——PC 已有的相同内容不重复导入;
    // Android 的 Int 自增 id 和 PC 的 id 空间不一致,memoryStore 统一重新分配。global 记忆的
    // assistant_id 两端都是 "__global__"。MemoryEntity 不存在(老版本 APP / 空库)时查询抛错,
    // 静默跳过。语义为"合并"(迁移场景,不覆盖 PC 已有记忆),区别于备份恢复的"替换"。
    try {
      const memoryRows = db.query("SELECT assistant_id, content FROM MemoryEntity").all() as Record<string, unknown>[];
      const flat: AssistantMemory[] = memoryRows.map((row) => ({
        id: 0,
        assistantId: String(row.assistant_id ?? GLOBAL_MEMORY_ID) || GLOBAL_MEMORY_ID,
        content: String(row.content ?? ""),
        createdAt: 0,
        updatedAt: 0,
      }));
      memoryStore.importFlatMemories(flat, "merge");
    } catch (err) {
      console.warn("[import] failed to read MemoryEntity table:", err);
    }
    return imported;
  } finally {
    db.close();
  }
}

/**
 * Deep-walk a JsonValue rewriting any string that matches Android's upload URL pattern
 * (`file:///…/upload/<filename>` or just `…/upload/<filename>`) into PC's
 * `/api/files/<id>/content` form, using the filename→pcFileId map built during the upload
 * folder copy.
 *
 * Conservative — only matches the literal segment `upload/<filename>` and only rewrites
 * when the filename is in our map. URLs we don't recognize pass through untouched, so
 * tool-output JSON with arbitrary http/https URLs is unaffected.
 */
function rewriteAndroidFileUrlsDeep(value: JsonValue, map: Map<string, number>): JsonValue {
  if (typeof value === "string") {
    return rewriteAndroidFileUrl(value, map);
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteAndroidFileUrlsDeep(v, map));
  }
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = rewriteAndroidFileUrlsDeep(v as JsonValue, map);
    }
    return result;
  }
  return value;
}

function rewriteAndroidFileUrl(url: string, map: Map<string, number>): string {
  // Match the last `upload/<filename>` segment. Android URI is `file:///data/.../files/upload/<uuid>.<ext>`;
  // we strip everything up to and including the final `upload/` and use the trailing name.
  const match = url.match(/(?:^|[/\\])upload[/\\]([^/\\?#]+)/);
  if (!match) return url;
  const filename = match[1];
  const pcId = map.get(filename);
  if (pcId === undefined) return url;
  return `/api/files/${pcId}/content`;
}

/**
 * Defensive shape-coercion from Android UIMessage JSON to PC Message. Bad rows return null
 * (caller filters). Role enum is whitelisted to PC's 4 known values; anything else falls
 * back to "USER" rather than producing an unrecognized role.
 */
function normalizeAndroidMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const role = typeof r.role === "string" ? r.role.toUpperCase() : "USER";
  const allowedRoles: Message["role"][] = ["USER", "ASSISTANT", "SYSTEM", "TOOL"];
  const mappedRole: Message["role"] = (allowedRoles as string[]).includes(role)
    ? (role as Message["role"])
    : "USER";
  return {
    id: typeof r.id === "string" ? r.id : Bun.randomUUIDv7(),
    role: mappedRole,
    parts: Array.isArray(r.parts) ? (r.parts as MessagePart[]) : [],
    annotations: Array.isArray(r.annotations) ? (r.annotations as JsonValue[]) : [],
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
    finishedAt: typeof r.finishedAt === "string" ? r.finishedAt : null,
    modelId: typeof r.modelId === "string" ? r.modelId : null,
    usage: (r.usage ?? null) as JsonValue | null,
    translation: typeof r.translation === "string" ? r.translation : null,
  };
}

/** 导入备份收尾:中止所有流 + 清脏 + 重灌活库为当前 state.conversations。
 *  state.conversations 在导入流程里被整体替换/合并,活库必须同步重灌,否则重启后
 *  loadAllConversationsFromDb 读到旧活库、导入的会话丢失。中止所有流 + 清脏防竞态
 *  (流式中导入备份:否则流式循环会继续 upsert 旧节点进刚重灌的活库)。 */
function finalizeConversationImport(): void {
  // 中止所有流(手动,不走 abortConversationGeneration 以免它 persist——马上要全量重灌)
  for (const conversationId of Array.from(generating.keys())) {
    generating.get(conversationId)?.abort();
  }
  generating.clear();
  clearConvDirtyState();
  resetConversationsDbTo(state.conversations);
}

/** Stream an HTTP response body to a temp file (no in-JS-memory buffering) and route the
 *  saved file through applyAndroidZipBackupFromPath / applyBackupPayload as appropriate.
 *  Used by s3Restore + webDavRestore. Mirrors the local data/import streaming-path so
 *  multi-GB backups can be restored from cloud the same way they can from a local picker. */
export async function streamResponseToTempAndRestore(response: Response, fileName: string, onProgress?: (message: string, percent?: number) => void): Promise<void> {
  const tmpRoot = join(tempDir(), `rikkahub-restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpRoot, { recursive: true });
  const sanitized = fileName.replace(/[^A-Za-z0-9._\-]/g, "_") || "backup.zip";
  const onDiskName = sanitized.toLowerCase().endsWith(".zip") || sanitized.toLowerCase().endsWith(".json")
    ? sanitized
    : `${sanitized}.zip`;
  const onDiskPath = join(tmpRoot, onDiskName);
  const customJsBefore = customJsScriptSignatures(state.settings);
  try {
    const body = response.body;
    if (!body) throw new Error("Empty response body");
    const totalSize = Number(response.headers.get("Content-Length") || "0");
    let downloaded = 0;
    const writer = Bun.file(onDiskPath).writer();
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
        downloaded += value.length;
        if (totalSize > 0) {
          const pct = Math.round(downloaded / totalSize * 100);
          onProgress?.(`正在下载 (${pct}%)`, pct);
        }
      }
    } finally {
      await writer.end();
    }
    onProgress?.("正在导入数据...");
    const magic = new Uint8Array(await Bun.file(onDiskPath).slice(0, 4).arrayBuffer());
    const isZip = magic.length >= 4 && magic[0] === 0x50 && magic[1] === 0x4B && magic[2] === 0x03 && magic[3] === 0x04;
    if (isZip) {
      applyAndroidZipBackupFromPath(onDiskPath);
    } else {
      applyBackupPayload(JSON.parse(readFileSync(onDiskPath, "utf-8")));
    }
    const customJsWarning = customJsImportWarning(customJsBefore, state.settings);
    if (customJsWarning) {
      console.warn(`[restore] ${customJsWarning}`);
      onProgress?.(customJsWarning);
    }
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
