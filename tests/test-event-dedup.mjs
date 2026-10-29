// 測試：webhook 事件去重存 DB（重開後還認得）、LINE 重送的事件放寬到 30 分鐘
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventDedup, createMemoryDedup } from '../src/core/event-dedup.js';
import { eventFresh } from '../src/core/webhook.js';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`✓ ${name}`); };

await test('去重存 DB：重開（新的實例）後還認得處理過的事件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dedup-'));
  try {
    const a = createEventDedup(dir);
    assert.equal(a.has('E1'), false);
    a.add('E1');
    assert.equal(a.has('E1'), true);
    a.close();
    const b = createEventDedup(dir);           // 模擬 bot 重開
    assert.equal(b.has('E1'), true);
    assert.equal(b.has('E2'), false);
    b.add('OLD', Date.now() - 2 * 3600_000);   // 超過一小時的會被清掉
    assert.equal(b.purge(), 1);
    assert.equal(b.has('OLD'), false);
    b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('記憶體版去重', () => {
  const m = createMemoryDedup();
  m.add('X');
  assert.equal(m.has('X'), true);
  assert.equal(m.has('Y'), false);
});

await test('事件新舊：一般 5 分鐘；LINE 重送放寬到 30 分鐘', () => {
  const now = Date.now();
  assert.equal(eventFresh({ timestamp: now - 60_000 }, now), true);
  assert.equal(eventFresh({ timestamp: now - 10 * 60_000 }, now), false);
  assert.equal(eventFresh({ timestamp: now - 10 * 60_000, deliveryContext: { isRedelivery: true } }, now), true);
  assert.equal(eventFresh({ timestamp: now - 40 * 60_000, deliveryContext: { isRedelivery: true } }, now), false);
  assert.equal(eventFresh({ timestamp: now - 10 * 60_000, deliveryContext: { isRedelivery: false } }, now), false);
});

console.log(`\n${pass} 項全部通過`);
