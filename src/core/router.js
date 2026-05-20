/**
 * Regex/Keyword Router
 *
 * 註冊 pattern → handler 映射，收到訊息時依序比對。
 * 支援兩種 handler 類型：
 *   - action: 執行動作，不回覆（靜默）
 *   - query:  執行動作，回覆結果給使用者
 */

export function createRouter() {
  const routes = [];

  /**
   * 註冊路由
   * @param {RegExp} pattern - 比對 regex
   * @param {Function} handler - async (match, ctx) => string|void
   * @param {Object} opts
   * @param {string} opts.type - 'action' | 'query'（預設 'query'）
   * @param {string} opts.name - 路由名稱（debug 用）
   * @param {string} opts.plugin - 來源 plugin 名稱
   * @param {string} opts.scope - 'all' | 'private' | 'group'（預設 'all'）
   */
  function add(pattern, handler, opts = {}) {
    routes.push({
      pattern,
      handler,
      type: opts.type || 'query',
      name: opts.name || pattern.source,
      plugin: opts.plugin || 'unknown',
      describe: opts.describe || '',
      scope: opts.scope || 'all',
    });
  }

  /**
   * 比對訊息
   * @param {string} text - 使用者訊息
   * @param {object} [opts] - { sourceType: 'user'|'group'|'room' }
   * @returns {{ matched, route, match, scopeBlocked }} | { matched: false }
   */
  function match(text, opts = {}) {
    const trimmed = text.trim();
    const sourceType = opts.sourceType || 'user';
    const isGroup = sourceType === 'group' || sourceType === 'room';

    for (const route of routes) {
      const m = trimmed.match(route.pattern);
      if (m) {
        // scope 過濾
        if (route.scope === 'private' && isGroup) {
          return { matched: true, route, match: m, scopeBlocked: true };
        }
        if (route.scope === 'group' && !isGroup) {
          return { matched: true, route, match: m, scopeBlocked: true };
        }
        return { matched: true, route, match: m, scopeBlocked: false };
      }
    }
    return { matched: false };
  }

  /**
   * 執行已比對的路由
   * @param {Object} matchResult - match() 的回傳值
   * @param {Object} ctx - { userId, replyToken, lineApi, ... }
   * @returns {{ type, result }}
   */
  async function execute(matchResult, ctx) {
    const { route, match: m } = matchResult;
    const result = await route.handler(m, ctx);
    return { type: route.type, result };
  }

  function list() {
    return routes.map(r => ({
      pattern: r.pattern.source,
      type: r.type,
      name: r.name,
      plugin: r.plugin,
      describe: r.describe,
      scope: r.scope,
    }));
  }

  return { add, match, execute, list };
}
