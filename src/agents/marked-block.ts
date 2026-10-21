/**
 * Marked instruction block writer for host identity files (SOUL.md etc.).
 *
 * Why this module exists (2026-10-21):
 *  - The old writer replaced the block in place with no backup, no version mark and no
 *    post-write assertion. A half-broken marker (start without end) fell through to the
 *    "append" branch and produced a SECOND block, bloating the file forever.
 *  - Identity files are user-authoritative: we may only touch OUR block. Every write must
 *    prove that everything outside the block is byte-identical.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const BLOCK_START = "<!-- leafmem-agent-instructions:start -->";
export const BLOCK_END = "<!-- leafmem-agent-instructions:end -->";

/** Bump when the block CONTENT contract changes (tests assert required tokens per version). */
export const BLOCK_VERSION = 3;

export const versionLine = (v: number = BLOCK_VERSION): string =>
  `<!-- leafmem-agent-instructions:version=${v} -->`;

export function detectVersion(block: string): number {
  const m = block.match(/leafmem-agent-instructions:version=(\d+)/);
  return m ? Number(m[1]) : 0;
}

export function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function readTextSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export type MarkedBlockResult = {
  changed: boolean;
  version: number;
  backupPath?: string;
  outerHash?: string;
};

export type MarkedBlockOptions = {
  /** Where to place a NEW block when the file has none yet (existing blocks keep their place). */
  position?: "top" | "bottom";
  /** Where pre-write snapshots go. Defaults to ~/.leafmem/backup/identity/<ts>/ */
  backupRoot?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
};

/**
 * Insert or replace the marked block, proving that the text outside the block never changes.
 * Throws on malformed markers instead of appending a duplicate block.
 */
export async function writeMarkedBlock(
  inputPath: string,
  block: string,
  options: MarkedBlockOptions = {},
): Promise<MarkedBlockResult> {
  // 🔴 rename(tmp, path) 会替换软链本身（软链变成普通文件），身份文件已统一为软链，
  // 因此必须先解析到真实目标再写。
  const path = await resolveWriteTarget(inputPath);
  const current = await readTextSafe(path);
  const startIndex = current.indexOf(BLOCK_START);
  const endIndex = current.indexOf(BLOCK_END);

  if (startIndex === -1 !== (endIndex === -1)) {
    throw new Error(
      `[leafmem] malformed instruction markers in ${path} ` +
        `(start=${startIndex}, end=${endIndex}). Refusing to write; fix the file manually.`,
    );
  }
  if (startIndex !== -1 && endIndex < startIndex) {
    throw new Error(`[leafmem] instruction end marker precedes start marker in ${path}; refusing to write.`);
  }

  let before: string;
  let after: string;
  let next: string;
  if (startIndex !== -1) {
    before = current.slice(0, startIndex).trimEnd();
    after = current.slice(endIndex + BLOCK_END.length).trimStart();
    next = `${[before, block, after].filter(Boolean).join("\n\n").replace(/\s+$/, "")}\n`;
  } else {
    const pos = options.position ?? "bottom";
    if (!current.trim()) {
      before = "";
      after = "";
      next = `${block}\n`;
    } else if (pos === "top") {
      before = "";
      after = current.trim();
      next = `${block}\n\n${after}\n`;
    } else {
      before = current.trimEnd();
      after = "";
      next = `${before}\n\n${block}\n`;
    }
  }

  const outerHash = sha(`${before.trim()}\u0000${after.trim()}`);

  if (next === current) {
    return { changed: false, version: detectVersion(block), outerHash };
  }

  let backupPath: string | undefined;
  if (current.trim()) {
    const root = options.backupRoot ?? join(homedir(), ".leafmem", "backup", "identity");
    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const dir = join(root, stamp);
    await mkdir(dir, { recursive: true });
    backupPath = join(dir, basename(path));
    await writeFile(backupPath, current, "utf8");
  }

  const tmp = `${path}.leafmem-tmp-${process.pid}`;
  await writeFile(tmp, next, "utf8");
  await rename(tmp, path);

  // Post-write proof: exactly one block, and the outer text is byte-identical.
  const written = await readTextSafe(path);
  verifySingleBlock(written, path);
  const wStart = written.indexOf(BLOCK_START);
  const wEnd = written.indexOf(BLOCK_END);
  const wBefore = written.slice(0, wStart).trimEnd();
  const wAfter = written.slice(wEnd + BLOCK_END.length).trimStart();
  const wHash = sha(`${wBefore.trim()}\u0000${wAfter.trim()}`);
  if (wHash !== outerHash) {
    throw new Error(
      `[leafmem] outer content changed while writing ${path} (before=${outerHash}, after=${wHash}). ` +
        `Original preserved at ${backupPath ?? "(no backup: file was empty)"}`,
    );
  }

  return { changed: true, version: detectVersion(block), backupPath, outerHash };
}

/** Assert the file contains exactly one well-formed block. */
export function verifySingleBlock(text: string, path = "<memory>"): void {
  const starts = text.split(BLOCK_START).length - 1;
  const ends = text.split(BLOCK_END).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`[leafmem] expected exactly 1 instruction block in ${path}, found start=${starts} end=${ends}`);
  }
}

/** True when `path` is a symlink whose target should be written instead. */
export async function resolveWriteTarget(path: string): Promise<string> {
  try {
    const { realpath } = await import("node:fs/promises");
    if (existsSync(path)) return await realpath(path);
  } catch {
    /* fall through: write to the literal path */
  }
  return path;
}
