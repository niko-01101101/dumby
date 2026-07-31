import { ApiError, GoogleGenAI } from "@google/genai";
import { Ollama } from "ollama";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ChatConfig {
  ollamaModel: string;
  numCtx?: number;
  maxHistoryMessages?: number;
}

export interface ChatHandle {
  result: Promise<string>;
  abort: () => void;
}

const ollama = new Ollama();
// No explicit apiKey: on Node the SDK reads GEMINI_API_KEY/GOOGLE_API_KEY
// from process.env itself at construction time, and --env-file populates
// that before this module is ever imported.
const ai = new GoogleGenAI({});

// Three-tier degradation ladder: 0 = primary (geminiModel()), 1 = the
// "gemini-flash-lite-latest" fallback specifically, 2 = Ollama only. Sticky
// once it drops a level — see the top-of-file comment for why.
let geminiTier: 0 | 1 | 2 = 0;
const GEMINI_FALLBACK_MODEL = "gemini-flash-lite-latest";

function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? GEMINI_FALLBACK_MODEL;
}

class GeminiQuotaError extends Error { }

function trimHistory(messages: ChatMessage[], max: number | undefined): ChatMessage[] {
  if (!max || messages.length <= max) return messages;
  const [first, ...rest] = messages;
  if (!first) return messages;
  return [first, ...rest.slice(-(max - 1))];
}

type GeminiStep = { type: "user_input" | "model_output"; content: { type: "text"; text: string }[] };

// The Interactions API's `input` accepts either a "turn_list" (role-tagged
// turns) or a "step_list" (user_input/model_output steps) shape — this
// project is on a steps-based API version, which rejects turn_list outright
// (400: "use step_list input format instead of turn_list"), confirmed
// against the live endpoint. This codebase's history reuses role "system"
// for repeated in-conversation reminders, not just an upfront prompt (see
// editor.ts/contentCreator.ts callers), so "system" maps to "user_input"
// here too, with consecutive same-role messages merged into one step since
// the API expects them to alternate.
function toGeminiSteps(messages: ChatMessage[]): GeminiStep[] {
  const steps: GeminiStep[] = [];
  for (const msg of messages) {
    const type: GeminiStep["type"] = msg.role === "assistant" ? "model_output" : "user_input";
    const last = steps[steps.length - 1];
    const lastContent = last?.content[last.content.length - 1];
    if (last && last.type === type && lastContent) {
      lastContent.text += `\n${msg.content}`;
    } else {
      steps.push({ type, content: [{ type: "text", text: msg.content }] });
    }
  }
  return steps;
}

async function chatWithGemini(messages: ChatMessage[], model: string, signal: AbortSignal): Promise<string> {
  let res;
  try {
    res = await ai.interactions.create(
      { model, input: toGeminiSteps(messages) },
      { fetchOptions: { signal } },
    );
  } catch (e) {
    // A real 429 (rate limit / quota) surfaces as a thrown ApiError with
    // .status set, not as a field on a resolved response — the SDK's
    // default retry_codes already retries 429s a few times internally
    // before giving up and throwing this.
    if (e instanceof ApiError && e.status === 429) {
      throw new GeminiQuotaError("Gemini free-tier quota exhausted (429)");
    }
    throw e;
  }

  // "budget_exceeded" is a distinct status an interaction can resolve to
  // (e.g. an agent/background task running out of its own compute budget
  // mid-task) — different from the request-level 429 above, but treated the
  // same way here since either means "can't get an answer from this tier
  // right now."
  if (res.status === "budget_exceeded") throw new GeminiQuotaError("Gemini interaction budget exhausted");
  if (res.status === "failed" || res.status === "cancelled") {
    throw new Error(`Gemini interaction ${res.status}`);
  }

  // output_text is a convenience field the SDK computes for us (concatenated
  // text from the last model output) — fall back to walking steps manually
  // only if that's ever empty, since a step can carry non-text content
  // (image/audio/etc.) or no content at all (e.g. one that only set `error`).
  if (res.output_text) return res.output_text;
  return res.steps
    .filter((s): s is Extract<typeof s, { type: "model_output" }> => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function chatWithOllama(messages: ChatMessage[], model: string, numCtx: number | undefined, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return "";

  const stream = await ollama.chat({
    model,
    messages,
    stream: true,
    ...(numCtx ? { options: { num_ctx: numCtx } } : {}),
  });

  const onAbort = () => { stream.abort(); };
  signal.addEventListener("abort", onAbort);

  try {
    let content = "";
    for await (const chunk of stream) {
      content += chunk.message.content;
    }
    return content;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// Regular chat function switches models to local based on resources spent.
export function chat(messages: ChatMessage[], config: ChatConfig): ChatHandle {
  const controller = new AbortController();
  const trimmed = trimHistory(messages, config.maxHistoryMessages);

  const result = (async () => {
    const geminiKey = process.env.GEMINI_API_KEY;
    const primary = geminiModel();

    if (geminiKey && geminiTier === 0) {
      try {
        return await chatWithGemini(trimmed, primary, controller.signal);
      } catch (e) {
        if (e instanceof GeminiQuotaError) {
          geminiTier = primary === GEMINI_FALLBACK_MODEL ? 2 : 1;
          const next = geminiTier === 1 ? GEMINI_FALLBACK_MODEL : "local Ollama";
          console.error(`${e.message} (model: ${primary}) — degrading to ${next} for the rest of this run.`);
        } else {
          throw e;
        }
      }
    }

    if (geminiKey && geminiTier === 1) {
      try {
        return await chatWithGemini(trimmed, GEMINI_FALLBACK_MODEL, controller.signal);
      } catch (e) {
        if (e instanceof GeminiQuotaError) {
          geminiTier = 2;
          console.error(`${e.message} (model: ${GEMINI_FALLBACK_MODEL}) — falling back to local Ollama for the rest of this run.`);
        } else {
          throw e;
        }
      }
    }

    return await chatWithOllama(trimmed, config.ollamaModel, config.numCtx, controller.signal);
  })();

  return { result, abort: () => controller.abort() };
}
