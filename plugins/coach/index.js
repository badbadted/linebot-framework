/**
 * Coach Plugin — 小帥的健身技能（只給管理員本人）＋訓練提醒排程
 *
 * 2026-10-28 起只有一個小帥：私訊對話一律由 xiaoshuai 回，講到健身時它向這裡拿【健身資料】放進 prompt，
 * AI 給的設定、訓練紀錄、體重交回 applyFitness() 寫進資料（本 plugin 不再自己跟人對話、不再有另一份人設）。
 * 訓練日 早上推今天課表、晚上沒回報就問練了沒；每週一早上提醒空腹量體重（推播由程式產生，不花 AI）。
 * 課表、加重、組數、營養目標、體重趨勢都由 program.js 算（AI 只負責聽懂你說什麼、把數字交給程式）。
 *
 * /教練            設定、本週課表、營養目標
 * /教練 紀錄        最近的訓練與體重
 * /教練 暫停｜恢復   停／開提醒
 *
 * 需求 Provider：db（SQLite）
 */

import * as P from './program.js';

const WINDOW_MS = 10 * 60_000;   // 講過健身（或推過提醒）後多久內，不必再提到健身也帶健身資料
export const FITNESS_RE = /教練|健身|運動|重訓|訓練|課表|練了|練完|有練|沒練|去練|深蹲|臥推|划船|硬舉|肩推|下拉|腿推|體重|增重|增肌|蛋白質|碳水|休息日|\d+\s*(kg|公斤)/i;

let db, lineApi, scheduler, isAdmin;
const lastFitnessAt = new Map(); // userId → 上次聊健身／推提醒的時間
let pushListener = null;         // 小帥：推了提醒就記進私訊對話，下一句接得上

// ── 資料 ───────────────────────────────────────────

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now','+8 hours'))
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      ex TEXT NOT NULL,
      sets TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','+8 hours'))
    );
    CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id, ex, date);
    CREATE TABLE IF NOT EXISTS sessions (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      PRIMARY KEY (user_id, date)
    );
    CREATE TABLE IF NOT EXISTS weights (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      kg REAL NOT NULL,
      PRIMARY KEY (user_id, date)
    );
    CREATE TABLE IF NOT EXISTS chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL
    );
  `);
}

const getProfile = (uid) => {
  const r = db.get('SELECT data, paused FROM profile WHERE user_id = ?', uid);
  return r ? { ...JSON.parse(r.data), paused: !!r.paused } : null;
};
function saveProfile(uid, p) {
  const { paused, ...data } = p;
  db.run(`INSERT INTO profile (user_id, data, paused) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now','+8 hours')`, uid, JSON.stringify(data), paused ? 1 : 0);
}
const doneInPhase = (uid, phase) => db.get("SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND phase = ? AND status = 'done'", uid, phase).n;
const sessionOn = (uid, date) => db.get('SELECT status FROM sessions WHERE user_id = ? AND date = ?', uid, date)?.status || null;
function lastLogs(uid) {
  const out = {};
  for (const id of Object.keys(P.EXERCISES)) {
    const r = db.get('SELECT sets FROM logs WHERE user_id = ? AND ex = ? ORDER BY date DESC, id DESC LIMIT 1', uid, id);
    if (r) out[id] = JSON.parse(r.sets);
  }
  return out;
}
const weightsOf = (uid) => db.all('SELECT date, kg FROM weights WHERE user_id = ? ORDER BY date', uid);

function todayPlanFor(uid, p, now = Date.now()) {
  return P.todayPlan(p, doneInPhase(uid, p.phase || 'full3'), lastLogs(uid), now);
}

// ── 推播（程式產生，不花 AI）──────────────────────────

async function push(uid, text) {
  try {
    await lineApi.push(uid, text);
    lastFitnessAt.set(uid, Date.now());
    try { pushListener?.(uid, text); } catch (err) { console.warn(`[coach] 記推播失敗：${err.message}`); }
  } catch (err) { console.error(`[coach] push 失敗：${err.message}`); }
}

