import { classify } from "./classifier.js";
import { PROVIDERS } from "./adapters.js";
import { isTechnicalFailure, describeError } from "./base.js";

/**
 * Priority order per task type, per the routing table in the Hive project doc.
 * Walked only on technical failure (outage, rate limit, timeout, missing key) —
 * a successful response, even a refusal, is returned as-is.
 */
export const ROUTES = {
  coding: ["anthropic", "google", "openai"],
  writing: ["anthropic", "google", "openai"],
  analysis: ["anthropic", "google", "openai"],
  agentic: ["anthropic", "google", "openai"],
  image: ["xai", "openai"],
  current_events: ["xai", "openai"],
  brainstorming: ["openai", "anthropic", "google"],
  multimodal: ["openai", "google"],
  long_context: ["google", "openai"],
  general: ["anthropic", "openai", "google"],
};

/**
 * `messages` is the full conversation so far ([{role, content}, ...], ending with the
 * latest user turn) — the web UI (unlike the CLI) supports reopening a chat with real
 * memory, so every provider call gets the whole thread, not just the latest message.
 *
 * `stickyProvider`, if given, is the provider that answered the previous turn in this
 * conversation. The classifier only looks at the latest message, so a contextless
 * follow-up like "make it bigger" has no keyword signal and would otherwise fall to
 * the generic "general" chain and possibly land on a different provider than the one
 * that has the actual context. When classification comes back "general" and a sticky
 * provider is available, that provider is tried first instead.
 */
export async function route(env, messages, forceProvider, stickyProvider) {
  const latestUserText = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const { taskType, reason } = classify(latestUserText);

  let chain;
  let effectiveReason;
  if (forceProvider) {
    chain = [forceProvider];
    effectiveReason = `forced to ${forceProvider} via override`;
  } else if (taskType === "general" && stickyProvider && PROVIDERS[stickyProvider]?.isConfigured(env)) {
    chain = [stickyProvider, ...ROUTES[taskType].filter((p) => p !== stickyProvider)];
    effectiveReason = `continuing conversation with ${stickyProvider} (no strong task signal in this message)`;
  } else {
    chain = ROUTES[taskType];
    effectiveReason = reason;
  }

  const attempts = [];

  for (const providerName of chain) {
    const provider = PROVIDERS[providerName];

    if (!provider.isConfigured(env)) {
      attempts.push({ provider: providerName, ok: false, error: "not configured (missing API key)" });
      continue;
    }

    try {
      const useImage = taskType === "image" && provider.supportsImages && provider.generateImage;
      const result = useImage
        ? await provider.generateImage(env, latestUserText)
        : await provider.generateText(env, messages);

      attempts.push({ provider: providerName, ok: true });
      return { taskType, reason: effectiveReason, attempts, result, failed: false };
    } catch (err) {
      if (isTechnicalFailure(err)) {
        attempts.push({ provider: providerName, ok: false, error: describeError(err) });
        continue;
      }
      // Not a technical failure — the provider responded, so surface it rather
      // than silently trying another model to get a different answer.
      throw err;
    }
  }

  return { taskType, reason: effectiveReason, attempts, failed: true };
}
