/**
 * OpenAI LLM Provider (也相容 Claude / 任何 OpenAI-compatible API)
 *
 * Config:
 *   { type: 'openai', apiKey: '$OPENAI_API_KEY', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' }
 *
 * 回傳統一的 LLM 介面：
 *   llm.chat(prompt)              → string
 *   llm.chatWithHistory(messages) → string
 *   llm.model                     → model name
 */

export async function createOpenAIProvider(config) {
  const apiKey = resolveEnvVar(config.apiKey) || process.env.OPENAI_API_KEY;
  const model = config.model || 'gpt-4o';
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';

  if (!apiKey) {
    throw new Error('OpenAI API key required (config.apiKey or OPENAI_API_KEY env)');
  }

  async function chat(prompt) {
    return chatWithHistory([{ role: 'user', content: prompt }]);
  }

  async function chatWithHistory(messages) {
    // messages: [{ role: 'user'|'assistant'|'system', content: string }]
    const formatted = messages.map(m => ({
      role: m.role,
      content: m.content || m.text,
    }));

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages: formatted }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${body.error?.message || JSON.stringify(body)}`);

    return body.choices?.[0]?.message?.content || '';
  }

  function close() { /* no-op */ }

  return { chat, chatWithHistory, model, close };
}

function resolveEnvVar(value) {
  if (typeof value === 'string' && value.startsWith('$')) {
    return process.env[value.slice(1)] || '';
  }
  return value;
}
