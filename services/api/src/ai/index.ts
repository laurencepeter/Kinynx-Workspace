/**
 * AI provider abstraction. Kinynx is NOT tied to a single provider: configure
 * your own (bring your own key), or run a local model for full data control.
 *
 * Drivers:
 *   - anthropic          : Claude Messages API (api.anthropic.com/v1/messages)
 *   - openai/openrouter  : OpenAI-compatible /v1/chat/completions
 *   - ollama             : local models via OpenAI-compatible endpoint
 *   - custom             : any OpenAI-compatible base URL
 *   - google             : Gemini generateContent
 *   - mock               : deterministic, offline (dev/tests)
 *
 * Enterprise deployments can disable external providers (AI_ALLOW_EXTERNAL=false)
 * so only local models (ollama / a local custom endpoint) are permitted.
 */
import type { Config } from "../config.js";

export interface CompletionRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface AIProvider {
  readonly name: string;
  readonly external: boolean;
  complete(req: CompletionRequest): Promise<{ text: string }>;
}

class MockProvider implements AIProvider {
  readonly name = "mock";
  readonly external = false;
  async complete(req: CompletionRequest): Promise<{ text: string }> {
    // Deterministic echo so features are testable without network/keys.
    const head = req.prompt.replace(/\s+/g, " ").trim().slice(0, 80);
    return { text: `[mock summary] ${head}` };
  }
}

class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  readonly external = true;
  constructor(private readonly cfg: Config) {}
  async complete(req: CompletionRequest): Promise<{ text: string }> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.AI_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.cfg.AI_MODEL ?? "claude-opus-5",
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic error ${res.status}: ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    return { text: body.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") };
  }
}

class OpenAICompatibleProvider implements AIProvider {
  readonly external: boolean;
  constructor(readonly name: string, private readonly cfg: Config, private readonly defaultBase: string, external: boolean) {
    this.external = external;
  }
  async complete(req: CompletionRequest): Promise<{ text: string }> {
    const base = (this.cfg.AI_BASE_URL ?? this.defaultBase).replace(/\/$/, "");
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.prompt },
    ];
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.AI_API_KEY ? { authorization: `Bearer ${this.cfg.AI_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: this.cfg.AI_MODEL ?? "gpt-4o-mini", max_tokens: req.maxTokens ?? 1024, messages }),
    });
    if (!res.ok) throw new Error(`${this.name} error ${res.status}: ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return { text: body.choices[0]?.message.content ?? "" };
  }
}

class GoogleProvider implements AIProvider {
  readonly name = "google";
  readonly external = true;
  constructor(private readonly cfg: Config) {}
  async complete(req: CompletionRequest): Promise<{ text: string }> {
    const model = this.cfg.AI_MODEL ?? "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.cfg.AI_API_KEY ?? ""}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
        contents: [{ role: "user", parts: [{ text: req.prompt }] }],
        generationConfig: { maxOutputTokens: req.maxTokens ?? 1024 },
      }),
    });
    if (!res.ok) throw new Error(`google error ${res.status}: ${await res.text().catch(() => "")}`);
    const body = (await res.json()) as { candidates?: Array<{ content: { parts: Array<{ text?: string }> } }> };
    return { text: (body.candidates?.[0]?.content.parts ?? []).map((p) => p.text ?? "").join("") };
  }
}

export function createAIProvider(cfg: Config): AIProvider | null {
  switch (cfg.AI_PROVIDER) {
    case "mock":
      return new MockProvider();
    case "anthropic":
      return new AnthropicProvider(cfg);
    case "google":
      return new GoogleProvider(cfg);
    case "openai":
      return new OpenAICompatibleProvider("openai", cfg, "https://api.openai.com/v1", true);
    case "openrouter":
      return new OpenAICompatibleProvider("openrouter", cfg, "https://openrouter.ai/api/v1", true);
    case "ollama":
      return new OpenAICompatibleProvider("ollama", cfg, "http://localhost:11434/v1", false);
    case "custom":
      return new OpenAICompatibleProvider("custom", cfg, cfg.AI_BASE_URL ?? "http://localhost:8080/v1", false);
    default:
      return null; // AI features disabled
  }
}

// ── Prompt builders for the workspace AI features ────────────────────────────
export function summarizePrompt(text: string): CompletionRequest {
  return { system: "You summarize workspace documents into concise bullet points.", prompt: `Summarize the following page:\n\n${text}`, maxTokens: 512 };
}
export function rewritePrompt(text: string, instruction: string): CompletionRequest {
  return { system: "You rewrite text as instructed, preserving meaning.", prompt: `Instruction: ${instruction}\n\nText:\n${text}`, maxTokens: 1024 };
}
