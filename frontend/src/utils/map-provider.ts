// These are provider names, not user-facing text
export const MAP_PROVIDER = {
  openai: "OpenAI",
  azure: "Azure",
  azure_ai: "Azure AI Studio",
  vertex_ai: "VertexAI",
  palm: "PaLM",
  gemini: "Gemini",
  anthropic: "Anthropic",
  sagemaker: "AWS SageMaker",
  bedrock: "AWS Bedrock",
  mistral: "Mistral AI",
  anyscale: "Anyscale",
  databricks: "Databricks",
  ollama: "Ollama",
  perlexity: "Perplexity AI",
  friendliai: "FriendliAI",
  groq: "Groq",
  fireworks_ai: "Fireworks AI",
  cloudflare: "Cloudflare Workers AI",
  deepinfra: "DeepInfra",
  ai21: "AI21",
  replicate: "Replicate",
  voyage: "Voyage AI",
  openrouter: "OpenRouter",
  openhands: "Nimbus",
  lemonade: "Lemonade",
  clarifai: "Clarifai",
  // Vendors in the Nimbus catalog. Without these the Settings provider
  // dropdown fell through to the raw gateway prefix and showed a customer
  // "deepseek", "moonshotai", "z-ai" and "qwen" in lowercase, next to
  // properly-cased names like "Anthropic" — the prefix is a routing key, not
  // display text.
  //
  // "alibaba" is deliberately absent. It is SpiderSense's name for the
  // upstream they source qwen3.8-max from, and no customer-facing surface
  // should render it; the chat picker files that model under Qwen with the
  // rest of the family. See the note beside NIMBUS_VERIFIED_PROVIDERS in
  // nimbus_llm_model_service.py — adding it here would put the supplier back
  // on screen, and as a SECOND "Qwen" entry in the same dropdown.
  google: "Google",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot",
  qwen: "Qwen",
  "z-ai": "Z.ai",
};

export const mapProvider = (provider: string) =>
  Object.keys(MAP_PROVIDER).includes(provider)
    ? MAP_PROVIDER[provider as keyof typeof MAP_PROVIDER]
    : provider;

export const getProviderId = (displayName: string): string => {
  const entry = Object.entries(MAP_PROVIDER).find(
    ([, value]) => value === displayName,
  );
  return entry ? entry[0] : displayName;
};
