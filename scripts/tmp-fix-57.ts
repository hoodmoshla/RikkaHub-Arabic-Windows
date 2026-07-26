import { patch } from "./tmp-patch";

// ── ① file-refs:哈希改同步流式,>2GiB 附件不再撞 Buffer 上限 ──────
patch("pc-server/backup/file-refs.ts", [
  [
    `export function hashFileSha256(path: string): string | null {
  try {
    return hashBytesSha256(readFileSync(path));
  } catch {
    return null;
  }
}`,
    `// 5-7:分块流式哈希。此前 readFileSync 整读,单附件 >2GiB 撞 Node Buffer 上限直接抛错。
export function hashFileSha256(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const hash = createHash("sha256");
      const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
      let read: number;
      while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
      return hash.digest("hex");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}`,
  ],
]);

// ── ② export.ts:拷贝换 copyFileSync + statSync TOCTOU 护栏 + SQL 参数化 ──
patch("pc-server/backup/export.ts", [
  [
    `    } else {
      writeFileSync(destPath, readFileSync(srcPath));
      count += 1;
    }`,
    `    } else {
      copyFileSync(srcPath, destPath); // 5-7:内核级拷贝,>2GiB 不进 JS 堆
      count += 1;
    }`,
  ],
  [
    `    try {
      writeFileSync(join(uploadStage, name), readFileSync(srcPath));
      staged++;`,
    `    try {
      copyFileSync(srcPath, join(uploadStage, name)); // 5-7:同上
      staged++;`,
  ],
  [
    `    if (!referenced.has(file.id)) {
      orphanSkipped++;
      continue;
    }
    resolved.push({ file, srcPath, size: statSync(srcPath).size });`,
    `    if (!referenced.has(file.id)) {
      orphanSkipped++;
      continue;
    }
    // 5-7:existsSync↔statSync 窗口内文件被删(TOCTOU)按缺失跳过,不炸整个导出。
    try {
      resolved.push({ file, srcPath, size: statSync(srcPath).size });
    } catch {
      missingSkipped++;
    }`,
  ],
  [
    `    for (const m of metaRows) { try { db.exec(\`INSERT INTO android_metadata VALUES ('\${m.locale}')\`); } catch { /* */ } }
    for (const r of roomRows as any[]) { try { db.exec(\`INSERT INTO room_master_table VALUES (\${r.id}, '\${r.identity_hash}')\`); } catch { /* */ } }`,
    `    // 5-7:参数化。值来自曾导入的安卓库,字符串拼 SQL 理论上可向自己的导出产物注入。
    for (const m of metaRows) { try { db.prepare("INSERT INTO android_metadata VALUES (?)").run(m.locale); } catch { /* */ } }
    for (const r of roomRows as any[]) { try { db.prepare("INSERT INTO room_master_table VALUES (?, ?)").run(r.id, r.identity_hash); } catch { /* */ } }`,
  ],
  [
    `import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";`,
    `import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";`,
  ],
]);

// ── ③ import.ts:re-link 与安卓去重拷贝换 copyFileSync/流式哈希 ────
patch("pc-server/backup/import.ts", [
  [
    `        writeFileSync(targetPath, readFileSync(srcPath));`,
    `        copyFileSync(srcPath, targetPath); // 5-7:内核级拷贝,>2GiB 不进 JS 堆`,
  ],
  [
    `    const hashCache = new Map<string, string | null>();
    const findExistingByContent = (bytes: Uint8Array): number | undefined => {
      const candidates = existingBySize.get(bytes.byteLength);
      if (!candidates || candidates.length === 0) return undefined;
      const incomingHash = hashBytesSha256(bytes);
      for (const c of candidates) {
        let h = hashCache.get(c.path);
        if (h === undefined) {
          h = hashFileSha256(c.path);
          hashCache.set(c.path, h);
        }
        if (h !== null && h === incomingHash) return c.id;
      }
      return undefined;
    };
    let dedupedFiles = 0;
    for (const entry of readdirSync(uploadDir)) {
      const srcPath = join(uploadDir, entry);
      const stats = statSync(srcPath);
      if (!stats.isFile()) continue;
      const bytes = readFileSync(srcPath);
      const existingId = findExistingByContent(bytes);
      if (existingId !== undefined) {
        androidFilenameToPcId.set(entry, existingId);
        dedupedFiles += 1;
        continue;
      }
      const fileId = state.nextFileId++;
      const ext = extname(entry) || "";
      const targetName = \`\${fileId}\${ext}\`;
      const targetPath = join(filesDir, targetName);
      writeFileSync(targetPath, bytes);`,
    `    const hashCache = new Map<string, string | null>();
    // 5-7:此前整读字节进内存再哈希/写盘,>2GiB 附件撞 Buffer 上限;改按路径流式哈希+内核级拷贝。
    const findExistingByContent = (size: number, srcPath: string): number | undefined => {
      const candidates = existingBySize.get(size);
      if (!candidates || candidates.length === 0) return undefined;
      const incomingHash = hashFileSha256(srcPath);
      if (incomingHash === null) return undefined;
      for (const c of candidates) {
        let h = hashCache.get(c.path);
        if (h === undefined) {
          h = hashFileSha256(c.path);
          hashCache.set(c.path, h);
        }
        if (h !== null && h === incomingHash) return c.id;
      }
      return undefined;
    };
    let dedupedFiles = 0;
    for (const entry of readdirSync(uploadDir)) {
      const srcPath = join(uploadDir, entry);
      const stats = statSync(srcPath);
      if (!stats.isFile()) continue;
      const existingId = findExistingByContent(stats.size, srcPath);
      if (existingId !== undefined) {
        androidFilenameToPcId.set(entry, existingId);
        dedupedFiles += 1;
        continue;
      }
      const fileId = state.nextFileId++;
      const ext = extname(entry) || "";
      const targetName = \`\${fileId}\${ext}\`;
      const targetPath = join(filesDir, targetName);
      copyFileSync(srcPath, targetPath);`,
  ],
]);

