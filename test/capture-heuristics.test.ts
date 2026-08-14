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

// 2026-08-14 identity rule v3 (structural positive test). Four real incidents:
// the \b-laden blacklist never fired between CJK chars, and any bare 我是
// anywhere — even quoted as a reference — triggered a store.
const INCIDENT_20260814 = [
  "刚才我是在班车上，所以连接的我的手机热点，现在我到家了，接入家里的网，昆仑小智直接就恢复正常了，你通过今天这么长时间的排查，有什么收获呢？",
  "刚发现，又把一条我发给你的话写成记忆了，是因为这句话里有“我是”这两个字吗？不能只根据这两个字识别呀，这个问题之前就出现过了",
  "问题还没有解决呢呀，而且刚才那句话又被记录进去了",
];

test("identity v3: quoted 我是 and transient-state 我是 store nothing (2026-08-14 incidents)", () => {
  for (const quote of INCIDENT_20260814) {
    const proposals = inferMemoryProposals({ userMessage: quote, assistantMessage: "" });
    assert.equal(proposals.filter((p) => p.kind === "identity").length, 0, quote.slice(0, 30));
  }
});

test("identity v3: real self-introductions still fire (start-cue, declarative, unquoted)", () => {
  const good = [
    "我是贾小龙，昆仑数智巡察办副主任",
    "你好，我是小虾的同事老王",
    "My name is Xiaolong, I work at Kunlun",
  ];
  for (const quote of good) {
    const proposals = inferMemoryProposals({ userMessage: quote, assistantMessage: "" });
    assert.ok(proposals.some((p) => p.kind === "identity"), quote.slice(0, 20));
  }
});
