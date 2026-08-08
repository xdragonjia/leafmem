/**
 * Environment variable configuration helper (LeafMem).
 *
 * LeafMem reads configuration from LEAFMEM_* variables.
 *
 * Read sites MUST go through leafmemEnv(); write sites (installer-generated
 * host configs) use the LEAFMEM_* prefix directly.
 */
export function leafmemEnv(
  name: string,
  env: Record<string, unknown> = process.env,
): string | undefined {
  const value = env[`LEAFMEM_${name}`];
  return typeof value === "string" ? value : undefined;
}
