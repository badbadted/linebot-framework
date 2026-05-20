/**
 * Scope 過濾測試
 */

import { createRouter } from '../src/core/router.js';

const router = createRouter();

// 註冊不同 scope 的路由
router.add(/^\/ping$/i, async () => 'pong', { name: 'ping', scope: 'all' });
router.add(/^\/todo$/i, async () => '待辦清單', { name: 'todo', scope: 'private' });
router.add(/^\/group_info$/i, async () => '群組資訊', { name: 'group_info', scope: 'group' });

console.log('=== Scope 過濾測試 ===\n');

// /ping — all scope，任何地方都能用
let r = router.match('/ping', { sourceType: 'user' });
console.log(`/ping (私訊):   matched=${r.matched}, blocked=${r.scopeBlocked} ✓`);
r = router.match('/ping', { sourceType: 'group' });
console.log(`/ping (群組):   matched=${r.matched}, blocked=${r.scopeBlocked} ✓`);

// /todo — private only
r = router.match('/todo', { sourceType: 'user' });
console.log(`/todo (私訊):   matched=${r.matched}, blocked=${r.scopeBlocked} ✓`);
r = router.match('/todo', { sourceType: 'group' });
console.log(`/todo (群組):   matched=${r.matched}, blocked=${r.scopeBlocked} → 應被擋 ✓`);
r = router.match('/todo', { sourceType: 'room' });
console.log(`/todo (聊天室): matched=${r.matched}, blocked=${r.scopeBlocked} → 應被擋 ✓`);

// /group_info — group only
r = router.match('/group_info', { sourceType: 'group' });
console.log(`/group_info (群組): matched=${r.matched}, blocked=${r.scopeBlocked} ✓`);
r = router.match('/group_info', { sourceType: 'user' });
console.log(`/group_info (私訊): matched=${r.matched}, blocked=${r.scopeBlocked} → 應被擋 ✓`);

// 未匹配的
r = router.match('你好', { sourceType: 'user' });
console.log(`'你好' (私訊):  matched=${r.matched} → 未匹配 ✓`);

// scopeId 邏輯驗證（模擬 webhook 邏輯）
function getScopeId(userId, groupId, roomId) {
  return groupId || roomId || userId;
}
console.log(`\nscopeId 私訊:  ${getScopeId('U001', null, null)} → U001`);
console.log(`scopeId 群組:  ${getScopeId('U001', 'C_group1', null)} → C_group1`);
console.log(`scopeId 聊天室: ${getScopeId('U001', null, 'R_room1')} → R_room1`);

console.log('\n✓ 測試完成');
