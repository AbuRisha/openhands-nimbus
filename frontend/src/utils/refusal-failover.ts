/**
 * What to do when a model refuses.
 *
 * A refusal is not an error and not an answer. Today it ends the turn and the
 * customer is left holding a paid-for request with nothing to show, and their
 * only move is to guess which of twenty-nine models would have said yes.
 *
 * THE PART THAT MATTERS IS THE REVERT
 * -----------------------------------
 * The obvious design — swap to a fallback model and carry on — is worse than it
 * looks. One refusal then silently changes the model for every REMAINING turn,
 * and nobody is told. A customer who chose Opus for a long task discovers
 * afterwards that turn three onward ran on something else, and the only
 * evidence is a bill. So a retry is scoped to the turn by default and the
 * original model is restored after it. Staying on the fallback is a separate,
 * deliberate choice.
 *
 * This module is pure: it decides, it does not switch. The mutation lives with
 * the caller so the decision can be tested without a conversation, a network,
 * or a model store.
 */

/** What a retry does to the conversation's model AFTER the turn completes. */
export type FailoverDirection =
  /** Use the fallback for this turn, then put the original back. */
  | "revert"
  /** Use the fallback and keep it for the rest of the session. */
  | "sticky";

export type FailoverChoice =
  | { kind: "retry"; model: string; direction: FailoverDirection }
  /** Let the customer rewrite the request rather than change the model. */
  | { kind: "edit" }
  /** Give up on this turn. Also what an unanswered prompt becomes. */
  | { kind: "cancel" };

/**
 * How long the prompt waits before answering itself.
 *
 * A modal that blocks forever is worse than one that gives up: an unattended
 * session would sit on an unanswered question indefinitely, holding the turn
 * open and looking hung. Cancelling is the safe default because it is the only
 * option that spends nothing and changes nothing.
 */
export const REFUSAL_PROMPT_TIMEOUT_MS = 300_000;

/**
 * Phrases that mean the model declined, as opposed to failed.
 *
 * Deliberately narrow. A false positive here is expensive in a way a false
 * negative is not: wrongly calling a real answer a refusal would offer to
 * re-run a turn that already succeeded, and bill for it. Missing one only
 * leaves today's behaviour, which is what happens anyway.
 */
const REFUSAL_MARKERS = [
  "i can't help with",
  "i cannot help with",
  "i can't assist with",
  "i cannot assist with",
  "i won't be able to help",
  "i'm not able to help with",
  "i am not able to help with",
  "i must decline",
];

/**
 * Does this text read as a refusal?
 *
 * Matched on a normalised copy so that curly apostrophes — which every model
 * emits and no hand-written marker list contains — do not silently defeat the
 * whole feature.
 */
export function looksLikeRefusal(text: string | null | undefined): boolean {
  if (!text) return false;
  const flat = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  return REFUSAL_MARKERS.some((marker) => flat.includes(marker));
}

export interface FallbackCandidate {
  /** Display name, as the picker shows it. */
  name: string;
  /** Provider-qualified id, e.g. `anthropic/claude-sonnet-5`. */
  model: string;
}

/**
 * Pick the model to offer instead.
 *
 * From a DIFFERENT provider wherever possible. Two models from one vendor share
 * a policy far more closely than two from different ones, so retrying Opus on
 * Sonnet is the least likely thing to change the answer — it burns a second
 * paid turn to be told no twice.
 *
 * Returns null when there is nothing meaningfully different to offer, and the
 * caller should say so rather than invent a choice.
 */
export function chooseFallback(
  currentModel: string | null | undefined,
  catalog: FallbackCandidate[],
): FallbackCandidate | null {
  if (catalog.length === 0) return null;

  const providerOf = (model: string) =>
    model.includes("/") ? model.split("/", 1)[0] : "";
  const currentProvider = currentModel ? providerOf(currentModel) : "";

  const others = catalog.filter((c) => c.model !== currentModel);
  if (others.length === 0) return null;

  // Catalog order is curated (strongest first per maker), so the first match
  // is the best available rather than an arbitrary one.
  const differentProvider = others.find(
    (c) => providerOf(c.model) !== currentProvider,
  );
  return differentProvider ?? others[0];
}

/**
 * The model to restore once a turn finishes, or null if nothing should change.
 *
 * Encoding this as a function rather than a flag keeps the rule in one place:
 * only a `revert` retry restores anything, and only when the model actually
 * moved. A sticky retry deliberately leaves the fallback in place, and edit and
 * cancel never switched in the first place.
 */
export function modelToRestoreAfterTurn(
  choice: FailoverChoice,
  originalModel: string | null | undefined,
): string | null {
  if (choice.kind !== "retry") return null;
  if (choice.direction !== "revert") return null;
  if (!originalModel || originalModel === choice.model) return null;
  return originalModel;
}
