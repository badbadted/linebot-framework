/**
 * LINE 推播額度警示：每天查一次本月用量，達 80% 就私訊管理員，每個月最多推一次（狀態存 DB）。
 * 這則警示本身用推播（只扣 1 則）；其他能用免費回覆的就不要推。
 */

export const QUOTA_ALERT_RATIO = 0.8;

// 月份以台灣時間算，格式 YYYY-MM
export function monthKey(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit' }).format(now);
}

export function quotaMessage({ limit, used }) {
  return `⚠️ LINE 推播額度這個月已用 ${used}／${limit} 則，剩 ${Math.max(0, limit - used)} 則，下個月 1 號重算`;
}

/**
 * @param {object} deps
 * @param {() => Promise<{limit:number|null, used:number}>} deps.getQuota
 * @param {(text:string) => Promise<void>} deps.push   推給管理員
 * @param {object} deps.db                              database provider 的 wrapper（run/get/exec）
 */
export function createQuotaAlert({ getQuota, push, db }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_alerts (
      month TEXT PRIMARY KEY,
      used INTEGER NOT NULL,
      quota_limit INTEGER NOT NULL,
      sent_at TEXT NOT NULL
    )
  `);

  /** 回傳 { month, limit, used, ratio, sent, reason } */
  async function check({ now = new Date(), quota } = {}) {
    const { limit, used } = quota || await getQuota();
    const month = monthKey(now);
    const base = { month, limit, used };
    if (!limit) return { ...base, ratio: 0, sent: false, reason: 'no-limit' };
    const ratio = used / limit;
    if (ratio < QUOTA_ALERT_RATIO) return { ...base, ratio, sent: false, reason: 'below' };
    if (db.get('SELECT month FROM quota_alerts WHERE month = ?', month)) return { ...base, ratio, sent: false, reason: 'already-sent' };

    await push(quotaMessage({ limit, used }));
    db.run('INSERT INTO quota_alerts (month, used, quota_limit, sent_at) VALUES (?, ?, ?, ?)', month, used, limit, now.toISOString());
    return { ...base, ratio, sent: true, reason: 'sent' };
  }

  return { check };
}
