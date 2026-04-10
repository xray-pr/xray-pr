import Anthropic from "@anthropic-ai/sdk";

export interface LLMProvider {
  generate(prompt: string, maxTokens: number): Promise<string>;
}

export interface LLMConfig {
  provider: "anthropic" | "openai" | "openrouter";
  apiKey: string;
  model: string;
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  openrouter: "anthropic/claude-sonnet-4",
};

export function resolveLLMConfig(
  anthropicKey: string,
  openaiKey: string,
  openrouterKey: string,
  modelOverride: string
): LLMConfig | null {
  if (anthropicKey) {
    return {
      provider: "anthropic",
      apiKey: anthropicKey,
      model: modelOverride || DEFAULT_MODELS.anthropic,
    };
  }
  if (openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      model: modelOverride || DEFAULT_MODELS.openai,
    };
  }
  if (openrouterKey) {
    return {
      provider: "openrouter",
      apiKey: openrouterKey,
      model: modelOverride || DEFAULT_MODELS.openrouter,
    };
  }
  return null;
}

class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    const opts: { apiKey: string; baseURL?: string } = { apiKey };
    if (baseUrl) opts.baseURL = baseUrl;
    this.client = new Anthropic(opts);
    this.model = model;
  }

  async generate(prompt: string, maxTokens: number): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "";
  }
}

class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async generate(prompt: string, maxTokens: number): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`${response.status} ${err}`);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices?.[0]?.message?.content || "";
  }
}

export function createProvider(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(config.apiKey, config.model);
    case "openai":
      return new OpenAIProvider(
        config.apiKey,
        config.model,
        "https://api.openai.com/v1"
      );
    case "openrouter":
      return new AnthropicProvider(
        config.apiKey,
        config.model,
        "https://openrouter.ai/api/v1"
      );
  }
}
