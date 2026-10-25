/**
 * Luna LLM Provider
 *
 * 透過 HTTP API 呼叫外部 Luna 系統（智慧管家），
 * 取代框架內建的 LLM，由 Luna 統一處理 AI 對話 + 工具呼叫。
 *
 * Config:
 *   {
 *     type: 'luna',
 *     baseUrl: 'http://192.168.68.60:3456',  // Luna server URL
 *     timeout: 30000,                          // 請求逾時（ms）
 *   }
 *
 * 回傳統一的 LLM 介面：
 *   llm.chat(prompt, { sessionId })  → string
 *   llm.model                        → 'luna'
 */

export async function createLunaProvider(config) {
  const baseUrl = (config.baseUrl || config.base_url || 'http://localhost:3456').replace(/\/$/, '');
  const timeout = config.timeout || 30000;

  // 啟動時驗證 Luna 是否可達
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${baseUrl}/api/env`, { signal: ctrl.signal });
    clearTimeout(timer);
    const body = await res.text();
    console.log(`[luna-provider] connected to ${baseUrl} (status: ${res.status})`);
  } catch (err) {
    console.warn(`[luna-provider] cannot reach ${baseUrl}: ${err.message} (will retry on each request)`);
  }

  /**
   * 送出對話，取得回覆
   * @param {string} prompt - 使用者訊息
   * @param {object} [opts] - { sessionId }
   * @returns {string} Luna 的回覆文字
   */
  async function chat(prompt, opts = {}) {
    const sessionId = opts.sessionId || 'linebot-default';
    const url = `${baseUrl}/api/ext/chat`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt, sessionId }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const body = await res.json();

      if (!res.ok) {
        throw new Error(`Luna API error: ${res.status} ${body.error || ''}`);
      }

      if (!body.success) {
        throw new Error(`Luna returned failure: ${body.error || 'unknown'}`);
      }

      console.log(`[luna-provider] reply (${body.source}, ${body.duration_ms}ms): ${(body.reply || '').slice(0, 60)}`);
      return body.reply || '';
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`Luna timeout after ${timeout}ms`);
      }
      throw err;
    }
  }

  /**
   * 帶歷史的對話（簡化為只送最後一則）
   * Luna 自己管 session context，不需要框架送歷史
   */
  async function chatWithHistory(messages, opts = {}) {
    const last = messages[messages.length - 1];
    return chat(last?.text || last?.content || '', opts);
  }

  /**
   * 純文字生成：不帶 Luna 工具、不用 Luna 記憶與 session（Luna /api/ext/llm，只收本機呼叫）
   * @param {object} opts - { system, messages: [{role, content}], maxTokens, webSearch?: { maxUses }, model?, effort?, timeoutMs? }
   *   webSearch：開 Anthropic 網路搜尋（按次計費）；model：'haiku'（預設）或 'sonnet'；effort：low／medium／high
   * @returns {string}
   */
  async function generate({ system, messages, maxTokens, webSearch, model, effort, timeoutMs } = {}) {
    const limit = timeoutMs || timeout;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), limit);
    try {
      const res = await fetch(`${baseUrl}/api/ext/llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system, messages, maxTokens, webSearch, model, effort }),
        signal: ctrl.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(`Luna llm error: ${res.status} ${body.error || ''}`);
      return body.text || '';
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Luna llm timeout after ${limit}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function close() { /* no-op */ }

  return { chat, chatWithHistory, generate, model: 'luna', close };
}
