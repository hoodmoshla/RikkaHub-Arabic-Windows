// backup/export.ts — PC 备份导出（zip 打包、Android rikka_hub.db 生成、avatar 类型互转）
// 纪律：Android 互导契约（枚举过滤、avatar FQN 转换、备份 zip 结构）冻结，只准原样搬迁。
// 部分辅助（updateSettings 等）暂经 ../server 导入，3.5 拆 api/ 时收敛。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { JsonValue } from "../foundation/types";
import type { Settings } from "../foundation/types/settings";
import { isRecord, safeJsonStringify } from "../foundation/utils";
import { dataDir, filesDir, skillsDir } from "../foundation/paths";
import { tempDir } from "../foundation/platform";
import { state } from "../persistence/json-store";
import { GLOBAL_MEMORY_ID, memoryStore } from "../memory/index";
import { DEFAULT_ASSISTANT_ID, getConversationsDb, isConversationLoaded, loadConversationNodesFromDb } from "../conversations";
import { exportSkills } from "../tools";

export function copyDirRecursive(src: string, dest: string): number {
  let count = 0;
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stats = statSync(srcPath);
    if (stats.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      count += copyDirRecursive(srcPath, destPath);
    } else {
      writeFileSync(destPath, readFileSync(srcPath));
      count += 1;
    }
  }
  return count;
}

// 导出备份时剥离移动端无法识别的模型模态(AUDIO/VIDEO/DOCUMENT)。
// 移动端 Modality 枚举只有 TEXT/IMAGE,kotlinx.serialization 反序列化 List<Modality>
// 遇到这三个值会抛 SerializationException,导致整个 settings 恢复失败(Issue #11)。
// 另:LLM 体系里不存在"文档"模态,且 PC/移动端当前都没有音视频对话能力,这些配置对
// 用户只是无效元数据。
// 纯函数:深拷贝,绝不改动内存中的运行时 state.settings,只清洗"写入备份文件"的内容。
const BACKUP_INCOMPATIBLE_MODALITIES = new Set(["AUDIO", "VIDEO", "DOCUMENT"]);

function sanitizeModelModalitiesForExport(settings: Settings): Settings {
  return {
    ...settings,
    providers: (settings.providers ?? []).map((provider) => ({
      ...provider,
      models: (provider.models ?? []).map((modelItem) => {
        const filterMods = (mods: string[] | undefined): string[] => {
          const cleaned = (mods ?? []).filter(
            (m) => !BACKUP_INCOMPATIBLE_MODALITIES.has(String(m).toUpperCase()),
          );
          return cleaned.length ? cleaned : ["TEXT"];
        };
        return {
          ...modelItem,
          inputModalities: filterMods(modelItem.inputModalities),
          outputModalities: filterMods(modelItem.outputModalities),
        };
      }),
    })),
  };
}

// Backup payload that does NOT base64-inline file bytes — file data lives in
// the surrounding zip's `upload/<displayName>` entries, and only file metadata (id, fileName,
// mime, size) survives the JSON round-trip. This is the format used inside
// `pc-backup.json` of a zip backup, and is the only OOM-safe path for users with multi-GB
// of attachments (inlining base64 file bytes can easily push a couple GB of files into
// a JS string, blowing the V8 heap limit).
export function backupPayloadMetadataOnly(settingsOverride?: Settings) {
  const settings = settingsOverride ?? state.settings;
  return {
    version: 2,
    app: "RikkaHub PC",
    exportedAt: new Date().toISOString(),
    // Exclude conversations from pc-backup.json — they're exported as rikka_hub.db now.
    // Including them here caused OOM crashes for users with large imported Android histories.
    state: {
      settings,
      generatedImages: state.generatedImages,
      files: state.files,
      memories: memoryStore.exportFlat(),
    },
    skills: exportSkills(),
    files: state.files.map((file) => ({
      id: file.id,
      path: file.path,
      fileName: file.fileName,
      mime: file.mime,
      size: file.size,
      extractedText: file.extractedText,
    })),
  };
}

