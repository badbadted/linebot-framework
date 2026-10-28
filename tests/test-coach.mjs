/**
 * 健身教練測試（不打 AI、不連 LINE）
 * 執行：node tests/test-coach.mjs
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as P from '../plugins/coach/program.js';
import coach, { parseFitness, applyFitness, aboutFitness, fitnessSection, setPushListener, cleanLog } from '../plugins/coach/index.js';
import { extractJson, salvageString, proseBefore } from '../src/utils/llm-json.js';

let pass = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`✓ ${name}`); }
  catch (err) { console.error(`✗ ${name}`); throw err; }
}

// 台北 2026-10-26（一）08:00 = UTC 00:00
const MON = Date.UTC(2026, 9, 26, 0, 0, 0);

await test('加重規則：全做到 15 下加重、多數不到 10 下退、其他照舊', () => {
  assert.equal(P.nextWeight('squat', null).kg, null);
  assert.equal(P.nextWeight('squat', [{ kg: 40, reps: 15 }, { kg: 40, reps: 15 }, { kg: 40, reps: 16 }]).kg, 45);
  assert.equal(P.nextWeight('bench', [{ kg: 30, reps: 15 }, { kg: 30, reps: 15 }]).kg, 32.5);
  assert.equal(P.nextWeight('squat', [{ kg: 40, reps: 12 }, { kg: 40, reps: 11 }, { kg: 40, reps: 10 }]).kg, 40);
  assert.equal(P.nextWeight('squat', [{ kg: 60, reps: 8 }, { kg: 60, reps: 7 }, { kg: 60, reps: 12 }]).kg, 55);
  // 熱身組比較輕不影響判斷：只看最重那幾組
  assert.equal(P.nextWeight('bench', [{ kg: 20, reps: 8 }, { kg: 30, reps: 15 }, { kg: 30, reps: 15 }]).kg, 32.5);
});

await test('課表：不分化三動作、組數隨次數加、雙分化輪替、休息日', () => {
  const p = { phase: 'full3', trainDays: [1, 3, 5] };
  const plan = P.todayPlan(p, 0, {}, MON);
  assert.deepEqual(plan.items.map(i => i.id), ['squat', 'bench', 'row']);
  assert.equal(plan.sets, 3);
  assert.equal(P.todayPlan(p, 7, {}, MON).sets, 4);
  assert.equal(P.todayPlan(p, 20, {}, MON).sets, 5);
  assert.equal(P.todayPlan({ ...p, trainDays: [2, 4, 6] }, 0, {}, MON), null);
  const s = { phase: 'split4', trainDays: [1, 2, 4, 5] };
  assert.equal(P.todayPlan(s, 0, {}, MON).name, '下肢 A');
  assert.equal(P.todayPlan(s, 1, {}, MON).name, '上肢 A');
  assert.equal(P.todayPlan(s, 5, {}, MON).name, '上肢 A');
  assert.match(P.planText(plan), /深蹲：找起始重量/);
});

await test('營養與體重趨勢', () => {
  assert.deepEqual(P.nutrition(60), { protein: 108, carbs: 360 });
  assert.equal(P.weightAdvice([{ date: '2026-10-26', kg: 60 }]).level, 'start');
  assert.equal(P.weightAdvice([{ date: '2026-10-19', kg: 60 }, { date: '2026-10-26', kg: 60.4 }]).level, 'up');
  assert.equal(P.weightAdvice([{ date: '2026-10-19', kg: 60 }, { date: '2026-10-26', kg: 60 }]).level, 'watch');
  assert.equal(P.weightAdvice([{ date: '2026-10-12', kg: 60 }, { date: '2026-10-19', kg: 60 }, { date: '2026-10-26', kg: 59.8 }]).level, 'add');
  // 同一週量兩次取最後一次
  assert.equal(P.weightAdvice([{ date: '2026-10-19', kg: 60 }, { date: '2026-10-26', kg: 59 }, { date: '2026-10-28', kg: 61 }]).level, 'up');
});

await test('設定驗證、缺項、連兩天練全身警告、cron', () => {
  let { p, problems } = P.mergeProfile(null, { weight_kg: 58.25, train_days: [5, 1, 3, 3], remind_time: '07:30' });
  assert.deepEqual(problems, []);
  assert.equal(p.weightKg, 58.3);
  assert.deepEqual(p.trainDays, [1, 3, 5]);
  assert.equal(p.phase, 'full3');
  assert.deepEqual(P.missingProfile(p), ['晚上幾點問你練了沒']);
  ({ p, problems } = P.mergeProfile(p, { weight_kg: 999, remind_time: '7點', train_days: [1] }));
  assert.equal(problems.length, 3);
  assert.equal(p.weightKg, 58.3);
  assert.equal(P.scheduleWarning({ phase: 'full3', trainDays: [1, 2, 4] }).length > 0, true);
  assert.equal(P.scheduleWarning({ phase: 'full3', trainDays: [1, 3, 5] }), '');
  assert.equal(P.scheduleWarning({ phase: 'full3', trainDays: [0, 2, 6] }).length > 0, true); // 六、日連著
  assert.equal(P.cronAt('07:30', [1, 3, 5]), '30 7 * * 1,3,5');
});

await test('parseFitness／cleanLog', () => {
  const o = parseFitness({ reply: '讚', log: [{ exercise: '深蹲', sets: [[40, 12], [40, 12]] }], weigh_in: 60.5, session: 'done' });
  assert.equal(o.weighIn, 60.5);
  assert.equal(o.session, 'done');
  assert.equal(o.log.length, 1);
  assert.equal(parseFitness({ reply: '嗨' }), null); // 沒有健身欄位
  assert.equal(parseFitness({ weigh_in: true }), null);
  assert.equal(parseFitness(null), null);
  assert.deepEqual(cleanLog({ exercise: '划船', sets: [[30, 12], { kg: 30, reps: 11 }, [30, 0], ['x', 5]] }, '2026-10-26').sets, [{ kg: 30, reps: 12 }, { kg: 30, reps: 11 }]);
  assert.match(cleanLog({ exercise: '捲腹', sets: [[0, 20]] }, '2026-10-26').error, /不認得/);
  assert.equal(cleanLog({ exercise: '深蹲', sets: [[40, 10]], date: '2026-10-24' }, '2026-10-26').date, '2026-10-24');
  assert.equal(cleanLog({ exercise: '深蹲', sets: [[40, 10]], date: '2026-09-01' }, '2026-10-26').date, '2026-10-26');
});

await test('健身技能：設定齊了才排提醒、記訓練與體重、提醒推播通知小帥', async () => {
  const raw = new Database(':memory:');
  const db = { run: (q, ...a) => raw.prepare(q).run(...a), get: (q, ...a) => raw.prepare(q).get(...a), all: (q, ...a) => raw.prepare(q).all(...a), exec: (q) => raw.exec(q) };
  const jobs = new Map();
  const pushed = [];
  await coach.init({
    db,
    lineApi: { reply: async () => {}, push: async (uid, text) => pushed.push(text) },
    scheduler: { add: (name, cron, fn) => jobs.set(name, { cron, fn }) },
    isAdmin: (u) => u === 'UADMIN',
  });
  assert.equal(coach.onPrivateText, undefined); // 不再自己接私訊（私訊一律是小帥）
  assert.equal(aboutFitness('UADMIN', '明天天氣如何'), false);
  assert.equal(aboutFitness('UADMIN', '小帥 我要開始健身'), true);

  let out = applyFitness('UADMIN', parseFitness({ profile: { weight_kg: 58, train_days: [1, 3, 5], remind_time: '07:30' } }));
  assert.match(out, /還需要知道：晚上幾點問你練了沒/);
  assert.equal(jobs.size, 0);
  // 剛聊過健身 → 不提健身也帶資料
  assert.equal(aboutFitness('UADMIN', '晚上九點'), true);
  out = applyFitness('UADMIN', parseFitness({ profile: { checkin_time: '21:00' } }));
  assert.match(out, /設定好了/);
  assert.match(out, /蛋白質 104 克、碳水 348 克/);
  assert.equal([...jobs.values()].map(j => j.cron).join('|'), '30 7 * * 1,3,5|0 21 * * 1,3,5|0 7 * * 1');

  out = applyFitness('UADMIN', parseFitness({ log: [{ exercise: '深蹲', sets: [[40, 15], [40, 15], [40, 15]] }, { exercise: '臥推', sets: [[30, 12], [30, 11], [30, 10]] }] }));
  assert.match(out, /深蹲 40×15、40×15、40×15 → 下次 45 公斤/);
  assert.match(out, /臥推 30×12、30×11、30×10 → 下次 30 公斤/);
  assert.equal(db.get("SELECT COUNT(*) n FROM sessions WHERE status = 'done'").n, 1);
  out = applyFitness('UADMIN', parseFitness({ weigh_in: 58.6 }));
  assert.match(out, /記下 58.6 公斤/);
  // 給小帥的 prompt 段落有指引與系統資料
  const sec = fitnessSection('UADMIN');
  assert.match(sec, /【健身教練】[\s\S]*"log"/);
  assert.match(sec, /這個階段已完成 1 次訓練/);
  // 推提醒時通知小帥（記成小帥說過的話）
  const heard = [];
  setPushListener((uid, text) => heard.push([uid, text]));
  await jobs.get(`coach-weigh-${'UADMIN'.slice(-6)}`).fn();
  assert.equal(pushed.length, 1);
  assert.deepEqual(heard, [['UADMIN', pushed[0]]]);
  setPushListener(null);
});

await test('llm-json 工具', () => {
  assert.deepEqual(extractJson('前言 {"a":{"b":1}} 後記 {"c":2}'), { a: { b: 1 } });
  assert.equal(extractJson('{壞掉 {"ok":true}').ok, true);
  assert.equal(extractJson('沒有 JSON'), null);
  assert.equal(extractJson('[1,2]'), null);
  assert.equal(salvageString('{"reply":"引號\\"與\\u5c0f帥\\n下一行'), '引號"與小帥\n下一行');
  assert.equal(salvageString('{"reply":"斷在跳脫\\'), '斷在跳脫');
  assert.equal(salvageString('{"x":1}'), '');
  assert.equal(proseBefore('嗨\n```json\n{"reply":"x"'), '嗨');
});

console.log(`\n${pass} 項全部通過`);
