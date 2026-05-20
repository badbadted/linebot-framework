/**
 * Gemini LLM Provider
 *
 * Config:
 *   { type: 'gemini', apiKey: '$GEMINI_API_KEY', model: 'gemini-2.5-flash' }
 *
 * 回傳統一的 LLM 介面：
 *   llm.chat(prompt)              → string
 *   llm.chatWithHistory(messages) → string
 *   llm.model                     → model name
 */

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function createGeminiProvider(config) {
  const apiKey = resolveEnvVar(config.apiKey) || process.env.GEMINI_API_KEY;
  const model = config.model || 'gemini-2.5-flash';

  if (!apiKey) {
    throw new Error('Gemini API key required (config.apiKey or GEMINI_API_KEY env)');
  }

  async function chat(prompt) {
    const url = `${GEMINI_API}/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Gemini error: ${res.status} ${JSON.stringify(body.error?.message || body)}`);

    return body.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async function chatWithHistory(messages) {
    // messages: [{ role: 'user'|'model', text: string }]
    const url = `${GEMINI_API}/${model}:generateContent?key=${apiKey}`;
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: [{ text: m.text || m.content }],
    }));

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Gemini error: ${res.status} ${JSON.stringify(body.error?.message || body)}`);

    return body.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  function close() { /* no-op for HTTP API */ }

  return { chat, chatWithHistory, model, close };
}

function resolveEnvVar(value) {
  if (typeof value === 'string' && value.startsWith('$')) {
    return process.env[value.slice(1)] || '';
  }
  return value;
}
