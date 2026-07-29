import { fetchJson } from "./base.js";

function modelFor(env, key, fallback) {
  return env[key] || fallback;
}

// Text generation takes the full conversation (`messages`: [{role: 'user'|'assistant',
// content}], ending with the latest user turn) so a reopened chat has real memory.
// Image generation only ever takes the latest prompt string — none of these REST APIs
// support image-to-image edits from a text history, so a follow-up like "make it
// bigger" has no way to reference the previous image through this path.
export const PROVIDERS = {
  anthropic: {
    supportsImages: false,
    isConfigured: (env) => Boolean(env.ANTHROPIC_API_KEY),
    model: (env) => modelFor(env, "ANTHROPIC_MODEL", "claude-sonnet-5"),

    async generateText(env, messages) {
      const model = this.model(env);
      const json = await fetchJson("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      const content = (json.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      return { content, provider: "anthropic", model };
    },
  },

  openai: {
    supportsImages: true,
    isConfigured: (env) => Boolean(env.OPENAI_API_KEY),
    model: (env) => modelFor(env, "OPENAI_MODEL", "gpt-4o"),
    imageModel: (env) => modelFor(env, "OPENAI_IMAGE_MODEL", "dall-e-3"),

    async generateText(env, messages) {
      const model = this.model(env);
      const json = await fetchJson("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, content: m.content })) }),
      });

      const content = json.choices?.[0]?.message?.content ?? "";
      return { content, provider: "openai", model };
    },

    async generateImage(env, prompt) {
      const model = this.imageModel(env);
      const json = await fetchJson("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model, prompt, n: 1 }),
      });

      const image = json.data?.[0];
      const content = image?.url ?? image?.b64_json ?? "";
      return { content, provider: "openai", model };
    },
  },

  xai: {
    supportsImages: true,
    isConfigured: (env) => Boolean(env.XAI_API_KEY),
    model: (env) => modelFor(env, "XAI_MODEL", "grok-4"),
    imageModel: (env) => modelFor(env, "XAI_IMAGE_MODEL", "grok-imagine-image"),

    // Grok doesn't pull live web/X data by default. Real-time grounding — the reason
    // Hive routes current-events queries here — requires xAI's Responses API with
    // web_search/x_search tools (their older "Live Search" chat-completions flag was
    // retired), so this uses /v1/responses rather than /v1/chat/completions.
    async generateText(env, messages) {
      const model = this.model(env);
      const json = await fetchJson("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.XAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          input: messages.map((m) => ({ role: m.role, content: m.content })),
          tools: [{ type: "web_search" }, { type: "x_search" }],
        }),
      });

      let content = json.output_text ?? "";
      if (!content && Array.isArray(json.output)) {
        content = json.output
          .flatMap((item) => item?.content ?? [])
          .filter((c) => c?.type === "output_text" || c?.type === "text")
          .map((c) => c.text)
          .join("\n");
      }
      if (Array.isArray(json.citations) && json.citations.length > 0) {
        content += `\n\nSources:\n${json.citations.map((c) => `- ${c}`).join("\n")}`;
      }

      return { content, provider: "xai", model };
    },

    async generateImage(env, prompt) {
      const model = this.imageModel(env);
      const json = await fetchJson("https://api.x.ai/v1/images/generations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.XAI_API_KEY}`,
        },
        body: JSON.stringify({ model, prompt, n: 1 }),
      });

      const image = json.data?.[0];
      const content = image?.url ?? image?.b64_json ?? "";
      return { content, provider: "xai", model };
    },
  },

  google: {
    supportsImages: false,
    isConfigured: (env) => Boolean(env.GOOGLE_API_KEY),
    model: (env) => modelFor(env, "GOOGLE_MODEL", "gemini-3.1-pro-preview"),

    async generateText(env, messages) {
      const model = this.model(env);
      // Gemini uses "model" rather than "assistant" for the assistant role.
      const contents = messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
      const json = await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_API_KEY}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents }),
        }
      );

      const content = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      return { content, provider: "google", model };
    },
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);
