import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readMarkdownEntries(path: string): Promise<string[]> {
  try {
    return parseMarkdownEntries(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

export async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => `${dir}/${entry.name}`)
      .sort();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

export async function writeMarkdownListFile(
  path: string,
  entries: string[],
  maxChars?: number,
): Promise<void> {
  const rendered = renderMarkdownList(entries, maxChars);
  await writeText(path, rendered ? `${rendered}\n` : "");
}

export async function writeMarkdownBlocksFile(path: string, blocks: string[]): Promise<void> {
  const rendered = blocks.map((block) => block.trim()).filter(Boolean).join("\n\n").trim();
  await writeText(path, rendered ? `${rendered}\n` : "");
}

/** A line that introduces context but carries no fact alone: an orphan bold
 * heading ("**发布能力**"), a bold heading ending with a colon ("**硬规则**："),
 * or a short colon-ended lead line ("主动服务分为两类："). Bare-word leads like
 * "Notes:" also qualify. Such lines become prefixes for the entries that follow. */
function isContextIntro(line: string): boolean {
  // List markers are handled by the bullet/ordered branches — a bullet whose
  // text ends with a colon is a colon-lead item, not a bare intro line.
  if (/^[-*+]\s/.test(line)) return false;
  if (/^\d+\.\s/.test(line)) return false;
  if (/^(\*\*|__)[^*_]+(\*\*|__)[：:]?$/.test(line)) return true;
  if (/^[^#*`\n]{1,24}[：:]$/.test(line)) return true;
  return false;
}

export function parseMarkdownEntries(content: string): string[] {
  const lines = content.replace(/\r/g, "").split("\n");
  const entries: string[] = [];
  const paragraph: string[] = [];
  let inFrontmatter = false;
  let inCodeFence = false;
  // 2026-08-11: a line that is only a bold/underlined heading (e.g. "**发布能力**",
  // "**硬规则**：") carries no fact on its own. Instead of importing it as a
  // fragment, hold it and prefix it onto the FOLLOWING entries (until a blank
  // line or the next heading ends the group) so each entry stays self-contained.
  let pendingHeading = "";
  // 2026-08-11: nested bullets (deeper indent than the last top-level bullet)
  // are sub-points of their parent — appending them (numbering intact) keeps
  // the parent entry a complete unit instead of sharding the list.
  let lastBulletIndent = -1;

  const emit = (entry: string, keepHeading: boolean) => {
    if (!entry) return;
    entries.push(pendingHeading ? `${pendingHeading} ${entry}` : entry);
    if (!keepHeading) pendingHeading = "";
  };
  const indentOf = (raw: string) => raw.length - raw.trimStart().length;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const indent = indentOf(rawLine);
    if (!line && paragraph.length > 0) {
      emit(paragraph.join(" ").trim(), false);
      paragraph.length = 0;
      lastBulletIndent = -1;
      continue;
    }
    if (!line) {
      pendingHeading = "";
      lastBulletIndent = -1;
      continue;
    }
    if (!inFrontmatter && entries.length === 0 && paragraph.length === 0 && line === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === "---") {
        inFrontmatter = false;
      }
      continue;
    }
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    // H1 title is file-level context (too long to prefix); drop it.
    if (/^#\s/.test(line)) {
      continue;
    }
    // Sub-headings (## … ######) become context prefixes for the entries
    // that follow, so imported entries stay self-contained.
    if (/^#{2,6}\s+/.test(line)) {
      if (paragraph.length > 0) {
        emit(paragraph.join(" ").trim(), false);
        paragraph.length = 0;
      }
      pendingHeading = line.replace(/^#{2,6}\s+/, "").trim();
      lastBulletIndent = -1;
      continue;
    }
    // Structural dividers (--- / *** / ___) are not memories; drop them.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      continue;
    }
    // A context-intro line: orphan bold heading ("**发布能力**"), bold heading
    // with colon ("**硬规则**："), or short colon-ended lead ("主动服务分为两类：").
    // Never imported alone — held as prefix for the following group.
    if (isContextIntro(line)) {
      if (paragraph.length > 0) {
        emit(paragraph.join(" ").trim(), false);
        paragraph.length = 0;
      }
      pendingHeading = line;
      lastBulletIndent = -1;
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      if (paragraph.length > 0) {
        emit(paragraph.join(" ").trim(), false);
        paragraph.length = 0;
      }
      const text = bullet[1]?.trim() ?? "";
      handleItem(text, line, indent);
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      if (paragraph.length > 0) {
        emit(paragraph.join(" ").trim(), false);
        paragraph.length = 0;
      }
      const text = ordered[1]?.trim() ?? "";
      handleItem(text, line, indent);
      continue;
    }
    paragraph.push(line);
  }

  function handleItem(text: string, rawLine: string, indent: number) {
    // The item text may itself be a structural symbol wrapped in a bullet
    // (e.g. "- ---") — drop it like a top-level divider. A colon-ended bullet
    // ("主动服务分为两类：") is a parent that absorbs its nested sub-items,
    // staying one complete entry.
    if (!text || /^(-{3,}|\*{3,}|_{3,})$/.test(text)) return;
    if (lastBulletIndent >= 0 && indent > lastBulletIndent && entries.length > 0) {
      entries[entries.length - 1] += ` ${rawLine.trim()}`;
    } else {
      emit(text, true);
      lastBulletIndent = indent;
    }
  }

  if (paragraph.length > 0) {
    emit(paragraph.join(" ").trim(), false);
  }
  // A trailing orphan heading with no following entry carries no fact; drop it.

  // Note: no credential masking here. The memory library is a single-machine
  // store; local discipline files legitimately carry the user's own
  // credentials (e.g. a sudo password they chose to record). Masking them
  // would corrupt the user's own notes — they were never leaked anywhere.
  return entries.filter(Boolean);
}

export function renderMarkdownList(entries: string[], maxChars?: number): string {
  const newestFirst = entries.map((entry) => entry.trim()).filter(Boolean);
  if (!maxChars || maxChars <= 0) {
    return newestFirst.reverse().map((entry) => `- ${entry}`).join("\n");
  }

  const selected: string[] = [];
  let total = 0;
  for (const entry of newestFirst) {
    const line = `- ${entry}`;
    const nextTotal = total === 0 ? line.length : total + 1 + line.length;
    if (selected.length > 0 && nextTotal > maxChars) {
      break;
    }
    if (selected.length === 0 && line.length > maxChars) {
      selected.push(line.slice(0, maxChars).trimEnd());
      break;
    }
    selected.push(line);
    total = nextTotal;
  }
  return selected.reverse().join("\n");
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
