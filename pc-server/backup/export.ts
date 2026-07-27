// backup/export.ts — PC 备份导出（zip 打包、Android rikka_hub.db 生成、avatar 类型互转）
// 纪律：Android 互导契约（枚举过滤、avatar FQN 转换、备份 zip 结构）冻结，只准原样搬迁。
// 部分辅助（updateSettings 等）暂经 ../server 导入，3.5 拆 api/ 时收敛。

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { JsonValue } from "../foundation/types";
import type { Settings } from "../foundation/types/settings";
import { isRecord, safeJsonStringify } from "../foundation/utils";
import { dataDir, filesDir, skillsDir } from "../foundation/paths";
import { reportError } from "../observability/app-errors";
import { tempDir } from "../foundation/platform";
import { state } from "../persistence/json-store";
import { GLOBAL_MEMORY_ID, memoryStore } from "../memory/index";
import { DEFAULT_ASSISTANT_ID, exportPcConversationsDump, flushConvDirtyNow, getConversationsDb, loadConversationNodesFromDb } from "../conversations";
import { listAllConversationMetas } from "../conversations/read-queries";
import { collectPcFileRefs, hashFileSha256 } from "./file-refs";
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
      copyFileSync(srcPath, destPath); // 5-7:内核级拷贝,>2GiB 不进 JS 堆
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
export function backupPayloadMetadataOnly(settingsOverride?: Settings, backupNameById?: Map<number, string>) {
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
      // backupName = zip 内 upload/ 实际文件名(去重/重名规避后),恢复端据此回链原 id(批5)。
      files: state.files.map((file) =>
        backupNameById?.has(file.id) ? { ...file, backupName: backupNameById.get(file.id) } : file,
      ),
      memories: memoryStore.exportFlat(),
    },
    skills: exportSkills(),
    // 批5:移除曾经的顶层 files[] 副本——与 state.files 完全重复(含 extractedText 时是
    // 双份全文文本),zip 恢复端只读 state.files。老 JSON 备份的顶层 files(带 base64 data)
    // 由另一条导出路径生产,不受影响。
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
        // Strip PC-only assistant fields that Android doesn't have.
        // 安卓对齐批6:allowConversationSystemPrompt 已是安卓正式字段(Assistant.kt),
        // 不再 strip——此前误删导致 PC→APP 后所有助手的会话级系统提示词开关归 false。
        delete fixed.mcpToolOverrides;
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
      // - chatFontFamilyCss: PC-only CSS field
      // - uiFontSize / chatFontSize: PC-only font size fields
      const pcOnlyDisplayFields = ["chatFontFamilyCss", "uiFontSize", "chatFontSize", "chatInputHeight"];
      for (const field of pcOnlyDisplayFields) {
        if (field in displaySetting) delete displaySetting[field];
      }
      // 安卓对齐批6:chatFontFamily 只对安卓枚举外的值(PC 自由字体名/空串)strip;
      // 合法枚举(PreferencesStore.kt ChatFontFamily 的 SerialName)原样保留,
      // APP 用户的 serif/monospace 选择经 PC 往返不再退回 default。
      const androidChatFontFamilies = new Set(["default", "serif", "monospace", "custom"]);
      if ("chatFontFamily" in displaySetting && !androidChatFontFamilies.has(String(displaySetting.chatFontFamily))) {
        delete displaySetting.chatFontFamily;
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
function generateRikkaHubDb(dbPath: string, backupNameById?: Map<number, string>): boolean {
  const cachedDbPath = join(dataDir, "rikka_hub_cached.db");
  if (!existsSync(cachedDbPath)) {
    // 模板在成功导入一次安卓备份后才存在。缺失时导出 zip 静默不含 rikka_hub.db,
    // 安卓端导入后会话为空——至少留条日志,别让用户以为导出是完整的(DB-first 批1 验证时记录的遗留项)。
    reportError("backup", "warn", "rikka_hub_cached.db 模板缺失,导出 zip 将不含 rikka_hub.db(安卓端导入无会话)");
    return false;
  }
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
    // 5-7:参数化。值来自曾导入的安卓库,字符串拼 SQL 理论上可向自己的导出产物注入。
    for (const m of metaRows) { try { db.prepare("INSERT INTO android_metadata VALUES (?)").run(m.locale); } catch { /* */ } }
    for (const r of roomRows as any[]) { try { db.prepare("INSERT INTO room_master_table VALUES (?, ?)").run(r.id, r.identity_hash); } catch { /* */ } }
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
    insertConversationsIntoDb(db, backupNameById);
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
 *  id 不写:SQLite AUTOINCREMENT 分配(对称 APP→PC 导入丢弃 id 重分配,backup/import.ts)。
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

// 安卓对齐批6:PC 消息里的附件引用是 /api/files/<id>/content,安卓无法解析(此前 PC→APP
// 全部裂图)。导出时反向重写成安卓自身的 upload 绝对路径 URI(与安卓消息内的原生形态一致,
// PC 导入端 rewriteAndroidFileUrl 的 upload/<name> 正则也能精确逆回)。文件名做 JSON 转义。
/** 安卓对齐批6(审查A P0):ToolPart.output 里的 {error}/{pending} 历史载荷没有 type 判别符,
 *  安卓 sealed 多态解码抛 SerializationException 且读会话处无容错。对齐安卓自身写法
 *  (GenerationHandler 把错误 JSON 包成 text part)。仅用于导出产物,PC 内部契约不动。 */
export function wrapToolOutputEntriesForAndroid(output: unknown[]): unknown[] {
  return output.map((entry: any) =>
    entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.type !== "string"
      ? { type: "text", text: JSON.stringify(entry) }
      : entry,
  );
}

const ANDROID_UPLOAD_URI_PREFIX = "file:///data/user/0/me.rerere.rikkahub/files/upload/";
function rewritePcUrlsToAndroidUpload(jsonText: string, backupNameById: Map<number, string>): string {
  return jsonText.replace(/\/api\/files\/(\d+)\/content/g, (whole, idStr: string) => {
    const name = backupNameById.get(Number(idStr));
    if (name === undefined) return whole;
    return `${ANDROID_UPLOAD_URI_PREFIX}${JSON.stringify(name).slice(1, -1)}`;
  });
}

function insertConversationsIntoDb(db: InstanceType<typeof Database>, backupNameById?: Map<number, string>) {
  // 安卓对齐批6:模板列存在时回写 custom_system_prompt(会话级系统提示词),按 PRAGMA
  // 判该列可否为 null。模板较老没有该列时保持 8 列写入,不破坏旧模板兼容。
  const convCols = db.prepare("PRAGMA table_info(ConversationEntity)").all() as { name: string; notnull: number }[];
  const cspCol = convCols.find((c) => c.name === "custom_system_prompt");
  const insertConv = cspCol
    ? db.prepare("INSERT OR REPLACE INTO ConversationEntity (id, assistant_id, title, nodes, create_at, update_at, suggestions, is_pinned, custom_system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    : db.prepare("INSERT OR REPLACE INTO ConversationEntity (id, assistant_id, title, nodes, create_at, update_at, suggestions, is_pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertNode = db.prepare("INSERT OR REPLACE INTO message_node (id, conversation_id, node_index, messages, select_index) VALUES (?, ?, ?, ?, ?)");
  // DB-first 批1:导出全走活库(先 flush 对齐脏数据),逐会话瞬时读,峰值内存=单会话。
  flushConvDirtyNow();
  const liveDb = getConversationsDb();
  const exportMetas = liveDb ? listAllConversationMetas(liveDb) : [];
  const txn = db.transaction(() => {
    for (const conv of exportMetas) {
      try {
        const baseVals = [conv.id, conv.assistantId || DEFAULT_ASSISTANT_ID, conv.title || "", "[]", conv.createAt || Date.now(), conv.updateAt || Date.now(), JSON.stringify(conv.chatSuggestions || []), conv.isPinned ? 1 : 0] as const;
        if (cspCol) {
          insertConv.run(...baseVals, conv.systemPrompt ? conv.systemPrompt : (cspCol.notnull ? "" : null));
        } else {
          insertConv.run(...baseVals);
        }
        const convNodes = liveDb ? loadConversationNodesFromDb(liveDb, conv.id) : [];
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
            // 安卓对齐批6(审查A P0):无判别符工具载荷包装成 text part,详见 wrapToolOutputEntriesForAndroid。
            if (fixed.type === "tool" && Array.isArray(fixed.output)) {
              fixed.output = wrapToolOutputEntriesForAndroid(fixed.output);
            }
            return fixed;
          });
          const msgs = (node.messages || []).map((m: any) => ({ id: m.id || null, role: String(m.role || "user").toLowerCase(), parts: fixParts(m.parts || []), annotations: m.annotations || [], createdAt: toLocalDt(m.createdAt), finishedAt: toLocalDt(m.finishedAt), modelId: m.modelId || null, usage: m.usage || null, translation: m.translation || null }));
          const nodeJson = JSON.stringify(msgs);
          insertNode.run(node.id, conv.id, i, backupNameById ? rewritePcUrlsToAndroidUpload(nodeJson, backupNameById) : nodeJson, node.selectIndex ?? 0);
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
// 收集全系统对文件 id 的引用:state 全量 JSON(设置头像/生图画廊 url 等)+ 活库全部节点
// messages(消息附件/工具输出图)+ generatedImages.fileId 数字引用。宁可多留不可错删:
// 引用扫描为并集,只有任何形态都未命中的条目(孤儿:删会话不删文件、画廊截断遗留等)
// 才不进备份。调用方需先 flushConvDirtyNow() 保证活库为最新。
// ── 5-2 自适应压缩超时 ─────────────────────────────────────────
// 固定 120s 在多 GB 附件库 + 机械盘上必然超时(进程被杀,导出报 "Zip creation
// failed")。按暂存目录实际体积折算:基础 120s + 按 8 MB/s 保守压缩吞吐每 MB
// 加 125ms,上限 30 分钟。导入侧解压本就无超时,导出侧对齐为"够用而有界"。
export function adaptiveZipTimeoutMs(totalBytes: number): number {
  const BASE_MS = 120_000;
  const MS_PER_MB = 125;
  const CAP_MS = 30 * 60_000;
  return Math.min(BASE_MS + Math.round((totalBytes / (1024 * 1024)) * MS_PER_MB), CAP_MS);
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

// ── 5-3 附件暂存失败不再静默吞 ─────────────────────────────────
// 磁盘满/文件名含 Windows 非法字符时 writeFileSync 失败,原实现只 console.warn,
// 用户拿到"看似成功"的不完整备份。改为计数返回,由调用方 reportError 上报
// (与 missingSkipped 同等待遇——staging 写失败恰恰是更严重的那种)。
export function stageUploadFilesInto(
  uploadStage: string,
  copies: Array<{ srcPath: string; name: string }>,
  onProgress?: (msg: string) => void,
): { staged: number; failed: number; firstError?: string } {
  let staged = 0;
  let failed = 0;
  let firstError: string | undefined;
  let done = 0;
  for (const { srcPath, name } of copies) {
    done++;
    onProgress?.(`正在打包附件 (${done}/${copies.length})...`);
    try {
      copyFileSync(srcPath, join(uploadStage, name)); // 5-7:同上
      staged++;
    } catch (copyErr) {
      failed++;
      if (!firstError) firstError = `${name}: ${copyErr}`;
      console.warn("[backup] failed to stage upload file", srcPath, copyErr);
    }
  }
  return { staged, failed, firstError };
}

// R1-13:数据目录卫生的孤儿附件统计复用本扫描器,导出。
export function collectReferencedFileIds(): Set<number> {
  const ids = new Set<number>();
  collectPcFileRefs(safeJsonStringify(state), ids);
  for (const img of state.generatedImages ?? []) {
    if (typeof img.fileId === "number") ids.add(img.fileId);
  }
  const db = getConversationsDb();
  if (db) {
    for (const row of db.prepare("SELECT messages FROM pc_message_node").all() as { messages: string }[]) {
      collectPcFileRefs(row.messages, ids);
    }
  }
  return ids;
}

type UploadStagingPlan = {
  copies: Array<{ srcPath: string; name: string }>;
  backupNameById: Map<number, string>;
  totalFiles: number;
  missingSkipped: number;
  orphanSkipped: number;
  dedupedCount: number;
};

// 批5:附件 staging 计划。①无引用孤儿不进备份;②内容 sha256 去重(只对尺寸碰撞组计算,
// 避免全量读盘两遍),重复内容共享同一 zip 内文件名——多个 id 的 backupName 指向同一份字节,
// 恢复端天然归并;③重名规避沿用 stem_<id>.ext。
// R4-6:备份 staging 文件名跨平台清洗。fileName 可能来自 Linux/安卓上传(那边 :*?"<>|
// 等字符合法),Windows 上 copyFileSync 会炸,该附件永远缺席备份且用户无解。backupName
// 与原名本就解耦(pc-backup.json 按 backupName 回链,manifest 与 zip 同源于同一产出),
// 清洗零副作用。四步:①非法字符与控制符 → _;②剥结尾点/空格(Windows 目录项非法尾缀);
// ③CON/PRN/AUX/NUL/COM1-9/LPT1-9 设备保留名(裸名或带任意扩展名)加 _ 前缀;④超长名
// 截干保尾缀(staging 与解包都落真实文件系统,常见上限 255 字节,150 字符对多字节留足余量)。
// 清洗后为空由调用方回退 <id>.<ext>;清洗后撞名由调用方 usedNames 去重兜底。
export function sanitizeStagingFileName(rawName: string): string {
  let name = rawName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = `_${name}`;
  if (name.length > 150) {
    const ext = extname(name);
    name = name.slice(0, 150 - ext.length) + ext;
  }
  return name;
}

function buildUploadStagingPlan(): UploadStagingPlan {
  const referenced = collectReferencedFileIds();
  const resolved: Array<{ file: (typeof state.files)[number]; srcPath: string; size: number }> = [];
  let missingSkipped = 0;
  let orphanSkipped = 0;
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
      missingSkipped++;
      continue;
    }
    if (!referenced.has(file.id)) {
      orphanSkipped++;
      continue;
    }
    // 5-7:existsSync↔statSync 窗口内文件被删(TOCTOU)按缺失跳过,不炸整个导出。
    try {
      resolved.push({ file, srcPath, size: statSync(srcPath).size });
    } catch {
      missingSkipped++;
    }
  }
  const sizeCount = new Map<number, number>();
  for (const r of resolved) sizeCount.set(r.size, (sizeCount.get(r.size) ?? 0) + 1);
  const usedNames = new Set<string>();
  const nameByHash = new Map<string, string>();
  const backupNameById = new Map<number, string>();
  const copies: Array<{ srcPath: string; name: string }> = [];
  let dedupedCount = 0;
  for (const { file, srcPath, size } of resolved) {
    const hash = (sizeCount.get(size) ?? 0) > 1 ? hashFileSha256(srcPath) : null;
    if (hash) {
      const prior = nameByHash.get(hash);
      if (prior) {
        backupNameById.set(file.id, prior);
        dedupedCount++;
        continue;
      }
    }
    // R4-6:跨平台清洗见 sanitizeStagingFileName(非法字符/尾缀/设备保留名/超长名)。
    const sanitized = sanitizeStagingFileName(file.fileName || "");
    let name = sanitized || `${file.id}${extname(srcPath) || ""}`;
    if (usedNames.has(name)) {
      const ext = extname(name);
      const stem = name.slice(0, name.length - ext.length);
      name = `${stem}_${file.id}${ext}`;
    }
    usedNames.add(name);
    if (hash) nameByHash.set(hash, name);
    backupNameById.set(file.id, name);
    copies.push({ srcPath, name });
  }
  return { copies, backupNameById, totalFiles: state.files.length, missingSkipped, orphanSkipped, dedupedCount };
}

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
    // 批5:先算附件 staging 计划(引用收集 + 内容去重 + zip 内文件名分配),让每个条目的
    // backupName 随 pc-backup.json 元数据导出,恢复端据此精确回链原 id。
    onProgress?.("正在分析附件引用...");
    flushConvDirtyNow();
    const uploadPlan = buildUploadStagingPlan();
    console.log(`[backup] staging pc-backup.json...`);
    writeFileSync(
      join(stageDir, "pc-backup.json"),
      safeJsonStringify(backupPayloadMetadataOnly(sanitizedSettings, uploadPlan.backupNameById)),
    );
    // 备份 2.0:PC 原生会话 dump——PC→PC 恢复的权威载体,与安卓模板解耦。活库已打开即
    // 无条件生成(零会话也写:恢复端以 dump 存在为准执行替换语义);安卓端导入对未知
    // 文件容忍跳过,不影响 PC→APP 通路。失败仅告警,老的 rikka_hub.db 通路仍在兜底。
    onProgress?.("正在导出会话数据库...");
    try {
      flushConvDirtyNow();
      const dumped = exportPcConversationsDump(join(stageDir, "pc_conversations.db"));
      if (dumped >= 0) console.log(`[backup] pc_conversations.db staged (${dumped} conversations)`);
    } catch (dumpErr) {
      reportError("backup", "error", "PC 会话库导出失败,zip 将缺少 pc_conversations.db(恢复将回退安卓格式库)", dumpErr);
    }
    if ((getConversationsDb() ? listAllConversationMetas(getConversationsDb()!).length : 0) > 0 || memoryStore.exportFlat().length > 0) {
      onProgress?.("正在生成对话数据库...");
      const dbPath = join(stageDir, "rikka_hub.db");
      try {
        const ok = generateRikkaHubDb(dbPath, uploadPlan.backupNameById);
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
    if (uploadPlan.copies.length > 0) {
      const uploadStage = join(stageDir, "upload");
      mkdirSync(uploadStage, { recursive: true });
      const stageResult = stageUploadFilesInto(uploadStage, uploadPlan.copies, onProgress);
      if (stageResult.failed > 0) {
        reportError("backup", "error", `${stageResult.failed}/${uploadPlan.copies.length} 个附件暂存失败(磁盘满或文件名含非法字符?),备份 zip 不完整。首个错误: ${stageResult.firstError}`);
      }
    }
    if (uploadPlan.missingSkipped > 0) {
      reportError("backup", "warn", `${uploadPlan.missingSkipped}/${uploadPlan.totalFiles} 个附件源文件缺失(路径失效或已删除),未包含在备份中`);
    }
    if (uploadPlan.orphanSkipped > 0 || uploadPlan.dedupedCount > 0) {
      console.log(`[backup] upload staging: 跳过 ${uploadPlan.orphanSkipped} 个无引用孤儿文件, 内容去重 ${uploadPlan.dedupedCount} 个`);
    }
    if (existsSync(skillsDir)) {
      onProgress?.("正在打包技能文件...");
      const skillsStage = join(stageDir, "skills");
      mkdirSync(skillsStage, { recursive: true });
      copyDirRecursive(skillsDir, skillsStage);
    }
    // 安卓对齐批6:fonts/ 透传(安卓 2.4.2 新增自定义聊天字体)。PC 不消费,仅忠实搬运,
    // 保证 APP→PC→APP 往返不丢字体文件(导入侧对应 importFontsDirIfPresent)。
    const fontsDir = join(dataDir, "fonts");
    if (existsSync(fontsDir)) {
      const fontsStage = join(stageDir, "fonts");
      mkdirSync(fontsStage, { recursive: true });
      copyDirRecursive(fontsDir, fontsStage);
    }
    onProgress?.("正在压缩...");
    if (existsSync(targetZipPath)) rmSync(targetZipPath);
    const zipTimeoutMs = adaptiveZipTimeoutMs(dirSizeBytes(stageDir));
    console.log(`[backup] creating zip from ${stageDir} → ${targetZipPath} (${readdirSync(stageDir).join(", ")})`);
    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `[System.IO.Compression.ZipFile]::CreateFromDirectory('${stageDir.replace(/'/g, "''")}', '${targetZipPath.replace(/'/g, "''")}')`,
      ].join("; ");
      const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: zipTimeoutMs });
      if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 500);
        const stdout = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).slice(0, 200);
        console.error("[backup] zip creation failed, exit:", proc.exitCode, "stderr:", stderr, "stdout:", stdout);
        throw new Error(`Zip creation failed (exit ${proc.exitCode}): ${stderr || stdout || "unknown error"}`);
      }
    } else {
      const proc = Bun.spawnSync(["zip", "-rq", targetZipPath, "."], { cwd: stageDir, timeout: zipTimeoutMs });
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
