/**
 * 「沒人要用的回覆」規則測試（core/idle-reply.js）：只在確定沒人會回時才交給 plugin，不搶指令或其他 plugin 的回覆
 * 執行：node tests/test-idle-reply.mjs
 */

import assert from 'node:assert/strict';
import { idleAllowed, idleEvent, runIdleHooks } from '../src/core/idle-reply.js';

let pass = 0;
async function test(name, fn) { await fn(); pass++; console.log(`✓ ${name}`); }

await test('群組文字：沒開 _llm 才可以；私訊、/ 開頭、開了 _llm 的群都不行', () => {
  assert.equal(idleAllowed({ isGroup: true, text: '大家好', groupPerms: ['niujiu'] }), true);
  assert.equal(idleAllowed({ isGroup: true, text: '大家好', groupPerms: ['niujiu', '_llm'] }), false); // AI 會自動回
  assert.equal(idleAllowed({ isGroup: false, text: '嗨' }), false);
  assert.equal(idleAllowed({ isGroup: true, text: '/妞揪 列表', groupPerms: [] }), false);          // 打錯的指令
});

await test('貼圖、照片、位置有回覆就可以；文字訊息不走這條', () => {
  assert.equal(idleEvent({ replyToken: 't', message: { type: 'sticker' } }), true);
  assert.equal(idleEvent({ replyToken: 't', message: { type: 'image' } }), true);
  assert.equal(idleEvent({ replyToken: 't', message: { type: 'text' } }), false);
  assert.equal(idleEvent({ message: { type: 'sticker' } }), false);
});

await test('plugin 依序問，有一個用了就停；出錯不影響', async () => {
  const calls = [];
  const hooks = [
    { plugin: 'a', fn: async () => { calls.push('a'); throw new Error('壞了'); } },
    { plugin: 'b', fn: async () => { calls.push('b'); return true; } },
    { plugin: 'c', fn: async () => { calls.push('c'); return true; } },
  ];
  assert.equal(await runIdleHooks(hooks, { chatId: 'C', replyToken: 't' }), true);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(await runIdleHooks([], {}), false);
});

console.log(`\n${pass} 項全部通過`);