function registerSchedules(uid) {
  const p = getProfile(uid);
  const tag = uid.slice(-6);
  const ok = p && !P.missingProfile(p).length;
  const jobs = [
    [`coach-remind-${tag}`, ok && P.cronAt(p.remindTime, p.trainDays), remindJob, '訓練日推今天課表'],
    [`coach-checkin-${tag}`, ok && P.cronAt(p.checkinTime, p.trainDays), checkinJob, '訓練日晚上沒回報就問練了沒'],
    [`coach-weigh-${tag}`, ok && P.cronAt(p.weighTime || '07:00', [1]), weighJob, '每週一提醒空腹量體重'],
  ];
  for (const [name, cron, fn, describe] of jobs) {
    if (!cron) continue;
    scheduler.add(name, cron, () => fn(uid), { plugin: 'coach', describe });
  }
}

async function remindJob(uid) {
  const p = getProfile(uid);
  if (!p || p.paused) return;
  const plan = todayPlanFor(uid, p);
  if (!plan) return;
  const n = P.nutrition(p.weightKg);
  await push(uid, `早安！${P.planText(plan)}${n ? `\n🍚 今天吃到蛋白質 ${n.protein} 克、碳水 ${n.carbs} 克` : ''}`);
}

async function checkinJob(uid) {
  const p = getProfile(uid);
  if (!p || p.paused) return;
  const { date } = P.taipeiDay();
  if (sessionOn(uid, date)) return;
  const plan = todayPlanFor(uid, p);
  if (!plan) return;
  await push(uid, `今天的${plan.name}練了嗎？練完跟我說重量和每組次數（例如「深蹲 40 12 12 11」）；今天沒練也說一聲，課表會順延到下次。`);
}

async function weighJob(uid) {
  const p = getProfile(uid);
  if (!p || p.paused) return;
  await push(uid, '週一早安 ⚖️ 起床上完廁所、還沒吃東西前量一下體重，跟我說幾公斤。');
}

// ── 給小帥用的健身技能 ──────────────────────────────

/** 推了提醒要通知誰（小帥把它記成自己說過的話） */
export const setPushListener = (fn) => { pushListener = fn; };
export const ready = () => !!db;

/** 這句要不要帶健身資料：講到健身，或 10 分鐘內聊過健身／推過提醒 */
export function aboutFitness(uid, text, now = Date.now()) {
  if (!db || !uid) return false;
  return FITNESS_RE.test(String(text || '')) || now - (lastFitnessAt.get(uid) || 0) < WINDOW_MS;
}

export const FITNESS_GUIDE = `你也是他（管理員）私人的健身教練。訓練觀念（照這套帶他，他是極瘦、想增重增肌的上班族新手）：
- 超量恢復：同一部位練完要 48～72 小時恢復，之後有短暫高峰，要在高峰再練。所以新手不分化、一週三練全身，中間隔一天；不要一週一部位的五分化、四分化，也不要一週只練三天的三分化。
- 動作做減法：新手只練深蹲、臥推、划船三個大動作，先練好神經適應、快速上強度。深蹲最重要，臥推、划船次之。
- 強度：10～15RM、每動作 3～6 組；極瘦的人先不要碰 8 下以內的大重量，免得受傷。
- 練幾個月後可以進階成雙分化（上下肢、練四休三），單部位隔 3～4 天。一週練六天會累積神經疲勞、失眠，不要。
- 飲食：每天蛋白質每公斤 1.8 克、碳水每公斤 6 克，脂肪正常吃；前一兩個月用食物秤記，避免「感覺很飽其實不夠」。少量多餐一天五六餐，每 3 小時吃一次、七八分飽，加餐可以帶香蕉、麵包、保久乳、茶葉蛋；吃不下就從兩餐中間多一根香蕉開始，兩週後再加。早餐一定要吃。
- 每週一早上空腹量體重；連一兩週沒漲就是吃不夠，要加主食。
- 把健身當長期的興趣，保留生活餘裕，比硬撐重要。
健身的界線：
- 課表、建議重量、組數、營養目標、體重判斷都由系統算好（下面【健身資料】），照著講，不要自己改數字或編紀錄。
- 有痛（關節、下背、胸口）或頭暈，就叫他停下來、休息，持續不舒服要看醫生；不給醫療診斷，不推薦藥物、補充劑劑量。
- 健身的事可以講長一點：解釋觀念時最多約 200 字。
他講到健身的這些事時，JSON 再加這些欄位（只放他這次真的講到的，沒講不要填）：
- "profile": {"weight_kg":數字,"height_cm":數字,"train_days":[星期數字，日=0、一=1…六=6],"remind_time":"HH:mm","checkin_time":"HH:mm","weigh_time":"HH:mm","phase":"full3 或 split4（他說要換課表才填）"}
- "log": [{"exercise":"深蹲／臥推／槓鈴划船／站姿肩推／羅馬尼亞硬舉／上斜啞鈴臥推／滑輪下拉／腿推","sets":[[公斤,次數],…],"date":"YYYY-MM-DD，不是今天練的才填"}]（例如「深蹲 40 12 12 11」＝[[40,12],[40,12],[40,11]]）
- "weigh_in": 數字（他回報今天量的體重）
- "session": "done"（說練完了但沒給數字）或 "skip"（今天沒練、要休息）
reply 不用重複列課表或紀錄，系統會把記下的內容和下次建議附在後面；你就鼓勵、回答問題、提醒重點。`;

