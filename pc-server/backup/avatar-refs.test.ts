// issue4 回归网:头像引用跨端双向改写(WebDAV 备份恢复"头像丢失"的修复面,专题3 H-1)。
// 端到端(createSettingsBackupZipToPath / applyAndroidZipBackupFromPath)已用隔离数据目录
// 手工实证双向正确;涉全局 state 与真实落盘,不进单测。这里锁纯函数层:
//   PC→APP:avatar.type FQN 化 + /api/files/<id>/content 反写安卓 upload URI
//   APP→PC:FQN 回短格式 + file:///…/upload/<name> 改写 /api/files/<id>/content
import { describe, expect, test } from "bun:test";

import { rewriteAndroidFileUrlsDeep } from "./file-refs";
import {
  ANDROID_AVATAR_TYPE_TO_PC,
  PC_AVATAR_TYPE_TO_ANDROID,
  rewriteAvatarsInSettings,
  rewritePcUrlsToAndroidUpload,
} from "./export";

const IMAGE_FQN = "me.rerere.rikkahub.data.model.Avatar.Image";

describe("PC→APP:导出侧头像改写", () => {
  test("助手与用户头像:类型 FQN 化 + url 反写为安卓 upload URI", () => {
    const settings = {
      assistants: [{ id: "a1", avatar: { type: "url", url: "/api/files/7/content" } }],
      displaySetting: { userAvatar: { type: "url", url: "/api/files/7/content" } },
    };
    const typed = rewriteAvatarsInSettings(settings, PC_AVATAR_TYPE_TO_ANDROID);
    const rewritten = JSON.parse(
      rewritePcUrlsToAndroidUpload(JSON.stringify(typed), new Map([[7, "avatar.png"]])),
    );
    const expected = {
      type: IMAGE_FQN,
      url: "file:///data/user/0/me.rerere.rikkahub/files/upload/avatar.png",
    };
    expect(rewritten.assistants[0].avatar).toEqual(expected);
    expect(rewritten.displaySetting.userAvatar).toEqual(expected);
  });

  test("backupNameById 未命中的 id 原样保留(附件缺失不产出悬空 file:// 引用)", () => {
    const out = rewritePcUrlsToAndroidUpload(
      JSON.stringify({ url: "/api/files/99/content" }),
      new Map([[7, "avatar.png"]]),
    );
    expect(JSON.parse(out).url).toBe("/api/files/99/content");
  });
});

describe("APP→PC:导入侧头像改写", () => {
  test("FQN 回短格式 + file:// upload URI 改写为 /api/files/<id>/content", () => {
    const settings = {
      assistants: [{
        id: "a1",
        avatar: { type: IMAGE_FQN, url: "file:///data/user/0/me.rerere.rikkahub/files/upload/abc-123.png" },
      }],
      displaySetting: {
        userAvatar: { type: IMAGE_FQN, url: "file:///data/user/0/me.rerere.rikkahub/files/upload/abc-123.png" },
      },
    };
    const typed = rewriteAvatarsInSettings(settings, ANDROID_AVATAR_TYPE_TO_PC, "to-pc");
    const rewritten = rewriteAndroidFileUrlsDeep(
      typed,
      new Map([["abc-123.png", 3]]),
      { fileSchemeOnly: true },
    ) as typeof settings;
    const expected = { type: "url", url: "/api/files/3/content" };
    expect(rewritten.assistants[0].avatar).toEqual(expected);
    expect(rewritten.displaySetting.userAvatar).toEqual(expected);
  });

  test("fileSchemeOnly:普通文本里碰巧出现 upload/<名字> 不被误改", () => {
    const out = rewriteAndroidFileUrlsDeep(
      { systemPrompt: "see upload/abc-123.png for details" },
      new Map([["abc-123.png", 3]]),
      { fileSchemeOnly: true },
    ) as { systemPrompt: string };
    expect(out.systemPrompt).toBe("see upload/abc-123.png for details");
  });

  test("/data/data 前缀(部分 ROM 的 filesDir 直接路径)同样命中", () => {
    const out = rewriteAndroidFileUrlsDeep(
      { url: "file:///data/data/me.rerere.rikkahub/files/upload/abc-123.png" },
      new Map([["abc-123.png", 3]]),
      { fileSchemeOnly: true },
    ) as { url: string };
    expect(out.url).toBe("/api/files/3/content");
  });
});
