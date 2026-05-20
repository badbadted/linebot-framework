/**
 * In-Memory Cache Provider
 *
 * Config:
 *   { type: 'memory', ttl: 300 }   // 預設 TTL 300 秒
 *
 * 統一 cache 介面：
 *   cache.get(key)            → value | null
 *   cache.set(key, value, ttl?) → void
 *   cache.del(key)            → void
 *   cache.has(key)            → boolean
 *   cache.clear()             → void
 */

export async function createMemoryCacheProvider(config) {
  const defaultTTL = (config.ttl || 300) * 1000; // 轉毫秒
  const store = new Map(); // key → { value, expires }

  function get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expires && Date.now() > entry.expires) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  function set(key, value, ttlSeconds) {
    const ttl = (ttlSeconds ? ttlSeconds * 1000 : defaultTTL);
    store.set(key, {
      value,
      expires: ttl > 0 ? Date.now() + ttl : null,
    });
  }

  function del(key) { store.delete(key); }
  function has(key) { return get(key) !== null; }
  function clear() { store.clear(); }
  function close() { store.clear(); }

  return { get, set, del, has, clear, close };
}
