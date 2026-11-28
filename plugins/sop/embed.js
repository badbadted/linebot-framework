/**
 * 呼叫本機 Ollama 算向量（bge-m3）。
 * 匯出腳本（Windows）與 sop plugin（Mac mini）共用這支，兩邊打同一個 API、同一個模型，
 * 向量才比得起來；啟動時另有探針句自檢（retriever.selfCheck）把關。
 * API 形狀照 C:/Ted/mcp-servers/vector-memory/embed.mjs（/api/embed，input 截 2000 字）。
 */

export const OLLAMA_URL = (process.env.SOP_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
export const EMBED_MODEL = 'bge-m3';

/**
 * @param {string} text
 * @param {{ timeoutMs?: number, keepAlive?: string, url?: string }} [opts]
 * @returns {Promise<Float32Array>} 失敗丟例外（呼叫端決定怎麼回使用者）
 */
export async function embedText(text, { timeoutMs = 15000, keepAlive = '10m', url = OLLAMA_URL } = {}) {
  let res;
  try {
    res = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: [String(text).slice(0, 2000)], keep_alive: keepAlive }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const why = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? '逾時' : (err?.cause?.code || err?.message);
    throw new Error(`Ollama 連不上（${why}）`);
  }
  if (!res.ok) {
    const hint = res.status === 404 ? `，請先 ollama pull ${EMBED_MODEL}` : '';
    throw new Error(`Ollama 回 ${res.status}${hint}`);
  }
  const body = await res.json();
  const v = body?.embeddings?.[0];
  if (!Array.isArray(v) || !v.length) throw new Error('Ollama 回應缺 embeddings');
  return Float32Array.from(v);
}
