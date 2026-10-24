/**
 * Gate 權限測試：私訊限管理員；群組成員可開、可查，不能關、不能延長
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 假的開關腳本：照參數回固定 JSON，不碰真的 web-hub
const dir = mkdtempSync(join(tmpdir(), 'gate-test-'));
const fake = join(dir, 'fake-gate.mjs');
writeFileSync(fake, `
const cmd = process.argv[2];
const out = {
  start: { ok: true, url: 'https://example.test', closesAtText: '18:00', minutesLeft: 120 },
  status: { ok: true, open: false },
  stop: { ok: true, wasOpen: true },
  extend: { ok: true, closesAtText: '19:00', minutesLeft: 180 },
}[cmd];
console.log(JSON.stringify(out));
`);
process.env.WEB_GATE_SCRIPT = fake;

const { default: plugin, canUse } = await import('../plugins/gate/index.js');

let fail = 0;
function check(label, cond) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fail++;
}

console.log('=== canUse ===');
check('管理員私訊可關', canUse({ admin: true, sourceType: 'user', memberOk: false }));
check('非管理員私訊不能開', !canUse({ admin: false, sourceType: 'user', memberOk: true }));
check('群組成員可開', canUse({ admin: false, sourceType: 'group', memberOk: true }));
check('聊天室成員不能開（room 無法開通）', !canUse({ admin: false, sourceType: 'room', memberOk: true }));
check('群組成員不能關', !canUse({ admin: false, sourceType: 'group', memberOk: false }));

console.log('\n=== handler（非管理員）===');
check('plugin 範圍改為 all', plugin.scope === 'all');
const cmd = (name) => plugin.commands.find((c) => c.name === name);
const group = { userId: 'U-not-admin', sourceType: 'group' };
const priv = { userId: 'U-not-admin', sourceType: 'user' };
const run = (name, ctx, text) => cmd(name).handler(text.match(cmd(name).pattern), ctx);

const opened = await run('gate-open', group, '/開遊戲 2小時');
check('群組成員 /開遊戲 成功', opened.includes('已開放外網'));
check('成員看到「找管理員」而非 /關遊戲 說明', opened.includes('請找管理員') && !opened.includes('/關遊戲'));
check('群組成員 /遊戲狀態 可查', (await run('gate-status', group, '/遊戲狀態')).includes('外網目前關閉'));
check('群組成員 /關遊戲 被擋', (await run('gate-close', group, '/關遊戲')).includes('只有管理員'));
check('群組成員 /延長 被擋', (await run('gate-extend', group, '/延長 1小時')).includes('只有管理員'));
check('私訊非管理員 /開遊戲 被擋', (await run('gate-open', priv, '/開遊戲')) === '這個指令只有管理員能用。');

// 開關腳本壞掉時，成員只看到通用訊息，不看到內部錯誤
writeFileSync(fake, `process.stderr.write('boom /secret/path'); process.exit(2);`);
check('開關失敗時成員只看到通用訊息', (await run('gate-open', group, '/開遊戲')) === '開關暫時無法使用，請找管理員。');
check('開關失敗時查狀態也是通用訊息', (await run('gate-status', group, '/遊戲狀態')) === '開關暫時無法使用，請找管理員。');

console.log('\n=== router：聊天室走群組權限 ===');
const { createRouter } = await import('../src/core/router.js');
const router = createRouter();
router.setGroupPermissions({ Cgroup: ['gate'] });
router.add(cmd('gate-open').pattern, async () => 'x', { name: 'gate-open', plugin: 'gate', scope: 'all' });
check('開通的群組不擋', !router.match('/開遊戲', { sourceType: 'group', groupId: 'Cgroup' }).groupBlocked);
check('沒開通的群組擋', router.match('/開遊戲', { sourceType: 'group', groupId: 'Cother' }).groupBlocked);
check('聊天室帶 roomId 會擋', router.match('/開遊戲', { sourceType: 'room', groupId: 'Rroom' }).groupBlocked);

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