// kotlinx.serialization uses the FQN of @Serializable subclasses as the polymorphic
// discriminator value (no @SerialName annotation on Avatar.Dummy / Emoji / Image, so the
// FQN is the default). PC internally uses short names — "dummy"/"emoji"/"image" — for
// brevity in the UI code paths. When we hand off settings.json to Android we must rewrite
// the avatar.type field to the FQN form, otherwise Android's BackupVM crashes with
// "Serializer for subclass 'dummy' is not found in the polymorphic scope of 'Avatar'".
// Same transform is applied in reverse when we import an Android-origin settings.json.
export const PC_AVATAR_TYPE_TO_ANDROID: Record<string, string> = {
  dummy: "me.rerere.rikkahub.data.model.Avatar.Dummy",
  emoji: "me.rerere.rikkahub.data.model.Avatar.Emoji",
  image: "me.rerere.rikkahub.data.model.Avatar.Image",
  url: "me.rerere.rikkahub.data.model.Avatar.Image",
};

export const ANDROID_AVATAR_TYPE_TO_PC: Record<string, string> = Object.fromEntries(
  Object.entries(PC_AVATAR_TYPE_TO_ANDROID).map(([pc, android]) => [android, pc]),
);

export function mapAvatarType(value: JsonValue, mapping: Record<string, string>): JsonValue {
  if (!isRecord(value)) return value;
  const type = String(value.type ?? "");
  if (!type || !mapping[type]) return value;
  return { ...value, type: mapping[type] };
}

/** 方向感知的 settings 转换。
 *  - "to-android"(默认,PC→APP 导出):映射 avatar + strip PC-only 字段 + role/reasoningLevel
 *    转小写 + 空 UUID 填随机。strip 是 Android kotlinx.serialization 的硬要求——PC-only 字段
 *    进去 Android 无法反序列化、Android Uuid 反序列化拒空串。
 *  - "to-pc"(APP→PC 导入):只映射 avatar(Android FQN → PC 短格式)。不 strip、不填 UUID、不动
 *    role——PC 端接受 null/大写,且 PC-only 字段(proxyConfig / preferredPort / 字体 / 助手的
 *    mcpToolOverrides 等)必须原样保留,否则一次导入就会清空 PC 上已配置的代理、端口、字体
 *    与 MCP 覆盖,也会把未选模型的 null chatModelId 填成不存在的随机 UUID。 */
