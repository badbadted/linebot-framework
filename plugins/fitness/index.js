/**
 * Fitness Plugin — 運動追蹤範例（示範 DB 用法）
 *
 * 前綴：/fit
 *
 * 指令：
 *   /fit_log 跑步 5km  → 記錄運動
 *   /fit_log 騎車 30km → 記錄運動
 *   /fit_log 游泳 1km  → 記錄運動
 *   /fit_week           → 查詢本週統計
 *   /fit                → 查詢本週統計（default）
 *
 * 排程：
 *   每週日 20:00 推播週報（需設定 PUSH_USER_ID）
 */

let db;
const PUSH_USER_ID = process.env.PUSH_USER_ID || '';

const SPORT_MAP = {
  '跑步': 'run', '跑': 'run', '慢跑': 'run',
  '騎車': 'bike', '騎腳踏車': 'bike', '單車': 'bike', '自行車': 'bike',
  '游泳': 'swim', '游': 'swim',
  '走路': 'walk', '散步': 'walk', '健走': 'walk',
  '重訓': 'gym', '健身': 'gym',
};

function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

function formatStats(rows) {
  if (!rows.length) return '本週還沒有運動記錄 💪';

  const labels = { run: '🏃 跑步', bike: '🚴 騎車', swim: '🏊 游泳', walk: '🚶 走路', gym: '🏋️ 重訓' };
  let total = 0;
  const lines = rows.map(r => {
    total += r.total_km;
    return `${labels[r.sport] || r.sport}：${r.total_km} km（${r.count} 次）`;
  });
  lines.unshift(`📊 本週運動統計（共 ${total.toFixed(1)} km）`);
  return lines.join('\n');
}

export default {
  name: 'fitness',
  helpText: `💪 健身 使用說明

① 記錄運動：/fit_log 跑步 5
　（運動名稱 + 公里數）
② 本週統計：/fit

每週日自動推播運動週報`,
  prefix: 'fit',
  defaultCommand: 'weekly-stats',

  commands: [
    {
      name: 'log-exercise',
      command: 'log',
      pattern: /^(跑步?|慢跑|騎車|騎腳踏車|單車|自行車|游泳?|走路|散步|健走|重訓|健身)\s*(\d+(?:\.\d+)?)\s*(?:km|公里)?$/,
      describe: '/fit_log <運動> <公里> — 記錄運動',
      type: 'query',
      handler: async (match, ctx) => {
        const sportName = match[1];
        const km = parseFloat(match[2]);
        const sport = SPORT_MAP[sportName] || sportName;

        db.run(
          `INSERT INTO exercise_log (user_id, sport, km, logged_at) VALUES (?, ?, ?, datetime('now', '+8 hours'))`,
          ctx.userId, sport, km
        );

        const today = db.get(
          `SELECT SUM(km) as total FROM exercise_log WHERE user_id = ? AND date(logged_at) = date('now', '+8 hours')`,
          ctx.userId
        );

        return `✅ 已記錄 ${sportName} ${km} km\n今日累計：${today.total} km`;
      },
    },
    {
      name: 'weekly-stats',
      command: 'week',
      describe: '/fit — 本週運動統計',
      type: 'query',
      handler: async (_match, ctx) => {
        const weekStart = getWeekStart();
        const rows = db.all(
          `SELECT sport, COUNT(*) as count, ROUND(SUM(km), 1) as total_km
           FROM exercise_log
           WHERE user_id = ? AND logged_at >= ?
           GROUP BY sport
           ORDER BY total_km DESC`,
          ctx.userId, weekStart
        );
        return formatStats(rows);
      },
    },
  ],

  schedules: [
    {
      name: 'fitness-weekly-report',
      cron: '0 20 * * 0',  // 每週日 20:00
      describe: '每週日運動週報推播',
      pushTo: [
        { type: 'user', id: PUSH_USER_ID || '(env: PUSH_USER_ID)', label: '預設使用者' },
      ],
      handler: async ({ lineApi }) => {
        if (!PUSH_USER_ID || !db) return;
        const weekStart = getWeekStart();
        const rows = db.all(
          `SELECT sport, COUNT(*) as count, ROUND(SUM(km), 1) as total_km
           FROM exercise_log
           WHERE user_id = ? AND logged_at >= ?
           GROUP BY sport
           ORDER BY total_km DESC`,
          PUSH_USER_ID, weekStart
        );
        const msg = formatStats(rows);
        await lineApi.push(PUSH_USER_ID, msg);
      },
    },
  ],

  init: async ({ db: pluginDb }) => {
    db = pluginDb;
    if (db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS exercise_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          sport TEXT NOT NULL,
          km REAL NOT NULL,
          logged_at TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_exercise_user_date ON exercise_log (user_id, logged_at)`);
    }
  },
};
