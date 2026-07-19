import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

type AnyRecord = Record<string, any>;

const rootDir = resolve(import.meta.dir, "../..");
const serverDir = join(rootDir, "pc-server");
const tempDir = join(rootDir, "pc-data", "smoke-backup-roundtrip");
const workDir = join(rootDir, "pc-data", "smoke-backup-roundtrip-work");
const pcPort = Number(process.env.SMOKE_PC_PORT ?? 18281);
const mockPort = Number(process.env.SMOKE_MOCK_PORT ?? 18282);
const baseUrl = `http://127.0.0.1:${pcPort}`;
const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

const ASSISTANT_NAME = "备份往返测试助手";
const NICKNAME = "备份测试用户";
const MEMORY_CONTENT = "这是全局记忆，用于验证备份往返。";
const MODEL_ID = "smoke-model";
const PROVIDER_ID = "smoke-provider";
const CONVERSATION_ID = "smoke-conversation";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function spawnPcServer() {
  return Bun.spawn(["bun", "run", "server.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(pcPort),
      RIKKAHUB_PC_DATA_DIR: tempDir,
      BROWSER: "none",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function startMockProvider() {
  return Bun.serve({
    port: mockPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = req.body;
        if (!body) return new Response("No body", { status: 400 });
        const text = await req.text();
        const parsed = text ? JSON.parse(text) : {};
        const content = "Hi from backup smoke.";
        if (parsed.stream) {
          const payload = JSON.stringify({
            id: "chatcmpl-smoke",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content } }],
          });
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return Response.json({
          id: "chatcmpl-smoke",
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

function seedAndroidSchemaCache(dataDir: string) {
  // 为备份 smoke 合成一个最小 Room 兼容 schema，使 generateRikkaHubDb 能产出 rikka_hub.db。
  // 该 schema 仅用于验证 PC→Android DB→PC 的往返管线，不声称与真实 APP schema 逐列一致。
  const { Database } = require("bun:sqlite");
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE android_metadata (locale TEXT);
    CREATE TABLE room_master_table (id INTEGER PRIMARY KEY, identity_hash TEXT);
    CREATE TABLE ConversationEntity (
      id TEXT PRIMARY KEY,
      assistant_id TEXT,
      title TEXT,
      nodes TEXT,
      create_at INTEGER,
      update_at INTEGER,
      suggestions TEXT,
      is_pinned INTEGER,
      custom_system_prompt TEXT
    );
    CREATE TABLE message_node (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      node_index INTEGER,
      messages TEXT,
      select_index INTEGER
    );
    CREATE TABLE MemoryEntity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assistant_id TEXT,
      content TEXT
    );
    INSERT INTO android_metadata VALUES ('en-US');
    INSERT INTO room_master_table VALUES (1, 'smoke-schema-hash');
  `);
  const bytes = db.serialize();
  db.close();
  const cachedPath = join(dataDir, "rikka_hub_cached.db");
  writeFileSync(cachedPath, Buffer.from(bytes));
}

async function waitForHealth(timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动
    }
    await Bun.sleep(200);
  }
  throw new Error("PC server did not become healthy");
}

async function api(path: string, init: RequestInit = {}) {
  const isJson = init.body && typeof init.body === "string";
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(isJson ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`API ${path} failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return body;
}

function apiJson(path: string, body: AnyRecord) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

async function seedState() {
  const settings: AnyRecord = await api("/api/settings");
  const assistant = settings.assistants[0];
  assert(assistant, "默认助手不存在");

  // 添加一个指向 mock 服务的 OpenAI 兼容 provider
  await apiJson("/api/settings/provider", {
    id: PROVIDER_ID,
    name: "Smoke Provider",
    type: "openai",
    enabled: true,
    baseUrl: mockBaseUrl,
    apiKey: "smoke-api-key",
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    models: [
      {
        id: MODEL_ID,
        modelId: MODEL_ID,
        displayName: "Smoke Model",
        type: "CHAT",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        abilities: [],
        tools: [],
      },
    ],
  });

  // 把默认助手绑定到 mock 模型，并改名
  await apiJson("/api/settings/assistant/detail", {
    ...assistant,
    name: ASSISTANT_NAME,
    chatModelId: MODEL_ID,
    systemPrompt: "你是一个专门用于备份往返测试的助手。",
  });

  await apiJson("/api/settings/display", { userNickname: NICKNAME });
  await apiJson("/api/settings/memory-settings", { globalEnabled: true, writeStrategy: "ask" });
  await apiJson("/api/memory/global", { content: MEMORY_CONTENT });

  // 发送一条用户消息触发对话创建与生成
  await apiJson(`/api/conversations/${CONVERSATION_ID}/messages`, {
    parts: [{ type: "text", text: "hello" }],
  });

  // 等待生成完成（mock 立即返回）
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const conversation: AnyRecord = await api(`/api/conversations/${CONVERSATION_ID}`);
    const hasAssistant = conversation.messages?.some((node: AnyRecord) =>
      node.messages?.some((m: AnyRecord) => m.role === "ASSISTANT")
    );
    if (hasAssistant) break;
    await Bun.sleep(200);
  }

  return { assistantId: assistant.id };
}

async function exportBackupZip(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/data/export`);
  assert(response.ok, `export failed: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const filename = response.headers.get("X-Export-Filename") ?? `rikkahub-backup-${Date.now()}.zip`;
  const zipPath = join(tempDir, filename);
  await Bun.write(zipPath, new Uint8Array(arrayBuffer));
  return zipPath;
}

function extractZip(zipPath: string, outDir: string) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  if (platform() === "win32") {
    const ps = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem;
      [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${outDir.replace(/'/g, "''")}');
    `;
    const result = spawnSync("powershell", ["-Command", ps], { encoding: "utf8" });
    assert(result.status === 0, `ZipFile.ExtractToDirectory failed: ${result.stderr}`);
  } else {
    const result = spawnSync("unzip", ["-q", "-o", zipPath, "-d", outDir], { encoding: "utf8" });
    assert(result.status === 0, `unzip failed: ${result.stderr}`);
  }
}

function repackageAndroidZip(extractDir: string, outPath: string) {
  rmSync(outPath, { force: true });
  if (platform() === "win32") {
    const workDir = join(tempDir, `android-repack-${Date.now()}`);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    cpSync(join(extractDir, "settings.json"), join(workDir, "settings.json"));
    cpSync(join(extractDir, "rikka_hub.db"), join(workDir, "rikka_hub.db"));
    if (existsSync(join(extractDir, "upload"))) {
      cpSync(join(extractDir, "upload"), join(workDir, "upload"), { recursive: true });
    }
    const ps = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem;
      [System.IO.Compression.ZipFile]::CreateFromDirectory('${workDir.replace(/'/g, "''")}', '${outPath.replace(/'/g, "''")}');
    `;
    const result = spawnSync("powershell", ["-Command", ps], { encoding: "utf8" });
    assert(result.status === 0, `ZipFile.CreateFromDirectory failed: ${result.stderr}`);
  } else {
    const entries = ["settings.json", "rikka_hub.db"];
    if (existsSync(join(extractDir, "upload"))) entries.push("upload");
    const result = spawnSync("zip", ["-q", "-r", outPath, ...entries], { cwd: extractDir, encoding: "utf8" });
    assert(result.status === 0, `zip failed: ${result.stderr}`);
  }
}

async function importZip(zipPath: string) {
  const file = Bun.file(zipPath);
  const response = await fetch(`${baseUrl}/api/data/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      "X-Filename": zipPath.split(/[\\/]/).pop() ?? "backup.zip",
    },
    body: file,
  });
  const text = await response.text();
  assert(response.ok, `import failed: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function verifyRestoredState() {
  const settings: AnyRecord = await api("/api/settings");
  assert(settings.assistants?.some((a: AnyRecord) => a.name === ASSISTANT_NAME), "助手未恢复");
  assert(settings.displaySetting?.userNickname === NICKNAME, "显示设置未恢复");
  assert(settings.memorySettings?.globalEnabled === true, "记忆设置未恢复");

  const memories: AnyRecord = await api("/api/memory/global");
  assert(memories.memories?.some((m: AnyRecord) => m.content === MEMORY_CONTENT), "全局记忆未恢复");

  const conversation: AnyRecord = await api(`/api/conversations/${CONVERSATION_ID}`);
  assert(conversation, "会话未恢复");
  const hasAssistant = conversation.messages?.some((node: AnyRecord) =>
    node.messages?.some((m: AnyRecord) => m.role === "ASSISTANT")
  );
  assert(hasAssistant, "助手回复未恢复");
}

async function main() {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  seedAndroidSchemaCache(tempDir);

  const mock = startMockProvider();
  let pc = spawnPcServer();
  let stdout = "";
  let stderr = "";
  pc.stdout.pipeTo(new WritableStream({ write: (chunk) => { stdout += new TextDecoder().decode(chunk); } })).catch(() => undefined);
  pc.stderr.pipeTo(new WritableStream({ write: (chunk) => { stderr += new TextDecoder().decode(chunk); } })).catch(() => undefined);

  try {
    await waitForHealth();
    console.log("[backup-smoke] 服务已启动");

    await seedState();
    console.log("[backup-smoke] 已写入测试状态（含会话）");

    // 1. PC → zip 导出，保存到 workDir 避免后续清空 tempDir 时被删
    const exportedZipPath = await exportBackupZip();
    const savedZipPath = join(workDir, "pc-backup.zip");
    cpSync(exportedZipPath, savedZipPath);
    console.log(`[backup-smoke] 已导出 PC 备份: ${savedZipPath}`);

    // 2. 验证 zip 内包含 Android 兼容文件（即 PC→Android DB 生成）
    const extractDir = join(workDir, "extracted");
    extractZip(savedZipPath, extractDir);
    assert(existsSync(join(extractDir, "settings.json")), "备份 zip 缺少 settings.json");
    assert(existsSync(join(extractDir, "rikka_hub.db")), "备份 zip 缺少 rikka_hub.db（Android 兼容库）");
    assert(existsSync(join(extractDir, "pc-backup.json")), "备份 zip 缺少 pc-backup.json");
    console.log("[backup-smoke] zip 结构校验通过");

    // 3. PC → zip → PC：清空数据后重新导入同一 zip
    pc.kill();
    await pc.exited.catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });

    pc = spawnPcServer();
    pc.stdout.pipeTo(new WritableStream({ write: (chunk) => { stdout += new TextDecoder().decode(chunk); } })).catch(() => undefined);
    pc.stderr.pipeTo(new WritableStream({ write: (chunk) => { stderr += new TextDecoder().decode(chunk); } })).catch(() => undefined);
    await waitForHealth();

    const pcImportResult = await importZip(savedZipPath);
    assert(pcImportResult.source === "android-zip" || pcImportResult.source === "pc-zip", `未知导入来源: ${pcImportResult.source}`);
    console.log(`[backup-smoke] PC→zip→PC 导入来源: ${pcImportResult.source}`);
    await verifyRestoredState();
    console.log("[backup-smoke] PC→zip→PC 状态校验通过");

    // 4. PC → Android DB → PC：用 settings.json + rikka_hub.db 重新打包成 Android zip 再导入
    pc.kill();
    await pc.exited.catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });

    const androidZipPath = join(workDir, "android-roundtrip.zip");
    repackageAndroidZip(extractDir, androidZipPath);
    assert(existsSync(androidZipPath), "Android zip 重新打包失败");
    console.log("[backup-smoke] 已重新打包 Android zip");

    pc = spawnPcServer();
    pc.stdout.pipeTo(new WritableStream({ write: (chunk) => { stdout += new TextDecoder().decode(chunk); } })).catch(() => undefined);
    pc.stderr.pipeTo(new WritableStream({ write: (chunk) => { stderr += new TextDecoder().decode(chunk); } })).catch(() => undefined);
    await waitForHealth();

    const androidImportResult = await importZip(androidZipPath);
    assert(androidImportResult.source === "android-zip", `Android zip 导入来源错误: ${androidImportResult.source}`);
    console.log(`[backup-smoke] PC→Android DB→PC 导入来源: ${androidImportResult.source}`);
    await verifyRestoredState();
    console.log("[backup-smoke] PC→Android DB→PC 状态校验通过");

    console.log(JSON.stringify({ ok: true, dataDir: tempDir }, null, 2));
  } catch (err) {
    console.error("[backup-smoke] 失败:", err instanceof Error ? err.message : String(err));
    if (stdout.trim()) console.error("[stdout]", stdout.slice(-2000));
    if (stderr.trim()) console.error("[stderr]", stderr.slice(-2000));
    process.exitCode = 1;
    throw err;
  } finally {
    pc.kill();
    await pc.exited.catch(() => undefined);
    mock.stop(true);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
