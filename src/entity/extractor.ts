import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryInferencer } from "../system/types.js";
import type { EntityExtractor, ExtractedEntity } from "./types.js";
import { leafmemEnv } from "../system/env-compat.js";

// ---------------------------------------------------------------------------
// Known technology / tool dictionaries
// ---------------------------------------------------------------------------

const KNOWN_TECH: Set<string> = new Set([
  "typescript", "javascript", "python", "rust", "go", "java", "kotlin", "swift",
  "react", "vue", "angular", "svelte", "next.js", "nextjs", "nuxt", "vite",
  "node.js", "nodejs", "deno", "bun",
  "postgresql", "mysql", "sqlite", "mongodb", "redis", "qdrant",
  "docker", "kubernetes", "terraform",
  "graphql", "rest", "grpc", "websocket",
  "tailwindcss", "css", "html",
  "supabase", "firebase", "aws", "gcp", "azure",
  "openai", "gemini", "claude", "anthropic",
  "langchain", "crewai", "vercel",
]);

const KNOWN_TOOLS: Set<string> = new Set([
  "pnpm", "npm", "yarn", "bun", "cargo", "pip", "poetry",
  "git", "github", "gitlab", "bitbucket",
  "vim", "neovim", "vscode", "cursor", "zed",
  "eslint", "prettier", "biome", "vitest", "jest",
  "docker", "make", "cmake",
]);

// ---------------------------------------------------------------------------
// Rule-based entity extractor (zero LLM dependency)
// ---------------------------------------------------------------------------

