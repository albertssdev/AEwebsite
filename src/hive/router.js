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
  general: ["openai", "anthropic", "google"],
};

export async function route(env, query, forceProvider) {
  const { taskType, reason } = classify(query);
  const chain = forceProvider ? [forceProvider] : ROUTES[taskType];
  const effectiveReason = forceProvider ? `forced to ${forceProvider} via override` : reason;
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
        ? await provider.generateImage(env, query)
        : await provider.generateText(env, query);

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
