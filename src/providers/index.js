/**
 * 內建 Provider Factories 註冊
 *
 * 在這裡集中註冊所有內建的 provider factory。
 * 使用者也可以在啟動後用 registry.registerFactory() 加自訂的。
 */

import { createSQLiteProvider } from './db-sqlite.js';
import { createGeminiProvider } from './llm-gemini.js';
import { createOpenAIProvider } from './llm-openai.js';
import { createLunaProvider } from './llm-luna.js';
import { createMemoryCacheProvider } from './cache-memory.js';

export function registerBuiltinProviders(registry) {
  // ── DB ──
  registry.registerFactory('db', 'sqlite', createSQLiteProvider);
  // 未來：
  // registry.registerFactory('db', 'mysql', createMySQLProvider);
  // registry.registerFactory('db', 'postgresql', createPostgreSQLProvider);

  // ── LLM ──
  registry.registerFactory('llm', 'gemini', createGeminiProvider);
  registry.registerFactory('llm', 'openai', createOpenAIProvider);
  registry.registerFactory('llm', 'luna', createLunaProvider);
  // openai provider 也相容 Claude（設 baseUrl: 'https://api.anthropic.com/v1'）
  // 未來：
  // registry.registerFactory('llm', 'claude', createClaudeProvider);

  // ── Cache ──
  registry.registerFactory('cache', 'memory', createMemoryCacheProvider);
  // 未來：
  // registry.registerFactory('cache', 'redis', createRedisProvider);
}