/** 給小帥 prompt 的健身段落（指引＋這個人的設定、今天課表、體重） */
export function fitnessSection(uid, now = Date.now()) {
  if (!db) return '';
  lastFitnessAt.set(uid, now);
  return `\n\n【健身教練】\n${FITNESS_GUIDE}\n\n【健身資料】（系統算好的，照著講）\n${systemData(uid, getProfile(uid), now)}`;
}

/** AI 回的 JSON 物件裡的健身欄位；都沒有回 null */
export function parseFitness(o) {
  if (!o || typeof o !== 'object') return null;
  const f = {
    profile: o.profile && typeof o.profile === 'object' && !Array.isArray(o.profile) ? o.profile : null,
    log: Array.isArray(o.log) ? o.log : [],
    weighIn: Number.isFinite(+o.weigh_in) && o.weigh_in !== null && o.weigh_in !== '' && typeof o.weigh_in !== 'boolean' ? +o.weigh_in : null,
    session: ['done', 'skip'].includes(o.session) ? o.session : null,
  };
  return f.profile || f.log.length || f.weighIn !== null || f.session ? f : null;
}

function systemData(uid, p, now = Date.now()) {
  const { date, dow } = P.taipeiDay(now);
  const lines = [`今天：${date}（週${P.WEEK[dow]}）`];
  if (p) {
    lines.push('〔他的設定〕', P.profileText(p));
    const miss = P.missingProfile(p);
    if (miss.length) lines.push(`還不知道：${miss.join('、')}（系統會在你的回覆後面列出來問，你不要再問一次，回應他剛說的就好）`);
    const plan = todayPlanFor(uid, p, now);
    lines.push(plan ? `〔今天的課表〕\n${P.planText(plan)}` : '〔今天〕休息日');
    const st = sessionOn(uid, date);
    if (st) lines.push(`今天狀態：${st === 'done' ? '已練完' : '說今天不練'}`);
    lines.push(`這個階段已完成 ${doneInPhase(uid, p.phase || 'full3')} 次訓練`);
  } else {
    lines.push('〔他的設定〕還沒有（第一次聊健身，說明你會怎麼帶他）');
  }
  const w = weightsOf(uid).slice(-4);
  if (w.length) lines.push(`〔最近體重〕${w.map(x => `${x.date.slice(5)} ${x.kg}`).join('、')}`);
  return lines.join('\n');
}

