/**
 * Provider Registry
 *
 * 統一管理外接服務（DB、LLM、Cache 等）的生命週期。
 * Config 驅動：只有設定的 provider 才會載入，沒設的就是 null。
 *
 * 內建 provider type：
 *   db:    sqlite（預設）、mysql、postgresql
 *   llm:   gemini、openai、claude
 *   cache: memory（預設）、redis
 *
 * 也支援自訂 provider：透過 registerFactory() 註冊。
 *
 * 用法：
 *   const registry = createProviderRegistry();
 *   registry.registerFactory('db', 'sqlite', sqliteFactory);
 *   await registry.initFromConfig(config.providers);
 *   const db = registry.get('db');  // 已初始化的 instance
 */

export function createProviderRegistry() {
  const factories = new Map();   // 'db:sqlite' → factory fn
  const instances = new Map();   // 'db' → instance

  /**
   * 註冊 provider factory
   * @param {string} category - 類別（db, llm, cache, ...）
   * @param {string} type - 實作類型（sqlite, mysql, gemini, ...）
   * @param {Function} factory - async (config) => instance
   */
  function registerFactory(category, type, factory) {
    factories.set(`${category}:${type}`, factory);
  }

  /**
   * 從 config 初始化所有 provider
   * @param {Object} providersConfig - { db: { type, ...opts }, llm: { type, ...opts } }
   */
  async function initFromConfig(providersConfig = {}) {
    for (const [category, config] of Object.entries(providersConfig)) {
      if (!config || !config.type) {
        console.warn(`[providers] ${category}: missing "type", skipped`);
        continue;
      }

      const key = `${category}:${config.type}`;
      const factory = factories.get(key);

      if (!factory) {
        console.error(`[providers] ${category}: unknown type "${config.type}" (available: ${listTypes(category).join(', ') || 'none'})`);
        continue;
      }

      try {
        const instance = await factory(config);
        instances.set(category, instance);
        console.log(`[providers] ${category}: ${config.type} ✓`);
      } catch (err) {
        console.error(`[providers] ${category}: failed to init ${config.type} — ${err.message}`);
      }
    }
  }

  /**
   * 取得 provider instance（未設定的回傳 null）
   */
  function get(category) {
    return instances.get(category) || null;
  }

  /**
   * 取得所有已初始化的 provider（傳給 plugin init）
   */
  function getAll() {
    return Object.fromEntries(instances);
  }

  /**
   * 列出某 category 可用的 type
   */
  function listTypes(category) {
    const types = [];
    for (const key of factories.keys()) {
      if (key.startsWith(`${category}:`)) {
        types.push(key.split(':')[1]);
      }
    }
    return types;
  }

  /**
   * 列出所有已初始化的 provider
   */
  function list() {
    return Array.from(instances.entries()).map(([cat]) => cat);
  }

  /**
   * 關閉所有 provider
   */
  async function closeAll() {
    for (const [category, instance] of instances) {
      try {
        if (typeof instance.close === 'function') await instance.close();
        else if (typeof instance.destroy === 'function') await instance.destroy();
        else if (typeof instance.end === 'function') await instance.end();
      } catch (err) {
        console.error(`[providers] ${category}: close error — ${err.message}`);
      }
    }
    instances.clear();
  }

  return { registerFactory, initFromConfig, get, getAll, list, listTypes, closeAll };
}
