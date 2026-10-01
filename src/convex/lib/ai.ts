/**
 * AI provider layer.
 *
 * All model calls go through `complete()` so the provider/model can be swapped
 * later by changing this one file. Keys stay server-side: this module is only
 * ever imported from "use node" Convex actions, which read them from
 * process.env. Nothing here is reachable from the browser bundle.
 *
 * Backed by the project's AI integration gateway (OpenAI-compatible chat
 * completions). Set ASTRA_AI_MODEL on the Convex deployment to override the
 * default model.
 */
import { vly } from "../../lib/vly-integrations";

const DEFAULT_MODEL = "gpt-4o-mini";
const FALLBACK_MAX_TOKENS = 1600;

export type CompletionResult =
  | { ok: true; text: string }
  | { ok: false; code: "ai_not_configured" | "ai_failed"; message: string };

interface Attempt {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

function friendlyFailure(raw: string): string {
  const message = raw.trim() || "The AI model returned an empty response.";
  if (/timeout|timed out|abort/i.test(message)) {
    return "The AI request timed out. Please try again.";
  }
  if (/rate limit|429|too many requests/i.test(message)) {
    return "The AI service is rate limited right now. Please try again shortly.";
  }
  if (/model|not found|404/i.test(message)) {
    return `The configured AI model is unavailable (${message.slice(0, 160)}).`;
  }
  return `AI request failed: ${message.slice(0, 240)}`;
}

/**
 * Runs one grounded completion. Tries the configured model first, then the
 * gateway default with minimal parameters, so a model-specific incompatibility
 * degrades into a working answer instead of an error screen.
 */
export async function complete(
  system: string,
  user: string,
): Promise<CompletionResult> {
  if (!process.env.VLY_INTEGRATION_KEY) {
    return {
      ok: false,
      code: "ai_not_configured",
      message:
        "AI API key is not configured. Set VLY_INTEGRATION_KEY for this Convex deployment, then try again.",
    };
  }

  const requestedModel = process.env.ASTRA_AI_MODEL?.trim() || DEFAULT_MODEL;
  const attempts: Attempt[] = [
    { model: requestedModel, temperature: 0.2, maxTokens: FALLBACK_MAX_TOKENS },
    {},
  ];

  let lastError = "";
  for (const attempt of attempts) {
    try {
      const response = await vly.ai.completion({
        ...(attempt.model ? { model: attempt.model } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(attempt.temperature !== undefined
          ? { temperature: attempt.temperature }
          : {}),
        ...(attempt.maxTokens !== undefined
          ? { maxTokens: attempt.maxTokens }
          : {}),
      });
      const text = response.data?.choices?.[0]?.message?.content?.trim();
      if (response.success && text) {
        return { ok: true, text };
      }
      lastError = response.error ?? "";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    // An auth/config problem will fail every attempt the same way.
    if (/api.?key|unauthori[sz]ed|forbidden|401|403/i.test(lastError)) break;
  }

  return { ok: false, code: "ai_failed", message: friendlyFailure(lastError) };
}
