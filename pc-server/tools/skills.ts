// tools/skills.ts — Skill 目录读写辅助
// 纪律：只依赖 foundation 路径与 fs，不读写 state。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../foundation/utils";
import { skillsDir } from "../foundation/paths";
import type { SkillMetadata } from "../foundation/types";

export function safeSkillDir(skillName: string) {
  const name = skillName.trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) return null;
  const root = resolve(skillsDir);
  const target = resolve(root, name);
  if (dirname(target) !== root) return null;
  return target;
}

export function safeSkillFile(skillName: string, relativePath: string) {
  if (!relativePath.trim()) return null;
  const dir = safeSkillDir(skillName);
  if (!dir) return null;
  const root = resolve(dir);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) return null;
  return target;
}

export function parseSkillFrontmatter(content: string) {
  const result: Record<string, string> = {};
  if (!content.startsWith("---")) return result;
  const match = content.slice(3).match(/\r?\n---(?:\r?\n|$)/);
  if (!match || match.index === undefined) return result;
  const yaml = content.slice(3, 3 + match.index).trim();
  for (const line of yaml.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^"|"$/g, "");
    if (key && value) result[key] = value;
  }
  return result;
}

function extractSkillBody(content: string) {
  if (!content.startsWith("---")) return content;
  const match = content.slice(3).match(/\r?\n---(?:\r?\n|$)/);
  if (!match || match.index === undefined) return content;
  return content.slice(3 + match.index + match[0].length).replace(/^[\r\n]+/, "");
}

export function skillMetadataFromFile(skillName: string): SkillMetadata | null {
  const file = safeSkillFile(skillName, "SKILL.md");
  if (!file || !existsSync(file)) return null;
  const content = readFileSync(file, "utf8");
  const frontmatter = parseSkillFrontmatter(content);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  if (!name || !description) return null;
  return {
    name,
    description,
    compatibility: frontmatter.compatibility,
    allowedTools: frontmatter["allowed-tools"]?.split(/\s+/).filter(Boolean) ?? [],
  };
}

export function listSkills(): SkillMetadata[] {
  mkdirSync(skillsDir, { recursive: true });
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => skillMetadataFromFile(entry.name))
    .filter(Boolean) as SkillMetadata[];
}

export function readSkillBody(skillName: string) {
  const file = safeSkillFile(skillName, "SKILL.md");
  if (!file || !existsSync(file)) return null;
  return extractSkillBody(readFileSync(file, "utf8"));
}

export function readSkillContent(skillName: string) {
  const file = safeSkillFile(skillName, "SKILL.md");
  if (!file || !existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

export function listSkillFiles(skillName: string) {
  const dir = safeSkillDir(skillName);
  if (!dir || !existsSync(dir)) return [];
  const root = resolve(dir);
  const result: Array<{ path: string; size: number; type: "file" | "directory" }> = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      const relativePath = resolve(full).slice(root.length + 1).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        result.push({ path: relativePath, size: 0, type: "directory" });
        visit(full);
      } else {
        result.push({ path: relativePath, size: statSync(full).size, type: "file" });
      }
    }
  };
  visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export function exportSkills() {
  return listSkills().map((skill) => ({ ...skill, content: readSkillContent(skill.name) ?? "" }));
}

export function importSkills(skills: unknown) {
  if (!Array.isArray(skills)) return;
  for (const item of skills) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? "").trim();
    const dir = safeSkillDir(name);
    if (!dir) continue;
    mkdirSync(dir, { recursive: true });
    const files = Array.isArray(record.files) ? record.files : [];
    if (files.length > 0) {
      for (const file of files) {
        if (!isRecord(file)) continue;
        const relativePath = String(file.path ?? "").replace(/\\/g, "/");
        if (!relativePath || relativePath.includes("..") || relativePath.startsWith("/")) continue;
        const target = resolve(dir, relativePath);
        if (!target.startsWith(resolve(dir))) continue;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, String(file.content ?? ""));
      }
      continue;
    }
    const content = String(record.content ?? "");
    if (content) writeFileSync(join(dir, "SKILL.md"), content);
  }
}

export function defaultSkillContent(name = "new-skill") {
  return `---\nname: ${name}\ndescription: Describe when this skill should be used\n---\n\nWrite the skill instructions here.\n`;
}