// 🔴 2026-10-21：\w 不含中文，中文 @mention 原先只匹配到首字（中文人名永远抽不出）——
//    扩展字符类含 CJK 统一表意文字
const MENTION_RE = /@([\w一-鿿][\w一-鿿.-]*[\w一-鿿]|[\w一-鿿])/g;
const QUOTED_RE = /["""]([^"""]+?)["""]/g;
const PASCAL_CASE_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

// ---------------------------------------------------------------------------
// Controlled vocabulary (custom, 2026-08-07 P0-1)
// ---------------------------------------------------------------------------
// Loads a domain vocabulary from a JSON file ({ entities: { name: { kind } } }).
// Default path: ~/.leafmem/entity-vocab.json, override via LEAFMEM_ENTITY_VOCAB.
// In "strict" mode only the controlled vocab + KNOWN_TECH/TOOLS + @mentions are
// used; quoted-string and PascalCase heuristics are skipped (they produce noise
// entities for Chinese work content).

type VocabEntry = { name: string; kind: ExtractedEntity["kind"] };

function defaultVocabPath(): string {
  return join(homedir(), ".leafmem", "entity-vocab.json");
}

function loadControlledVocab(path: string | undefined): VocabEntry[] {
  const file = path ?? leafmemEnv("ENTITY_VOCAB") ?? defaultVocabPath();
  try {
    if (!existsSync(file)) {
      return [];
    }
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      entities?: Record<string, { kind?: string }>;
    };
    const entries: VocabEntry[] = [];
    for (const [name, meta] of Object.entries(raw.entities ?? {})) {
      const kind = (meta?.kind ?? "project") as ExtractedEntity["kind"];
      entries.push({ name, kind });
    }
    // Longer names first so "bge-reranker-v2-m3" wins over "bge-m3".
    return entries.sort((a, b) => b.name.length - a.name.length);
  } catch {
    return [];
  }
}


// ---------------------------------------------------------------------------
// Mention/name validation (2026-08-08 noise fixes)
// ---------------------------------------------------------------------------
// @mentions were producing garbage entities: version numbers from
// "pkg@0.1.1", domains from emails/URLs ("@qq.com"), bare digits from dates.
const VERSION_RE = /^\d+(\.\d+)+$/;          // 0.1.1 / 1.2.3.4
const BARE_NUMBER_RE = /^\d+$/;                 // 3 / 21
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z]{2,})+$/i; // qq.com / agent.qq.com
const GENERIC_MENTIONS = new Set([
  "media", "rest", "www", "http", "https", "com", "cn", "org", "net", "localhost",
]);
// 🔴 2026-10-21：@mention 噪声拦截四件套（person 准确率修复，实测 22 person 中 18 噪声）
const NOISE_MENTIONS = new Set([
  // 字段名/标签词/文档结构词（实测误抽）
  "paraid", "idref", "version", "mention", "skill", "image", "latest", "group",
  "type", "name", "id", "ref", "tag", "tags", "label", "status", "level", "kind",
  "date", "time", "author", "owner", "user", "users", "all", "here", "channel",
  "github", "npm", "docker", "playwright", "sqlite", "neo4j", "weknora",
]);
// 形态噪声：时长(120s/210s/30min)、编号(2K/v3/x1)
const NOISE_MENTION_RE = /^(?:\d+(?:\.\d+)?(?:s|m|min|h|d|k|w|ms)|\d+[kmw]|v\d+.*)$/i;
// 命名空间/包名形态：下划线/点多段小写标识（clawhub_yhongm / user_15d05850）
const NAMESPACE_LIKE_RE = /^[a-z0-9]+(?:[_][a-z0-9]+)+$/;
// 🔴 person 似然（2026-10-21）：中文 2-4 字 / 首大写英文名 / 全小写纯字母单词；
//    驼峰字段名(paraId)/全大写(GROUP)/带下划线/带数字 一律不像人名
const PERSON_LIKE_RE = /^(?:[一-鿿]{2,4}|[A-Z][a-z]+(?:[- ][A-Z][a-z]+)*|[a-z]{2,20})$/;
const TOOL_PRODUCT_MENTIONS = new Set([
  "ima", "larksuite", "workbuddy-buddy", "feishu", "wecom", "wechat",
]);
// 已知包名/命名空间（实测误抽为 person 的 ID 形态）
const KNOWN_NAMESPACES = new Set(["xdragonjia", "earl-chen", "clawhub"]);
// 🔴 中文非人名停用词（通用词，过 PERSON_LIKE 形态但不是人名）。
//    业务/领域专有词（如巡视整改领域）**不硬编码进引擎**——放本机受控词表
//    entity-vocab.json（step 0 优先命中，kind=project 即拦截 person 误建），
//    保持引擎通用性与发布卫生（2026-10-21 发布审计拦截后设计修正）。
const CHINESE_NON_PERSON = new Set([
  "公司", "集团", "部门", "组织", "管理", "工作", "学习", "教育",
  "报告", "方案", "问题", "会议", "通知", "办法", "规定", "清单", "台账", "材料",
  "文档", "知识", "记忆", "技能", "任务", "项目", "数据", "系统", "平台", "工具",
]);

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

function isNoiseMention(name: string): boolean {
  const n = name.trim();
  return (
    VERSION_RE.test(n) || BARE_NUMBER_RE.test(n) || GENERIC_MENTIONS.has(n.toLowerCase())
  );
}

function isDomainLike(name: string): boolean {
  return DOMAIN_RE.test(name.trim()) && !/\s/.test(name);
}

export class RuleBasedEntityExtractor implements EntityExtractor {
  private vocab: VocabEntry[];

  constructor(options?: { vocabPath?: string; strict?: boolean }) {
    // Custom (P0-1 fix, 2026-08-07): the controlled vocabulary is only loaded
    // when explicitly requested (strict mode, an explicit vocabPath, or the
    // LEAFMEM_ENTITY_VOCAB env override). A bare `new RuleBasedEntityExtractor()`
    // keeps the original upstream behavior — otherwise a vocab entry (e.g.
    // "leafmem" as a tool) would shadow the quoted-string heuristic for every
    // default-constructed user and change extracted entity kinds (test
    // regression: "LeafMem" quoted project was being masked by the tool vocab).
    const wantsVocab =
      options?.strict === true ||
      options?.vocabPath !== undefined ||
      leafmemEnv("ENTITY_VOCAB") !== undefined;
    this.vocab = wantsVocab ? loadControlledVocab(options?.vocabPath) : [];
    this.strict = options?.strict ?? false;
    // 🔴 2026-10-21 词表热加载（小龙问"通过接口可以动态更新呢"）：记词表路径+mtime，
    // 每次 extract 检查 mtime 变化即重载——宿主更新词表无需重启服务（原实现构造时
    // 一次性加载，导出新词表后必须重启才生效，是"动态更新"的断点）
    this.vocabPath = wantsVocab
      ? (options?.vocabPath ?? leafmemEnv("ENTITY_VOCAB") ?? defaultVocabPath())
      : undefined;
    this.vocabMtime = this.vocabPath ? safeMtime(this.vocabPath) : -1;
  }

  private readonly strict: boolean;
  private readonly vocabPath?: string;
  private vocabMtime: number;

  async extract(text: string): Promise<ExtractedEntity[]> {
    // 🔴 词表热加载：mtime 变化即重载（宿主动态更新词表无需重启服务）
    if (this.vocabPath) {
      const mt = safeMtime(this.vocabPath);
      if (mt !== this.vocabMtime) {
        this.vocab = loadControlledVocab(this.vocabPath);
        this.vocabMtime = mt;
      }
    }
    const entities: Map<string, ExtractedEntity> = new Map();
    const lower = text.toLowerCase();

    // 0. Controlled domain vocabulary (highest priority)
    // 🔴 2026-10-21 边界判据：CJK 短名（≤2 字）裸文本 includes 会子串误命中
    //    （实测"国王健康椅"→person"王健"）——2 字中文名只在 @mention 形态命中；
    //    ≥3 字名子串误命中概率极低，保留 includes（语义层权威人名主要靠此通道）
    for (const entry of this.vocab) {
      const key = entry.name.toLowerCase();
      const isShortCjk = entry.name.length <= 2 && /[\u4e00-\u9fff]/.test(entry.name);
      const hit = isShortCjk ? lower.includes(`@${key}`) : lower.includes(key);
      if (hit && !entities.has(key)) {
        entities.set(key, { name: entry.name, kind: entry.kind });
      }
    }

    // 1. Known tech names
    for (const tech of KNOWN_TECH) {
      if (lower.includes(tech)) {
        const key = tech.toLowerCase();
        if (!entities.has(key)) {
          entities.set(key, { name: tech, kind: "tech" });
        }
      }
    }

    // 2. Known tools
    for (const tool of KNOWN_TOOLS) {
      if (lower.includes(tool) && !entities.has(tool.toLowerCase())) {
        entities.set(tool.toLowerCase(), { name: tool, kind: "tool" });
      }
    }

    // 3. @mentions → person (with noise guards: versions/domains/digits are
    //    not people; domain-like mentions become org instead)
    // 🔴 2026-10-21 小龙指出 person 实体很不准（22 个里 18 个是噪声）：
    //    根因＝@任意词都建 person，守卫只挡版本号/纯数字/7 个泛词。实测噪声四类：
    //    ① 字段名/标签词（paraId/idref/version/mention/skill/image/latest/GROUP）
    //    ② 时长/编号（120s/210s/2K）③ 产品/工具名（ima/larksuite/workbuddy-buddy）
    //    ④ 包名/命名空间（xdragonjia/clawhub_*/user_15d05850/earl-chen 式 ID）。
    //    修复：噪声词表+形态正则+工具产品词表拦截；包名/命名空间形态→namespace（新 kind，
    //    EntityKind 开放枚举允许）；strict 模式（生产 MCP 用 strict:true）下 @mention 一律
    //    不新建 person，只认受控词表——person 宁可少不可错。
    for (const match of text.matchAll(MENTION_RE)) {
      const name = match[1]!;
      const key = name.toLowerCase();
      if (entities.has(key) || KNOWN_TECH.has(key) || KNOWN_TOOLS.has(key)) continue;
      if (isNoiseMention(name)) continue;
      if (isDomainLike(name)) {
        entities.set(key, { name, kind: "org" });
        continue;
      }
      if (NOISE_MENTIONS.has(key) || NOISE_MENTION_RE.test(name)) continue;
      if (TOOL_PRODUCT_MENTIONS.has(key)) {
        entities.set(key, { name, kind: "tool" });
        continue;
      }
      if (NAMESPACE_LIKE_RE.test(name) || KNOWN_NAMESPACES.has(key)) {
        entities.set(key, { name, kind: "namespace" });
        continue;
      }
      if (!PERSON_LIKE_RE.test(name)) continue; // 形态不像人名=不建 person
      if (CHINESE_NON_PERSON.has(name)) continue; // 中文领域词≠人名
      // 🔴 2026-10-21 判据修正：strict 不再一刀切禁建 person（实测真人中文 mention 被挡）——
      //    通过形态+停用词+噪声三重过滤后的 @mention 可信，允许建 person
      entities.set(key, { name, kind: "person" });
    }

    if (this.strict) {
      // Strict mode: skip noisy heuristics (quoted strings / PascalCase).
      return [...entities.values()];
    }

    // 4. Quoted strings that look like project names
    for (const match of text.matchAll(QUOTED_RE)) {
      const name = match[1]!.trim();
      const key = name.toLowerCase();
      if (
        name.length >= 2 &&
        name.length <= 40 &&
        !entities.has(key) &&
        !VERSION_RE.test(name) &&
        !BARE_NUMBER_RE.test(name)
      ) {
        entities.set(key, { name, kind: "project" });
      }
    }

    // 5. PascalCase compound words (likely class/project names)
    for (const match of text.matchAll(PASCAL_CASE_RE)) {
      const name = match[1]!;
      const key = name.toLowerCase();
      if (!entities.has(key) && !KNOWN_TECH.has(key)) {
        entities.set(key, { name, kind: "tech" });
      }
    }

    return [...entities.values()];
  }
}

// ---------------------------------------------------------------------------
// LLM-based entity extractor
// ---------------------------------------------------------------------------

const NER_SYSTEM_PROMPT = `Extract named entities from the text. Return JSON array:
[{"name": "...", "kind": "person|project|tech|tool|org", "aliases": ["..."]}]
Only extract specific, meaningful entities. Skip generic terms. Maximum 8 entities.`;

export class LlmEntityExtractor implements EntityExtractor {
  private readonly inferencer: MemoryInferencer;
  private readonly fallback = new RuleBasedEntityExtractor();

  constructor(inferencer: MemoryInferencer) {
    this.inferencer = inferencer;
  }

  async extract(text: string): Promise<ExtractedEntity[]> {
    if (text.trim().length < 10) {
      return [];
    }

    const result = await this.inferencer({
      kind: "entity_extraction",
      system: NER_SYSTEM_PROMPT,
      prompt: text,
      maxChars: 2000,
    });

    if (!result.ok) {
      return this.fallback.extract(text);
    }

    try {
      const parsed = JSON.parse(extractJsonArray(result.text));
      if (!Array.isArray(parsed)) {
        return this.fallback.extract(text);
      }
      return parsed
        .filter(
          (item: Record<string, unknown>) =>
            typeof item.name === "string" && typeof item.kind === "string",
        )
        .map((item: Record<string, unknown>) => ({
          name: String(item.name),
          kind: String(item.kind) as ExtractedEntity["kind"],
          aliases: Array.isArray(item.aliases)
            ? (item.aliases as string[]).filter((a) => typeof a === "string")
            : undefined,
        }));
    } catch {
      return this.fallback.extract(text);
    }
  }
}

function extractJsonArray(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1]!.trim();
  const brackets = text.match(/\[[\s\S]*\]/);
  if (brackets) return brackets[0];
  return text.trim();
}
