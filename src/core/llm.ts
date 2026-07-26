// Shared chat-completion layer used by both ContentCreator.think() and
// Editor.think() — unlike the command-dispatch logic in those two classes
// (deliberately duplicated, see CLAUDE.md), which provider answers a given
// turn isn't command-specific, so it lives here once.
//
// Gemini is the primary backend when GEMINI_API_KEY is set, called directly
// via its REST API (no new npm dependency, same convention as
// researchSources.ts/mediaSources.ts). The first time a call comes back
// 429/RESOURCE_EXHAUSTED (the standard googleapis.com quota-exceeded
// signal), that's treated as "free-tier quota exhausted for this key" and
// every call for the rest of the process falls back to local Ollama —
// intentionally sticky rather than re-probed per call, since retrying a
// known-exhausted quota on every single turn would just be another way to
// burn through it.

import { Ollama } from "ollama";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ChatConfig {
  ollamaModel: string;
  numCtx?: number;
}

export interface ChatHandle {
  result: Promise<string>;
  abort: () => void;
}

const ollama = new Ollama();
let geminiExhausted = false;

// "gemini-flash-lite-latest" is an alias Google maintains to always point at
// their current recommended lite-flash model, rather than a pinned version —
// pinning one directly is a real risk here: "gemini-2.5-flash" (this
// module's first choice) turned out to already be a 404 "no longer
// available to new users" against a freshly created API key. The plain
// "gemini-flash-latest" alias (the non-lite flagship) was tried first, but
// its free tier turned out to allow only 5 requests/minute against this key
// (confirmed via the 429 body: "limit: 5, model: gemini-3.6-flash") — an
// 8-step think loop blows through that almost instantly. The "-lite" alias
// survived 8 rapid calls with no 429 in testing.
function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest";
}

class GeminiQuotaError extends Error { }

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

async function chatWithGemini(messages: ChatMessage[], apiKey: string, signal: AbortSignal): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel()}:generateContent?key=${apiKey}`;
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
// be quota-exhausted) falling back to local Ollama, and returns a handle
// whose `abort()` cancels whichever provider is actually in flight — mirrors
// the shape the old direct-Ollama-stream call gave callers, so
// ContentCreator/Editor's interrupt()/timeout logic didn't need to change.
export function chat(messages: ChatMessage[], config: ChatConfig): ChatHandle {
  const controller = new AbortController();

  const result = (async () => {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey && !geminiExhausted) {
      try {
        return await chatWithGemini(messages, geminiKey, controller.signal);
      } catch (e) {
        if (e instanceof GeminiQuotaError) {
          geminiExhausted = true;
          console.error(`${e.message} — falling back to local Ollama for the rest of this run.`);
        } else {
          throw e;
        }
      }
    }
    return await chatWithOllama(messages, config.ollamaModel, config.numCtx, controller.signal);
  })();

  return { result, abort: () => controller.abort() };
}
