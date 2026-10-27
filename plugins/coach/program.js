/**
 * 健身教練的課表與判斷（純函式，不碰 DB、不打 AI，方便測）
 *
 * 方法論（使用者 2026-10-27 提供，卓叔增重）：
 * - 新手不分化：一週三練全身，間隔 48 小時；只練深蹲、臥推、划船；10～15RM、每動作 3～6 組
 * - 進階雙分化：上下肢、練四休三，單部位隔 3～4 天
 * - 飲食：蛋白質 1.8 g/kg、碳水 6 g/kg；每週一空腹量體重，連 1～2 週沒漲就加主食
 */

export const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export const REP_LOW = 10;
export const REP_HIGH = 15;

// step：每次加重多少公斤（槓鈴下肢 5、上肢 2.5；啞鈴每顆 2；機械 5）
export const EXERCISES = {
  squat: { name: '深蹲', step: 5 },
  bench: { name: '臥推', step: 2.5 },
  row: { name: '槓鈴划船', step: 2.5 },
  ohp: { name: '站姿肩推', step: 2.5 },
  rdl: { name: '羅馬尼亞硬舉', step: 5 },
  incline: { name: '上斜啞鈴臥推', step: 2 },
  pulldown: { name: '滑輪下拉', step: 5 },
  legpress: { name: '腿推', step: 10 },
};
const ALIASES = { 深蹲: 'squat', 蹲: 'squat', 臥推: 'bench', 平板臥推: 'bench', 划船: 'row', 槓鈴划船: 'row', 俯身划船: 'row', 肩推: 'ohp', 站姿肩推: 'ohp', 硬舉: 'rdl', 羅馬尼亞硬舉: 'rdl', 上斜臥推: 'incline', 上斜啞鈴臥推: 'incline', 下拉: 'pulldown', 滑輪下拉: 'pulldown', 腿推: 'legpress' };
export function exerciseId(name) {
  const s = String(name || '').replace(/\s+/g, '');
  if (EXERCISES[s]) return s;
  return ALIASES[s] || null;
}

export const PHASES = {
  full3: { name: '不分化（一週三練全身）', days: [1, 3, 5], sessions: [{ name: '全身', ex: ['squat', 'bench', 'row'] }] },
  split4: {
    name: '雙分化（上下肢，練四休三）', days: [1, 2, 4, 5], sessions: [
      { name: '下肢 A', ex: ['squat', 'rdl'] },
      { name: '上肢 A', ex: ['bench', 'row', 'ohp'] },
      { name: '下肢 B', ex: ['squat', 'legpress'] },
      { name: '上肢 B', ex: ['incline', 'pulldown'] },
    ],
  },
};

/** 組數隨週數加：不分化前兩週 3 組、再兩週 4 組、之後 5 組；雙分化 4 組起、第 3 週起 5 組 */
export function setsFor(phase, doneInPhase) {
  if (phase === 'split4') return doneInPhase < 8 ? 4 : 5;
  if (doneInPhase < 6) return 3;
  if (doneInPhase < 12) return 4;
  return 5;
}

const roundTo = (x, step) => Math.max(step, Math.round(x / step) * step);

/**
 * 雙進階法：上次每組都做到 15 下 → 加重；超過一半的組不到 10 下 → 降 5%；其他照舊
 * @param last {{kg:number, reps:number}[] | null}
 */
export function nextWeight(exId, last) {
  const step = EXERCISES[exId]?.step || 2.5;
  if (!last?.length) return { kg: null, why: '先找一個能做 12 下、還剩 2 下力氣的重量' };
  const kg = Math.max(...last.map(s => s.kg));
  const top = last.filter(s => s.kg === kg);
  if (top.every(s => s.reps >= REP_HIGH)) return { kg: kg + step, why: `上次每組都做到 ${REP_HIGH} 下，加 ${step} 公斤` };
  if (top.filter(s => s.reps < REP_LOW).length > top.length / 2) {
    const down = roundTo(kg * 0.95, step);
    return { kg: down < kg ? down : kg, why: down < kg ? `上次多數組不到 ${REP_LOW} 下，先退一點` : '上次有點吃力，同重量再練一次' };
  }
  return { kg, why: `同重量，目標每組都做到 ${REP_HIGH} 下` };
}

/** 台北日期 YYYY-MM-DD 與星期 */
export function taipeiDay(now = Date.now()) {
  const date = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, dow };
}

/**
 * 今天的課表
 * @param profile {{phase, trainDays}}
 * @param doneInPhase 這個階段已完成幾次
 * @param lastLogs exId → 上次的組 [{kg,reps}]
 */
export function todayPlan(profile, doneInPhase, lastLogs, now = Date.now()) {
  const { dow } = taipeiDay(now);
  if (!profile?.trainDays?.includes(dow)) return null;
  const ph = PHASES[profile.phase] || PHASES.full3;
  const session = ph.sessions[doneInPhase % ph.sessions.length];
  const sets = setsFor(profile.phase, doneInPhase);
  return {
    name: session.name, sets,
    items: session.ex.map(id => ({ id, name: EXERCISES[id].name, sets, ...nextWeight(id, lastLogs[id]) })),
  };
}

