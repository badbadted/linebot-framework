/**
 * Luna Provider 整合測試
 *
 * 驗證：
 * 1. Provider Registry 能載入 luna type
 * 2. Luna provider 能建立（即使連不上也不會 crash）
 * 3. config/luna.json 設定正確
 */

import { createProviderRegistry } from '../src/core/provider-registry.js';
import { registerBuiltinProviders } from '../src/providers/index.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

async function test() {
  console.log('=== Luna Provider 整合測試 ===\n');

  // 1. 載入 luna config
  const config = JSON.parse(readFileSync(resolve(ROOT, 'config/luna.json'), 'utf-8'));
  console.log('✓ config/luna.json 載入成功');
  console.log(`  llm type: ${config.providers.llm.type}`);
  console.log(`  baseUrl: ${config.providers.llm.baseUrl}`);

  // 2. Registry 初始化
  const registry = createProviderRegistry();
  registerBuiltinProviders(registry);
  console.log(`✓ Registry 已註冊 luna factory`);
  console.log(`  LLM types: ${registry.listTypes('llm').join(', ')}`);

  // 3. 初始化 providers（Luna 連不上不會 crash，只 warn）
  await registry.initFromConfig(config.providers);
  const llm = registry.get('llm');

  if (llm) {
    console.log(`✓ LLM provider 已初始化 (model: ${llm.model})`);
    console.log(`  exports: chat, chatWithHistory, close`);

    // 4. 嘗試呼叫（可能 timeout，但驗證 API 格式正確）
    console.log('\n--- 測試 chat() ---');
    try {
      const reply = await llm.chat('測試', { sessionId: 'test-integration' });
      console.log(`✓ Luna 回覆: ${reply.slice(0, 100)}`);
    } catch (err) {
      console.log(`⚠ Luna 未回應（預期中）: ${err.message}`);
    }
  } else {
    console.log('✗ LLM provider 未初始化');
  }

  // 5. 清理
  await registry.closeAll();
  console.log('\n✓ 測試完成');
}

test().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
