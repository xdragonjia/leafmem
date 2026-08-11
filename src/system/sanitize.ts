/**
 * Sanitize host-captured turn text before it enters the memory store.
 *
 * Host transcripts embed system-injected boilerplate (SOUL.md, identity files,
 * `<system-reminder>` / `<additional_data>` / `<memory_and_skills_reminder>`
 * blocks, connector status lists) verbatim. If captured raw, the rule extractor
 * stores system boilerplate as durable "preferences" — real incident
 * 2026-08-11: two `turn_inference` records containing raw `<system-reminder>`
 * markup had to be deleted. This module is the server-side root-cause defense;
 * the hook bridge (ops/hooks/leafmem-hooks.mjs) carries an equivalent client-side
 * copy so garbage never even reaches the API.
 */

/**
 * Return the human-authored plain text of a captured message, or "" when
 * nothing human-authored remains.
 */
export function sanitizeCapturedText(text: string | undefined | null): string {
  if (typeof text !== "string" || !text.trim()) return "";
  let out = text;

  // 1. Prefer the <user_query> body when the host wraps the human message.
  const uq = out.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (uq?.[1] && uq[1].trim()) {
    out = uq[1];
  }

  // 2. Strip system-injected blocks.
  out = out
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<system-reminder[^>]*>(?![\s\S]*<\/system-reminder>)[\s\S]*/gi, " ")
    .replace(/<additional_data>[\s\S]*?<\/additional_data>/gi, " ")
    .replace(/<connector-status>[\s\S]*?<\/connector-status>/gi, " ")
    .replace(/<memory_and_skills_reminder>[\s\S]*?<\/memory_and_skills_reminder>/gi, " ")
    .replace(/<identity_context>[\s\S]*?<\/identity_context>/gi, " ")
    .replace(/<project_context>[\s\S]*?<\/project_context>/gi, " ")
    .replace(/<product_identity>[\s\S]*?<\/product_identity>/gi, " ")
    .replace(/<tone_and_style>[\s\S]*?<\/tone_and_style>/gi, " ")
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, " ")
    .replace(/<image[^>]*>[\s\S]*?<\/image>/gi, " ")
    .replace(/<image_local_path>[\s\S]*?<\/image_local_path>/gi, " ");

  const trimmed = out.trim();
  if (!trimmed) return "";
  // Guard: if the remainder still smells like injection scaffolding, skip.
  if (/^(#|##)\s*(SOUL\.md|IDENTITY\.md|USER\.md)/i.test(trimmed)) return "";
  if (/<(hook|user-context|memory\b)/i.test(trimmed.slice(0, 60))) return "";
  return trimmed;
}
