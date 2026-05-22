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
   * 群組權限表
   * { "C群組ID": ["plugin1", "plugin2"], "*": ["todo"] }
   * 群組預設全關，只有列出的 plugin 可用。私訊不受限。
   */
  let groupPermissions = {};

  /**
   * 設定群組權限
   */
  function setGroupPermissions(perms) {
    groupPermissions = perms || {};
    console.log(`[router] group permissions: ${Object.keys(groupPermissions).length} groups configured`);
  }

  /**
   * 取得群組權限（API 用）
   */
  function getGroupPermissions() {
    return { ...groupPermissions };
  }

  /**
   * 檢查 plugin 是否允許在該群組使用
   * - 私訊 → 永遠允許
   * - 群組 → 查 groupPermissions[groupId] 或 groupPermissions["*"]，預設全關
   */
  function isPluginAllowedInGroup(plugin, groupId) {
    if (!groupId) return true; // 私訊不受限
    const allowed = groupPermissions[groupId] || groupPermissions['*'] || [];
    return allowed.includes(plugin);
  }

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
   * @param {object} [opts] - { sourceType, groupId }
   * @returns {{ matched, route, match, scopeBlocked, groupBlocked }} | { matched: false }
   */
  function match(text, opts = {}) {
    const trimmed = text.trim();
    const sourceType = opts.sourceType || 'user';
    const groupId = opts.groupId || null;
    const isGroup = sourceType === 'group' || sourceType === 'room';

    for (const route of routes) {
      const m = trimmed.match(route.pattern);
      if (m) {
        // scope 過濾
        if (route.scope === 'private' && isGroup) {
          return { matched: true, route, match: m, scopeBlocked: true, groupBlocked: false };
        }
        if (route.scope === 'group' && !isGroup) {
          return { matched: true, route, match: m, scopeBlocked: true, groupBlocked: false };
        }
        // 群組權限過濾
        if (isGroup && !isPluginAllowedInGroup(route.plugin, groupId)) {
          return { matched: true, route, match: m, scopeBlocked: false, groupBlocked: true };
        }
        return { matched: true, route, match: m, scopeBlocked: false, groupBlocked: false };
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

  return { add, match, execute, list, setGroupPermissions, getGroupPermissions };
}
