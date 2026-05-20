/**
 * Logger 單元測試
 */

import { createLogger } from '../src/core/logger.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = resolve(__dirname, '../data/test-logs');

// 清理測試 DB
try { rmSync(resolve(TEST_DIR, '_logs.db'), { force: true }); } catch {}
try { rmSync(resolve(TEST_DIR, '_logs.db-wal'), { force: true }); } catch {}
try { rmSync(resolve(TEST_DIR, '_logs.db-shm'), { force: true }); } catch {}

const logger = createLogger(TEST_DIR);

console.log('=== Logger 測試 ===\n');

// 1. 寫入測試
logger.log({ userId: 'U001', sourceType: 'user', text: '/ping', route: 'ping', plugin: 'echo', type: 'query', response: 'pong 🏓', durationMs: 5 });
logger.log({ userId: 'U001', sourceType: 'user', text: '/todo_add 買牛奶', route: 'todo_add', plugin: 'todo', type: 'query', response: '✅ 已新增 #1：買牛奶', durationMs: 12 });
logger.log({ userId: 'U002', sourceType: 'user', text: '你好', route: 'unmatched', type: 'fallback', durationMs: 850 });
logger.log({ userId: 'U001', sourceType: 'user', text: '/echo 測試', route: 'echo', plugin: 'echo', type: 'query', response: '測試', durationMs: 3 });
logger.log({ userId: 'U003', sourceType: 'group', text: '/help', route: 'help', plugin: '_system', type: 'query', response: '📖 可用指令...', durationMs: 2 });
logger.log({ userId: 'U001', sourceType: 'user', text: '打開冷氣', route: 'unmatched', type: 'fallback', durationMs: 1200, error: 'Luna timeout after 30000ms' });

console.log('✓ 寫入 6 筆記錄');

// 2. 查詢測試
const all = logger.query({ limit: 10 });
console.log(`✓ 查全部: ${all.total} 筆, 回傳 ${all.logs.length} 筆`);
console.log(`  最新一筆: ${all.logs[0].text} → ${all.logs[0].error || all.logs[0].response || '(無回覆)'}`);

const byUser = logger.query({ userId: 'U001' });
console.log(`✓ 查 U001: ${byUser.total} 筆`);

const errOnly = logger.query({ hasError: true });
console.log(`✓ 查錯誤: ${errOnly.total} 筆`);

// 3. 統計測試
const s = logger.stats(7);
console.log(`\n✓ 統計（7天）:`);
console.log(`  總訊息: ${s.total}`);
console.log(`  錯誤: ${s.errors}`);
console.log(`  未匹配: ${s.unmatched}`);
console.log(`  指令排行: ${s.topRoutes.map(r => `${r.route}(${r.count})`).join(', ')}`);
console.log(`  活躍使用者: ${s.topUsers.map(u => `${u.user_id}(${u.count})`).join(', ')}`);

// 清理
logger.close();
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}

console.log('\n✓ 測試完成');
