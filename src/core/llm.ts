// Shared chat-completion layer used by both ContentCreator.think() and
// Editor.think() — unlike the command-dispatch logic in those two classes
// (deliberately duplicated, see CLAUDE.md), which provider answers a given
// turn isn't command-specific, so it lives here once.
//
// Gemini is the primary backend when GEMINI_API_KEY is set, called directly
// via its REST API (no new npm dependency, same convention as
// researchSources.ts/mediaSources.ts). Three tiers, degrading in order:
// GEMINI_MODEL (or its default, see geminiModel() below) -> the
// "gemini-flash-lite-latest" alias specifically, since it carries its own,
// separate free-tier quota bucket -> local Ollama. Each 429/RESOURCE_EXHAUSTED
// (the standard googleapis.com quota-exceeded signal) sticks the process at
// the next tier down for the rest of the run rather than re-probing the
// exhausted one per call, since retrying a known-exhausted quota on every
// single turn would just be another way to burn through it. If GEMINI_MODEL
// is unset (or already IS "gemini-flash-lite-latest"), the middle tier is
// identical to the first and is skipped, going straight to Ollama on 429.

import { Ollama } from "ollama";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ChatConfig {
  ollamaModel: string;
  numCtx?: number;
  // ContentCreator/Editor never trim their own `history` array — it's resent
  // in full on every turn, so token cost per call grows with every step of
  // an 8-12 step loop (roughly O(steps^2) total tokens across a session).
  // Gemini's free tier is metered per-minute, so that growth is the main
  // lever left for todo.txt's "reduce token spending" beyond the thinking-
  // budget/model choice already applied below. Keeping the first message
  // (the system prompt carrying personality/task/goal) plus only the most
  // recent `maxHistoryMessages` entries bounds the request size without
  // losing the context a turn actually needs to act correctly.
  maxHistoryMessages?: number;
}

export interface ChatHandle {
  result: Promise<string>;
  abort: () => void;
}

const ollama = new Ollama();

// Three-tier degradation ladder: 0 = primary (geminiModel()), 1 = the
// "gemini-flash-lite-latest" fallback specifically, 2 = Ollama only. Sticky
// once it drops a level — see the top-of-file comment for why.
let geminiTier: 0 | 1 | 2 = 0;

// "gemini-flash-lite-latest" is an alias Google maintains to always point at
// their current recommended lite-flash model, rather than a pinned version —
// pinning one directly is a real risk here: "gemini-2.5-flash" (this
// module's first choice) turned out to already be a 404 "no longer
// available to new users" against a freshly created API key. The plain
// "gemini-flash-latest" alias (the non-lite flagship) was tried first, but
// its free tier turned out to allow only 5 requests/minute against this key
// (confirmed via the 429 body: "limit: 5, model: gemini-3.6-flash") — an
// 8-step think loop blows through that almost instantly. The "-lite" alias
// survived 8 rapid calls with no 429 in testing — it's both the default
// primary model below and the dedicated fallback tier a non-default
// GEMINI_MODEL degrades to before Ollama.
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

// Gemini's `contents` array only has "user"/"model" roles, with no mid-
// conversation "system" turn the way Ollama's chat API allows — but this
// codebase's `history` reuses role "system" for repeated in-conversation
// reminders, not just a single upfront prompt (see continueReminder/
// CONTINUE_REMINDER in contentCreator.ts/editor.ts). So "system" maps to
// "user" here, and consecutive same-role turns are merged, since Gemini
// expects (softly) alternating turns and our history doesn't always
// alternate cleanly once a "system" reminder follows a "user" command result.
function toGeminiContents(messages: ChatMessage[]): { role: "user" | "model"; parts: { text: string }[] }[] {
  const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [];
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    const part = last?.parts[0];
    if (last && part && last.role === role) {
      part.text += `\n\n${msg.content}`;
    } else {
      contents.push({ role, parts: [{ text: msg.content }] });
    }
  }
  return contents;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

async function chatWithGemini(messages: ChatMessage[], apiKey: string, model: string, signal: AbortSignal): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: toGeminiContents(messages),
      // Newer Gemini models think by default — verified this burns 60-85
      // invisible "thoughtsTokenCount" tokens per call even for a one-word
      // answer, which eats into the free tier's per-minute budget for
      // nothing the INVOKE-dispatch task (a simple, well-specified
      // completion, not deep reasoning) actually needs. LOW is Google's own
      // recommendation for fast, non-reasoning tasks like this one.
      generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
    }),
    signal,
  });

  if (res.status === 429) throw new GeminiQuotaError("Gemini free-tier quota exhausted (429 RESOURCE_EXHAUSTED)");
  if (!res.ok) throw new Error(`Gemini request failed: ${res.status} ${res.statusText}`);

  const data = await res.json() as GeminiResponse;
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
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

// Fires off a chat turn against Gemini (if configured and not yet known to
// be fully quota-exhausted), degrading through the primary model -> the
// flash-lite fallback -> local Ollama as each tier's quota is hit, and
// returns a handle whose `abort()` cancels whichever provider is actually in
// flight — mirrors the shape the old direct-Ollama-stream call gave callers,
// so ContentCreator/Editor's interrupt()/timeout logic didn't need to change.
export function chat(messages: ChatMessage[], config: ChatConfig): ChatHandle {
  const controller = new AbortController();
  const trimmed = trimHistory(messages, config.maxHistoryMessages);

  const result = (async () => {
    const geminiKey = process.env.GEMINI_API_KEY;
    const primary = geminiModel();

    if (geminiKey && geminiTier === 0) {
      try {
        return await chatWithGemini(trimmed, geminiKey, primary, controller.signal);
      } catch (e) {
        if (e instanceof GeminiQuotaError) {
          // If the primary model already IS the fallback model (the default
          // case, GEMINI_MODEL unset), there's no distinct tier to degrade
          // to — retrying the identical model would just re-hit the same
          // exhausted quota, so skip straight to Ollama.
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
        return await chatWithGemini(trimmed, geminiKey, GEMINI_FALLBACK_MODEL, controller.signal);
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
