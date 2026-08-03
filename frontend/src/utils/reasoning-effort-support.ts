/**
 * `reasoning_effort` is only understood by reasoning-family models in the
 * upstream catalog. Sending it to a non-reasoning model produces a 400 on
 * some routes and is silently ignored on others — either way we drop it
 * client-side to avoid the confusion.
 *
 * The predicate is a coarse substring match against the model id (case-
 * insensitive) covering the known reasoning families in the Nimbus catalog
 * as of 2026-07. Unknown model strings default to `true` (advertise the
 * header, let the backend decide) so we don't accidentally hide the setting
 * for a new model the catalog just added.
 */
export function isReasoningEffortSupported(
  model?: string | null | undefined,
): boolean {
  if (!model) return true;
  const m = model.toLowerCase();

  // OpenAI reasoning families (o1 / o3 / o4 / gpt-5*)
  if (/\bo[134]\b/.test(m)) return true;
  if (m.includes("gpt-5")) return true;

  // Anthropic reasoning-capable
  if (m.includes("claude-opus-4")) return true;
  if (m.includes("claude-sonnet-4")) return true;
  if (m.includes("claude-4")) return true;
  if (m.includes("thinking")) return true;

  // Google Gemini reasoning tiers
  if (m.includes("gemini-2.5")) return true;
  if (m.includes("gemini-3")) return true;

  // DeepSeek reasoners
  if (m.includes("deepseek-reasoner")) return true;
  if (m.includes("deepseek-r1")) return true;
  if (m.includes("deepseek-v4-pro")) return true;

  // xAI Grok reasoning
  if (m.includes("grok-4")) return true;
  if (m.includes("grok") && m.includes("reason")) return true;

  // Qwen reasoning
  if (m.includes("qwen") && m.includes("reason")) return true;

  // Everything else — silently drop.
  return false;
}
