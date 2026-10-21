/**
 * Resolve the identity files the HOST actually reads.
 *
 * WorkBuddy ≥ 5.x runs a path service: `resolveWorkBuddyDir()` → `ensureUserDir()`,
 * which materialises a per-user persona directory `~/.workbuddy/user-<uuid>-personal/`
 * containing SOUL.md / IDENTITY.md / USER.md / MEMORY.md + workspace-state.json.
 * Only when that service is absent does the host fall back to `~/.workbuddy`.
 *
 * We used `~/.workbuddy/SOUL.md` unconditionally until 2026-10-21 — writing an
 * instruction block into a file the host never reads (and importing stale identity
 * content on install). This resolver mirrors the host logic instead of guessing.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SCOPED_DIR_RE = /^user-.*-personal$/;

export type IdentityTarget = {
  /** Directory that owns the identity files. */
  dir: string;
  /** True when a scoped per-user directory was selected. */
  scoped: boolean;
};

/**
 * Find the scoped persona directories under `base` (e.g. ~/.workbuddy).
 * A directory qualifies when it looks like a persona dir: it carries
 * workspace-state.json or the identity file itself.
 */
export function findScopedIdentityDirs(base: string, fileName: string): string[] {
  if (!existsSync(base)) return [];
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  return entries
    .filter((name) => SCOPED_DIR_RE.test(name))
    .map((name) => join(base, name))
    .filter((dir) => {
      try {
        if (!statSync(dir).isDirectory()) return false;
      } catch {
        return false;
      }
      return existsSync(join(dir, "workspace-state.json")) || existsSync(join(dir, fileName));
    })
    .sort((a, b) => {
      // Newest first: the active profile is the one most recently touched.
      const mt = (p: string) => {
        try {
          return statSync(join(p, "workspace-state.json")).mtimeMs;
        } catch {
          try {
            return statSync(p).mtimeMs;
          } catch {
            return 0;
          }
        }
      };
      return mt(b) - mt(a);
    });
}

/** Resolve `fileName` inside the host's real identity directory. */
export function resolveIdentityTarget(home: string, dotDir: string, fileName: string): IdentityTarget {
  const base = join(home, dotDir);
  const scoped = findScopedIdentityDirs(base, fileName);
  if (scoped.length > 0) return { dir: scoped[0], scoped: true };
  return { dir: base, scoped: false };
}

/** Convenience: absolute path of the identity file the host reads. */
export function resolveIdentityFile(home: string, dotDir: string, fileName: string): string {
  return join(resolveIdentityTarget(home, dotDir, fileName).dir, fileName);
}