export function rewriteAvatarsInSettings(settings: any, mapping: Record<string, string>, direction: "to-android" | "to-pc" = "to-android"): any {
  if (!isRecord(settings)) return settings;
  const stripPcOnly = direction === "to-android";
  const copy: any = { ...settings };
  if (Array.isArray(copy.assistants)) {
    copy.assistants = copy.assistants.map((a: any) => {
      if (!isRecord(a)) return a;
      const fixed: any = { ...a };
      if (fixed.avatar) fixed.avatar = mapAvatarType(fixed.avatar, mapping);
      if (stripPcOnly) {
        // reasoningLevel: PC uses "AUTO", Android expects "auto"
        if (typeof fixed.reasoningLevel === "string") fixed.reasoningLevel = fixed.reasoningLevel.toLowerCase();
        // presetMessages role: PC uses "USER"/"ASSISTANT", Android expects "user"/"assistant"
        if (Array.isArray(fixed.presetMessages)) {
          fixed.presetMessages = fixed.presetMessages.map((pm: any) =>
            isRecord(pm) && typeof pm.role === "string" ? { ...pm, role: pm.role.toLowerCase() } : pm,
          );
        }
        // Strip PC-only assistant fields that Android doesn't have
        delete fixed.mcpToolOverrides;
        delete fixed.allowConversationSystemPrompt;
      }
      return fixed;
    });
  }
  // modeInjections role: PC uses "USER", Android expects "user"
  if (stripPcOnly && Array.isArray(copy.modeInjections)) {
    copy.modeInjections = copy.modeInjections.map((mi: any) =>
      isRecord(mi) && typeof mi.role === "string" ? { ...mi, role: mi.role.toLowerCase() } : mi,
    );
  }
  if (isRecord(copy.displaySetting)) {
    const displaySetting = { ...(copy.displaySetting as Record<string, JsonValue>) };
    if (displaySetting.userAvatar) {
      displaySetting.userAvatar = mapAvatarType(displaySetting.userAvatar, mapping);
    }
    if (stripPcOnly) {
      // Strip PC-only displaySetting fields that Android can't deserialize:
      // - chatFontFamily: PC uses "" (empty string) which isn't a valid Android enum value
      // - chatFontFamilyCss: PC-only CSS field
      // - uiFontSize / chatFontSize: PC-only font size fields
      const pcOnlyDisplayFields = ["chatFontFamily", "chatFontFamilyCss", "uiFontSize", "chatFontSize", "chatInputHeight"];
      for (const field of pcOnlyDisplayFields) {
        if (field in displaySetting) delete displaySetting[field];
      }
    }
    copy.displaySetting = displaySetting;
  }
  if (stripPcOnly) {
    // Strip PC-only top-level fields
    delete copy.proxyConfig;
    delete copy.preferredPort;
    delete copy.keybindings;
    // Fix empty-string UUID fields — Android's Uuid deserializer rejects ""
    const uuidFields = ["chatModelId", "titleModelId", "translateModeId", "suggestionModelId", "imageGenerationModelId", "ocrModelId", "compressModelId", "assistantId", "selectedTTSProviderId", "selectedASRProviderId"];
    for (const field of uuidFields) {
      if (field in copy && (copy[field] === "" || copy[field] === null || copy[field] === undefined)) {
        copy[field] = crypto.randomUUID();
      }
    }
  }
  return copy;
}

/** Generate a Room-compatible SQLite database from PC's conversation data so Android can
 *  restore chat history from a PC-origin backup zip. The schema matches Android's
 *  rikka_hub.db exactly (ConversationEntity + message_node + room_master_table). */
function generateRikkaHubDb(dbPath: string): boolean {
  const cachedDbPath = join(dataDir, "rikka_hub_cached.db");
  if (!existsSync(cachedDbPath)) return false;
  try {
    const cachedDb = new Database(cachedDbPath, { readonly: true });
    const schemaRows = cachedDb.query("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name").all() as any[];
    const uv = (cachedDb.query("PRAGMA user_version").get() as any)?.user_version ?? 18;
    const roomRows = cachedDb.query("SELECT id, identity_hash FROM room_master_table").all() as any[];
    const metaRows = cachedDb.query("SELECT locale FROM android_metadata").all() as any[];
    cachedDb.close();
    const db = new Database(":memory:");
    db.exec(`PRAGMA user_version = ${uv}`);
    for (const row of schemaRows) {
      if (row.name === 'android_metadata' || row.name === 'room_master_table') {
        try { db.exec(row.sql); } catch { /* */ }
      }
    }
    for (const m of metaRows) { try { db.exec(`INSERT INTO android_metadata VALUES ('${m.locale}')`); } catch { /* */ } }
    for (const r of roomRows as any[]) { try { db.exec(`INSERT INTO room_master_table VALUES (${r.id}, '${r.identity_hash}')`); } catch { /* */ } }
    // FTS5 虚拟表(message_fts)及其影子表都必须排除——APP 端 Room 会在 onOpen 自行重建。
    // 影子表(message_fts_data / _idx / _content / _config / _docsize)在 sqlite_master 里
    // 是普通 CREATE TABLE,不含 "USING fts5",单纯正则命中不到;若作为孤儿表落进备份 .db,
    // APP 端 Room onOpen 执行 CREATE VIRTUAL TABLE ... USING fts5 时,FTS5 会尝试再建影子表,
    // 撞 "table 'message_fts_data' already exists" 直接崩溃(只要做过手机端适配,之后任何带
    // 会话的 PC 导出导入 APP 都必崩)。先收集所有 FTS5 虚拟表名,再按 <vtab>_ 前缀排除影子表。
    const ftsVirtualTableNames = new Set<string>();
    for (const row of schemaRows) {
      if (row.type === "table" && row.name && /\bUSING\s+fts5\b/i.test(row.sql ?? "")) {
        ftsVirtualTableNames.add(row.name);
      }
    }
    const isFtsShadowTable = (name: string) =>
      [...ftsVirtualTableNames].some((vtab) => name.startsWith(vtab + "_"));
    for (const row of schemaRows) {
      if (row.name === 'android_metadata' || row.name === 'room_master_table') continue;
      if (row.name?.startsWith('sqlite_')) continue;
      if (/\bUSING\s+fts5\b/i.test(row.sql ?? "")) continue;
      if (row.name && isFtsShadowTable(row.name)) continue;
      try { db.exec(row.sql); } catch { /* */ }
    }
    insertConversationsIntoDb(db);
    insertMemoriesIntoDb(db);
    writeFileSync(dbPath, db.serialize());
    db.close();
    return true;
  } catch (err) {
    console.warn("[backup] cached db schema read failed:", err);
    return false;
  }
}

