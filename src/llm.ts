import Anthropic from "@anthropic-ai/sdk";

export interface LLMClient {
  chat(prompt: string, maxTokens: number): Promise<string>;
}

export function createLLMClient(opts: {
  anthropicKey?: string;
  openrouterKey?: string;
  model?: string;
}): LLMClient | null {
  if (opts.anthropicKey) {
    return new AnthropicLLM(opts.anthropicKey, opts.model || "claude-sonnet-4-20250514");
  }
  if (opts.openrouterKey) {
    return new OpenRouterLLM(opts.openrouterKey, opts.model || "anthropic/claude-sonnet-4-20250514");
  }
  return null;
}

class AnthropicLLM implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(prompt: string, maxTokens: number): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "";
  }
}

class OpenRouterLLM implements LLMClient {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(prompt: string, maxTokens: number): Promise<string> {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${text}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }
}
