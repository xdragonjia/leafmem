import test from "node:test";
import assert from "node:assert/strict";
import { inferMemoryProposals } from "../src/runtime/runtime.js";

// 2026-08-11 incident: the user's verbatim instruction "我是通过 proxifier 访问
// github 的，…你把这三行删除吧… @image#1:…" was stored as an identity memory
// because the bare 我是 cue fired and attachment markers survived. Regression
// tests use the real quote as fixture.
const REAL_INCIDENT_QUOTE =
  "我是通过proxifier访问github的，你刚才往 /etc/hosts 写入三条 GitHub 真实 IP，现在我用浏览器都无法访问github了，是不是与这个有关，你把这三行删除吧，proxifier中有关于fake ip address的说明你看看 @image#1:Clipboard_Screenshot.png";

test("identity branch ignores 我是+action phrasing (incident quote stores nothing)", () => {
  const proposals = inferMemoryProposals({ userMessage: REAL_INCIDENT_QUOTE, assistantMessage: "" });
  const identity = proposals.filter((p) => p.kind === "identity");
  assert.equal(identity.length, 0, JSON.stringify(proposals));
});

test("identity branch still fires on real self-introductions", () => {
  const proposals = inferMemoryProposals({ userMessage: "我是老王，负责项目管理的", assistantMessage: "" });
  assert.equal(proposals.filter((p) => p.kind === "identity").length, 1);
});

test("attachment markers are stripped from captured content", () => {
  const proposals = inferMemoryProposals({
    userMessage: "记住：发布后必须对账附件 @image#2:Clipboard_Screenshot-1.png",
    assistantMessage: "",
  });
  assert.ok(proposals.length > 0);
  for (const p of proposals) {
    assert.ok(!p.content.includes("@image"), p.content);
  }
});

test("preference/decision/remember branches unaffected by the identity guard", () => {
  const remember = inferMemoryProposals({ userMessage: "记住 sudo 密码在 SYSTEM.md", assistantMessage: "" });
  assert.ok(remember.some((p) => p.source === "explicit_remember"));
  const pref = inferMemoryProposals({ userMessage: "我更喜欢直接给方案", assistantMessage: "" });
  assert.ok(pref.some((p) => p.kind === "preference"));
});

// 2026-08-12 incident: a sanitized transcript remainder of "." passed the
// preference cue and was stored as a memory with content ".". Quality floor:
// no proposal may be stored when its content has no substantive payload.
test("quality floor: punctuation-only remainder stores nothing", () => {
  const proposals = inferMemoryProposals({ userMessage: "我更喜欢 .", assistantMessage: "" });
  assert.equal(proposals.length, 0, JSON.stringify(proposals));
  const dot = inferMemoryProposals({ userMessage: ".", assistantMessage: "" });
  assert.equal(dot.length, 0);
});

test("quality floor does not block real preferences", () => {
  const proposals = inferMemoryProposals({
    userMessage: "我更喜欢用绝对路径作为脚本参数",
    assistantMessage: "",
  });
  assert.equal(proposals.filter((p) => p.kind === "preference").length, 1);
});