/** 把 PC 记忆写进 rikka_hub.db 的 MemoryEntity 表(PC→APP 方向,§7.7)。表结构从
 *  cached.db 克隆(id INTEGER PK AUTOINCREMENT / assistant_id TEXT / content TEXT)。
 *  防御:cached.db 若来自老版 APP(无 MemoryEntity 表),跳过,不影响会话。
 *  id 不写:SQLite AUTOINCREMENT 分配(对称 APP→PC 导入丢弃 id 重分配,server.ts:4012)。
 *  时间戳不写:APP 的 MemoryEntity 表无此列。整体替换语义下助手+记忆同源 assistantId,天然匹配。 */
function insertMemoriesIntoDb(db: InstanceType<typeof Database>) {
  const hasTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='MemoryEntity'").get();
  if (!hasTable) return;
  const flat = memoryStore.exportFlat();
  if (flat.length === 0) return;
  const stmt = db.prepare("INSERT INTO MemoryEntity (assistant_id, content) VALUES (?, ?)");
  const seen = new Set<string>();
  for (const m of flat) {
    const content = String(m.content ?? "").trim();
    if (!content) continue;
    const assistantId = String(m.assistantId ?? GLOBAL_MEMORY_ID) || GLOBAL_MEMORY_ID;
    const key = `${assistantId} ${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stmt.run(assistantId, content);
  }
}

// ----- 1.2.6 迁移:state.json conversations → 活库(一次性,P1)-----
//
// 触发条件:state.json 仍含 conversations 数组 且 appliedMigrations 不含
// "conversations-sqlite-1.2.6"。流程(崩溃安全):
//   ① 备份 state.json → state.json.pre-sqlite.bak(降级安全网,已存在不覆盖)
//   ② 灌库(单事务,INSERT OR REPLACE 幂等)
//   ③ 写瘦 state.json(删 conversations + 加迁移标记,temp+rename 原子)
// 崩在 ①②:state.json 未变,重跑幂等;崩在 ③:temp 未 rename,重跑。无数据丢失。

function insertConversationsIntoDb(db: InstanceType<typeof Database>) {
  const insertConv = db.prepare("INSERT OR REPLACE INTO ConversationEntity (id, assistant_id, title, nodes, create_at, update_at, suggestions, is_pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertNode = db.prepare("INSERT OR REPLACE INTO message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)");
  // P1-1 懒加载:未加载会话从活库瞬时读,峰值内存从全库降为单会话(10GB 用户净改善)。
  const liveDb = getConversationsDb();
  const txn = db.transaction(() => {
    for (const conv of state.conversations) {
      try {
        insertConv.run(conv.id, conv.assistantId || DEFAULT_ASSISTANT_ID, conv.title || "", "[]", conv.createAt || Date.now(), conv.updateAt || Date.now(), JSON.stringify(conv.chatSuggestions || []), conv.isPinned ? 1 : 0);
        const convNodes = isConversationLoaded(conv.id) || !liveDb ? (conv.messages || []) : loadConversationNodesFromDb(liveDb, conv.id);
        for (let i = 0; i < convNodes.length; i++) {
          const node = convNodes[i];
          if (!node?.id) continue;
          const toLocalDt = (v: any) => typeof v === "string" ? v.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "") : v;
          const toInstant = (v: any) => typeof v === "string" && v && !v.endsWith("Z") && !/[+-]\d{2}:\d{2}$/.test(v) ? v + "Z" : v;
          const fixParts = (parts: any[]) => parts.map((p: any) => {
            if (!p || typeof p !== "object") return p;
            const fixed = { ...p };
            if (fixed.createdAt) fixed.createdAt = toInstant(fixed.createdAt);
            if (fixed.finishedAt) fixed.finishedAt = toInstant(fixed.finishedAt);
            return fixed;
          });
          const msgs = (node.messages || []).map((m: any) => ({ id: m.id || null, role: String(m.role || "user").toLowerCase(), parts: fixParts(m.parts || []), annotations: m.annotations || [], createdAt: toLocalDt(m.createdAt), finishedAt: toLocalDt(m.finishedAt), modelId: m.modelId || null, usage: m.usage || null, translation: m.translation || null }));
          insertNode.run(node.id, conv.id, i, JSON.stringify(msgs), node.selectIndex ?? 0);
        }
      } catch (err) { console.warn(`[backup] skipping conversation ${conv.id}: ${err}`); }
    }
  });
  txn();
}

// Writes the backup zip directly to a caller-provided path and returns its size. Used
// by the local-export endpoint to avoid pulling the whole zip into a Buffer just to turn
// around and stream it as the HTTP response — for users with multi-GB attachments, the zip
// itself can exceed 4 GB and Buffer.from(...) on it is an OOM in waiting.
export function createSettingsBackupZipToPath(targetZipPath: string, onProgress?: (message: string) => void): number {
  const tmpRoot = join(tempDir(), `rikkahub-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const stageDir = join(tmpRoot, "stage");
  mkdirSync(stageDir, { recursive: true });
  try {
    onProgress?.("正在准备配置文件...");
    console.log(`[backup] staging settings.json...`);
    // 导出时剥离移动端不兼容的模型模态(AUDIO/VIDEO/DOCUMENT),避免移动端导入崩溃
    // (Issue #11)。仅作用于备份文件内容,不改内存中的运行时 state.settings。
    const sanitizedSettings = sanitizeModelModalitiesForExport(state.settings);
    writeFileSync(
      join(stageDir, "settings.json"),
      safeJsonStringify(rewriteAvatarsInSettings(sanitizedSettings, PC_AVATAR_TYPE_TO_ANDROID)),
    );
    console.log(`[backup] staging pc-backup.json...`);
    writeFileSync(
      join(stageDir, "pc-backup.json"),
      safeJsonStringify(backupPayloadMetadataOnly(sanitizedSettings)),
    );
    if (state.conversations.length > 0 || memoryStore.exportFlat().length > 0) {
      onProgress?.("正在生成对话数据库...");
      const dbPath = join(stageDir, "rikka_hub.db");
      try {
        const ok = generateRikkaHubDb(dbPath);
        if (ok) {
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            const p = dbPath + suffix;
            if (existsSync(p)) try { rmSync(p); } catch { /* */ }
          }
          writeFileSync(join(stageDir, "rikka_hub-wal"), Buffer.alloc(0));
          writeFileSync(join(stageDir, "rikka_hub-shm"), Buffer.alloc(0));
        } else {
          if (existsSync(dbPath)) try { rmSync(dbPath); } catch { /* */ }
        }
      } catch (dbErr) {
        console.error("[backup] generateRikkaHubDb failed:", dbErr);
        if (existsSync(dbPath)) try { rmSync(dbPath); } catch { /* */ }
      }
    }
    if (state.files.length > 0) {
      const uploadStage = join(stageDir, "upload");
      mkdirSync(uploadStage, { recursive: true });
      const usedNames = new Set<string>();
      const totalFiles = state.files.length;
      let stagedFiles = 0;
      let skippedFiles = 0;
      for (const file of state.files) {
        // path 可能因跨机器/跨平台迁移 state.json、或 dataDir 漂移而失效(指向不存在的文件)。
        // PC 文件命名固定为 <id>.<ext>,path 找不到时回退到 filesDir 下按 id 重找,尽量不丢附件。
        let srcPath = file.path;
        if (!srcPath || !existsSync(srcPath)) {
          const ext = extname(file.fileName || "") || extname(file.path || "") || "";
          const fallback = join(filesDir, `${file.id}${ext}`);
          srcPath = existsSync(fallback) ? fallback : "";
        }
        if (!srcPath) {
          skippedFiles++;
          continue;
        }
        let name = file.fileName || `${file.id}${extname(srcPath) || ""}`;
        if (usedNames.has(name)) {
          const ext = extname(name);
          const stem = name.slice(0, name.length - ext.length);
          name = `${stem}_${file.id}${ext}`;
        }
        usedNames.add(name);
        stagedFiles++;
        onProgress?.(`正在打包附件 (${stagedFiles}/${totalFiles})...`);
        try {
          writeFileSync(join(uploadStage, name), readFileSync(srcPath));
        } catch (copyErr) {
          console.warn("[backup] failed to stage upload file", srcPath, copyErr);
        }
      }
      if (skippedFiles > 0) {
        console.warn(`[backup] ⚠️ ${skippedFiles}/${totalFiles} attachment(s) skipped — source file missing (path invalid or file deleted). They will NOT be in the backup.`);
      }
    }
    if (existsSync(skillsDir)) {
      onProgress?.("正在打包技能文件...");
      const skillsStage = join(stageDir, "skills");
      mkdirSync(skillsStage, { recursive: true });
      copyDirRecursive(skillsDir, skillsStage);
    }
    onProgress?.("正在压缩...");
    if (existsSync(targetZipPath)) rmSync(targetZipPath);
    console.log(`[backup] creating zip from ${stageDir} → ${targetZipPath} (${readdirSync(stageDir).join(", ")})`);
    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `[System.IO.Compression.ZipFile]::CreateFromDirectory('${stageDir.replace(/'/g, "''")}', '${targetZipPath.replace(/'/g, "''")}')`,
      ].join("; ");
      const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: 120_000 });
      if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 500);
        const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).slice(0, 200);
        console.error("[backup] zip creation failed, exit:", proc.exitCode, "stderr:", stderr, "stdout:", stdout);
        throw new Error(`Zip creation failed (exit ${proc.exitCode}): ${stderr || stdout || "unknown error"}`);
      }
    } else {
      const proc = Bun.spawnSync(["zip", "-rq", targetZipPath, "."], { cwd: stageDir, timeout: 120_000 });
      if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 500);
        console.error("[backup] zip creation failed, exit:", proc.exitCode, "stderr:", stderr);
        throw new Error(`Zip creation failed (exit ${proc.exitCode}): ${stderr || "unknown error"}`);
      }
    }
    if (!existsSync(targetZipPath)) {
      throw new Error("Zip file was not created (file missing after archiver exited 0)");
    }
    return statSync(targetZipPath).size;
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