// ── ④ storage.ts:畸形 WebDAV href 不炸列表 ────────────────────────
patch("pc-server/backup/storage.ts", [
  [
    `    const href = value("href");
    const displayName = value("displayname") || decodeURIComponent(href.replace(/\\/$/, "").split("/").pop() ?? "");`,
    `    const href = value("href");
    // 5-7:畸形 href(如裸 %)会让 decodeURIComponent 抛 URIError,炸掉整个列表接口;退回原文。
    const rawName = href.replace(/\\/$/, "").split("/").pop() ?? "";
    let decodedName = rawName;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch { /* 保留原文 */ }
    const displayName = value("displayname") || decodedName;`,
  ],
]);

// ── ⑤ storage.ts:S3 ListObjectsV2 分页 ──────────────────────────
patch("pc-server/backup/storage.ts", [
  [
    `export async function s3ListBackups(config: S3Config) {
  const prefix = \`\${s3Prefix()}backup_\`;
  const response = await s3Request(config, "GET", "", { query: { "list-type": "2", prefix } });
  const text = await response.text();
  if (!response.ok) throw new Error(\`S3 列表失败：\${response.status} \${text.slice(0, 500)}\`);
  const items: Array<{ href: string; displayName: string; size: number; lastModified: string }> = [];
  // Minimal XML scan — S3 ListObjectsV2 has one <Contents> element per object.
  const blocks = text.match(/<Contents>[\\s\\S]*?<\\/Contents>/g) ?? [];
  for (const block of blocks) {`,
    `export async function s3ListBackups(config: S3Config) {
  const prefix = \`\${s3Prefix()}backup_\`;
  const items: Array<{ href: string; displayName: string; size: number; lastModified: string }> = [];
  // 5-7:ListObjectsV2 单页最多 1000 个对象,按 continuation-token 翻页,长期用户的
  // 备份列表不再截断。上限 50 页(5 万对象)防畸形响应死循环。
  let continuationToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (continuationToken) query["continuation-token"] = continuationToken;
    const response = await s3Request(config, "GET", "", { query });
    const text = await response.text();
    if (!response.ok) throw new Error(\`S3 列表失败：\${response.status} \${text.slice(0, 500)}\`);
    collectS3Contents(text, items);
    const truncated = /<IsTruncated>true<\\/IsTruncated>/i.test(text);
    const tokenMatch = text.match(/<NextContinuationToken>([\\s\\S]*?)<\\/NextContinuationToken>/i);
    if (!truncated || !tokenMatch) break;
    continuationToken = stripXmlText(tokenMatch[1]);
  }
  items.sort((a, b) => Date.parse(b.lastModified || "") - Date.parse(a.lastModified || ""));
  return items;
}

function collectS3Contents(text: string, items: Array<{ href: string; displayName: string; size: number; lastModified: string }>): void {
  // Minimal XML scan — S3 ListObjectsV2 has one <Contents> element per object.
  const blocks = text.match(/<Contents>[\\s\\S]*?<\\/Contents>/g) ?? [];
  for (const block of blocks) {`,
  ],
  [
    `    items.push({
      href: fileKey,
      displayName,
      size: Number(sizeMatch?.[1] ?? 0),
      lastModified: lastMatch?.[1] ?? "",
    });
  }
  items.sort((a, b) => Date.parse(b.lastModified || "") - Date.parse(a.lastModified || ""));
  return items;
}`,
    `    items.push({
      href: fileKey,
      displayName,
      size: Number(sizeMatch?.[1] ?? 0),
      lastModified: lastMatch?.[1] ?? "",
    });
  }
}`,
  ],
]);

// ── ⑥ files.ts DELETE:物理文件与抽取旁车一并删除 ─────────────────
patch("pc-server/api/handlers/files.ts", [
  [
    `  const fileDelete = path.match(/^files\\/(\\d+)$/);
  if (fileDelete && request.method === "DELETE") {
    state.files = state.files.filter((item) => item.id !== Number(fileDelete[1]));
    saveState();
    return json({ status: "deleted" });
  }`,
    `  const fileDelete = path.match(/^files\\/(\\d+)$/);
  if (fileDelete && request.method === "DELETE") {
    const deleteId = Number(fileDelete[1]);
    const target = state.files.find((item) => item.id === deleteId);
    state.files = state.files.filter((item) => item.id !== deleteId);
    // 5-7:此前只删账本条目,物理字节永久残留(导出会跳过孤儿,纯磁盘泄漏)。
    // 历史去重条目可能共享同一路径,仅当无其余条目引用时才删字节;抽取旁车一并清。
    if (target?.path && !state.files.some((item) => item.path === target.path)) {
      try { unlinkSync(target.path); } catch { /* 不存在/被锁,忽略 */ }
    }
    try { unlinkSync(extractedTextPath(deleteId)); } catch { /* 无旁车 */ }
    saveState();
    return json({ status: "deleted" });
  }`,
  ],
  [
    `import { existsSync } from "node:fs";`,
    `import { existsSync, unlinkSync } from "node:fs";`,
  ],
  [
    `import { extractStoredFileText, writeExtractedTextSidecar } from "../../files/index";`,
    `import { extractStoredFileText, extractedTextPath, writeExtractedTextSidecar } from "../../files/index";`,
  ],
]);