/** AI 給的一筆訓練 → { ex, sets, date } 或錯誤 */
export function cleanLog(item, today) {
  const ex = P.exerciseId(item?.exercise);
  if (!ex) return { error: `不認得「${String(item?.exercise || '').slice(0, 10)}」這個動作` };
  const sets = (Array.isArray(item.sets) ? item.sets : []).slice(0, 10)
    .map(s => (Array.isArray(s) ? { kg: +s[0], reps: +s[1] } : { kg: +s?.kg, reps: +s?.reps }))
    .filter(s => Number.isFinite(s.kg) && s.kg >= 0 && s.kg <= 500 && Number.isInteger(s.reps) && s.reps >= 1 && s.reps <= 100);
  if (!sets.length) return { error: `${P.EXERCISES[ex].name}的重量次數看不懂` };
  let date = today;
  if (typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
    const back = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${item.date}T00:00:00Z`)) / 86_400_000;
    if (back >= 0 && back <= 7) date = item.date;
  }
  return { ex, sets, date };
}

/**
 * 把 AI 聽懂的內容寫進資料；回傳要接在 reply 後面的文字
 * @param parsed parseFitness() 的結果（null＝這句沒有新資料，只補問還缺的設定）
 */
export function applyFitness(uid, parsed, now = Date.now()) {
  if (!db) return '';
  parsed = parsed || { profile: null, log: [], weighIn: null, session: null };
  lastFitnessAt.set(uid, now);
  const { date: today } = P.taipeiDay(now);
  const out = [];
  let p = getProfile(uid);
  const wasReady = p && !P.missingProfile(p).length;

  if (parsed.profile || !p) {
    const { p: np, problems } = P.mergeProfile(p, parsed.profile);
    if (parsed.profile?.phase && p?.phase && parsed.profile.phase !== p.phase) out.push(`🔁 課表換成${P.PHASES[np.phase].name}`);
    saveProfile(uid, { ...np, paused: p?.paused });
    p = getProfile(uid);
    if (problems.length) out.push(`⚠️ ${problems.join('；')}`);
  }

  if (parsed.weighIn !== null) {
    if (parsed.weighIn >= 30 && parsed.weighIn <= 200) {
      db.run('INSERT INTO weights (user_id, date, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg', uid, today, parsed.weighIn);
      saveProfile(uid, { ...p, weightKg: parsed.weighIn });
      p = getProfile(uid);
      const n = P.nutrition(p.weightKg);
      out.push(`⚖️ 記下 ${parsed.weighIn} 公斤。${P.weightAdvice(weightsOf(uid)).text}\n🍚 每天目標：蛋白質 ${n.protein} 克、碳水 ${n.carbs} 克`);
    } else out.push('⚠️ 體重看不懂');
  }

  const logged = [];
  for (const item of parsed.log.slice(0, 8)) {
    const r = cleanLog(item, today);
    if (r.error) { out.push(`⚠️ ${r.error}`); continue; }
    db.run('INSERT INTO logs (user_id, date, ex, sets) VALUES (?, ?, ?, ?)', uid, r.date, r.ex, JSON.stringify(r.sets));
    const nx = P.nextWeight(r.ex, r.sets);
    logged.push(`・${P.EXERCISES[r.ex].name} ${r.sets.map(s => `${s.kg}×${s.reps}`).join('、')} → 下次 ${nx.kg} 公斤（${nx.why}）`);
    if (!sessionOn(uid, r.date)) db.run('INSERT INTO sessions (user_id, date, status, phase) VALUES (?, ?, ?, ?)', uid, r.date, 'done', p.phase || 'full3');
  }
  if (logged.length) out.push(`📝 記下了：\n${logged.join('\n')}`);

  if (parsed.session && !logged.length) {
    db.run(`INSERT INTO sessions (user_id, date, status, phase) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET status = excluded.status`, uid, today, parsed.session, p.phase || 'full3');
    out.push(parsed.session === 'done' ? '✅ 今天算練完了（有重量次數再跟我說，下次才排得準）' : '😴 今天休息，課表順延到下次訓練日');
  }

  const miss = P.missingProfile(p);
  if (miss.length) out.push(`要幫你排課表，還需要知道：${miss.join('、')}`);
  else if (!wasReady || parsed.profile) {
    const warn = P.scheduleWarning(p);
    out.push(`📋 設定好了：\n${P.profileText(p)}${warn ? `\n${warn}` : ''}`);
    registerSchedules(uid);
  }
  return out.length ? `\n\n${out.join('\n\n')}` : '';
}

// ── 指令 ───────────────────────────────────────────

function statusText(uid) {
  const p = getProfile(uid);
  if (!p) return '還沒開始，直接私訊我「小帥 我要開始健身」就好 💪';
  const miss = P.missingProfile(p);
  const lines = ['🏋️ 小帥健身教練', P.profileText(p)];
  if (miss.length) lines.push(`還需要知道：${miss.join('、')}`);
  else {
    const ph = P.PHASES[p.phase || 'full3'];
    let i = doneInPhase(uid, p.phase || 'full3');
    lines.push('', '本週課表：');
    for (const d of p.trainDays) lines.push(`・週${P.WEEK[d]}：${ph.sessions[i++ % ph.sessions.length].name}`);
    const plan = todayPlanFor(uid, p);
    lines.push('', plan ? P.planText(plan) : '今天休息 😴');
  }
  if (p.paused) lines.push('', '（提醒暫停中，/教練 恢復 可以重新開）');
  return lines.join('\n');
}

function recordText(uid) {
  const logs = db.all('SELECT date, ex, sets FROM logs WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 12', uid);
  const w = weightsOf(uid).slice(-6);
  if (!logs.length && !w.length) return '還沒有紀錄';
  const lines = [];
  if (logs.length) {
    lines.push('📝 最近訓練：');
    for (const l of logs) lines.push(`${l.date.slice(5)} ${P.EXERCISES[l.ex]?.name || l.ex} ${JSON.parse(l.sets).map(s => `${s.kg}×${s.reps}`).join('、')}`);
  }
  if (w.length) lines.push('', `⚖️ 體重：${w.map(x => `${x.date.slice(5)} ${x.kg}`).join('、')}`);
  return lines.join('\n');
}

async function command(m, ctx) {
  if (!isAdmin(ctx.userId)) return '健身教練目前只開給管理員';
  const uid = ctx.userId;
  if (m[1] === '紀錄') return recordText(uid);
  if (m[1] === '暫停' || m[1] === '恢復') {
    const p = getProfile(uid);
    if (!p) return '還沒開始設定';
    saveProfile(uid, { ...p, paused: m[1] === '暫停' });
    db.run('UPDATE profile SET paused = ? WHERE user_id = ?', m[1] === '暫停' ? 1 : 0, uid);
    return m[1] === '暫停' ? '⏸️ 提醒先停了，/教練 恢復 再開' : '▶️ 提醒恢復了';
  }
  return statusText(uid);
}

export default {
  name: 'coach',
  scope: 'private',
  ungated: true,

  helpText: `🏋️ 小帥的健身教練（私訊，管理員限定）

直接私訊小帥講健身的事：練完回報「深蹲 40 12 12 11」、量完體重說「62.5 公斤」、問動作或吃什麼都可以。
訓練日早上推課表、晚上沒回報會問；每週一提醒量體重。

/教練 — 設定、本週課表、營養目標
/教練 紀錄 — 最近訓練與體重
/教練 暫停｜恢復 — 停／開提醒`,

  commands: [
    {
      name: 'coach',
      pattern: /^\/教練(?:\s*(紀錄|暫停|恢復))?$/,
      describe: '/教練 [紀錄｜暫停｜恢復] — 小帥健身教練',
      type: 'query',
      handler: command,
    },
  ],

  async init(ctx) {
    lineApi = ctx.lineApi;
    scheduler = ctx.scheduler;
    isAdmin = ctx.isAdmin;
    if (!ctx.db) { console.warn('[coach] 沒有 db provider，停用'); return; }
    db = ctx.db;
    initDb();
    for (const r of db.all('SELECT user_id FROM profile')) registerSchedules(r.user_id);
    console.log(`[coach] ready（${db.all('SELECT user_id FROM profile').length} 人有設定）`);
  },
};