export function planText(plan) {
  const lines = [`🏋️ 今天練${plan.name}：每個動作 ${plan.sets} 組 × ${REP_LOW}～${REP_HIGH} 下`];
  for (const it of plan.items) lines.push(`・${it.name}：${it.kg ? `${it.kg} 公斤` : '找起始重量'}（${it.why}）`);
  lines.push('組間休息 1.5～2 分鐘，最後兩下要有點吃力才算數。練完跟我說重量和每組次數，例如「深蹲 40 12 12 11」。');
  return lines.join('\n');
}

export function nutrition(weightKg) {
  if (!weightKg) return null;
  return { protein: Math.round(weightKg * 1.8), carbs: Math.round(weightKg * 6) };
}

/**
 * 體重趨勢：每週取最後一筆，最近三週都沒漲 → 加主食；最近兩週沒漲 → 先觀察、加點心
 * @param weights [{date, kg}] 由舊到新
 */
export function weightAdvice(weights) {
  const byWeek = new Map();
  for (const w of weights) {
    const d = new Date(`${w.date}T00:00:00Z`);
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    byWeek.set(monday.toISOString().slice(0, 10), w.kg);
  }
  const wk = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(e => e[1]);
  const n = wk.length;
  if (n < 2) return { level: 'start', text: '第一筆體重記下了，之後每週一早上空腹再量一次。' };
  const diff = +(wk[n - 1] - wk[n - 2]).toFixed(1);
  if (diff > 0) return { level: 'up', text: `比上週多 ${diff} 公斤，照這樣吃 👍` };
  if (n >= 3 && wk[n - 2] <= wk[n - 3]) return { level: 'add', text: '已經連兩週沒漲，熱量不夠：每天主食多加半碗到一碗飯（約 30～60 克碳水），下週一再看。' };
  return { level: 'watch', text: `這週${diff === 0 ? '持平' : `少了 ${-diff} 公斤`}，先在兩餐中間多吃一根香蕉，下週還沒漲就加主食。` };
}

// ── 個人設定 ─────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 合併 AI 給的設定，不合格的不收 */
export function mergeProfile(prev, patch) {
  const p = { ...(prev || {}) };
  const problems = [];
  if (!patch || typeof patch !== 'object') return { p, problems };
  const num = (v, lo, hi) => (Number.isFinite(+v) && +v >= lo && +v <= hi ? +(+v).toFixed(1) : null);
  if (patch.weight_kg != null) { const v = num(patch.weight_kg, 30, 200); if (v) p.weightKg = v; else problems.push('體重看不懂'); }
  if (patch.height_cm != null) { const v = num(patch.height_cm, 120, 220); if (v) p.heightCm = v; else problems.push('身高看不懂'); }
  if (Array.isArray(patch.train_days)) {
    const days = [...new Set(patch.train_days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (days.length >= 2 && days.length <= 6) p.trainDays = days; else problems.push('訓練日要一週 2～6 天');
  }
  for (const [k, f] of [['remind_time', 'remindTime'], ['checkin_time', 'checkinTime'], ['weigh_time', 'weighTime']]) {
    if (patch[k] != null) { if (TIME_RE.test(patch[k])) p[f] = patch[k]; else problems.push(`時間「${String(patch[k]).slice(0, 8)}」看不懂`); }
  }
  if (patch.phase && PHASES[patch.phase]) p.phase = patch.phase;
  if (!p.phase) p.phase = 'full3';
  return { p, problems };
}

export function missingProfile(p) {
  const m = [];
  if (!p?.weightKg) m.push('現在體重幾公斤');
  if (!p?.trainDays) m.push('一週哪幾天去練（新手建議一三五，或二四六，中間隔一天）');
  if (!p?.remindTime) m.push('幾點提醒你今天的課表');
  if (!p?.checkinTime) m.push('晚上幾點問你練了沒');
  return m;
}

/** 不分化卻排了連續兩天 → 提醒恢復不夠 */
export function scheduleWarning(p) {
  if (p?.phase !== 'full3' || !p.trainDays) return '';
  const d = p.trainDays;
  const back = d.some((x, i) => d.includes((x + 1) % 7));
  return back ? '⚠️ 全身訓練排了連續兩天，肌肉恢復要 48 小時，建議中間隔一天。' : '';
}

export function profileText(p) {
  const n = nutrition(p.weightKg);
  return [
    `・課表：${PHASES[p.phase || 'full3'].name}`,
    p.trainDays ? `・訓練日：週${p.trainDays.map(d => WEEK[d]).join('、')}` : '',
    p.remindTime ? `・課表提醒：訓練日 ${p.remindTime}` : '',
    p.checkinTime ? `・問你練了沒：訓練日 ${p.checkinTime}` : '',
    `・量體重：每週一 ${p.weighTime || '07:00'}（空腹）`,
    p.weightKg ? `・體重 ${p.weightKg} 公斤 → 每天蛋白質 ${n.protein} 克、碳水 ${n.carbs} 克，一天吃五六餐、每餐七八分飽` : '',
  ].filter(Boolean).join('\n');
}

/** cron：分 時 * * 星期 */
export function cronAt(time, days) {
  const [h, m] = time.split(':').map(Number);
  return `${m} ${h} * * ${days.join(',')}`;
}
