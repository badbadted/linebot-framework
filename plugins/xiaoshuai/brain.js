/**
 * 小帥的「要不要開口」判斷（純邏輯，時鐘與計時器可注入，方便測試）
 *
 * 三種觸發：
 *   mention — 訊息提到小帥 → 一定回
 *   idle    — 連續 idleThreshold 則沒提到小帥 → 交給 AI 決定要不要插話
 *   window  — 小帥開口後 windowMs 內，每則新訊息交給 AI 用語意判斷「是不是在跟小帥說話」
 *             是 → 當成被點名（onFire 回 asMention），照被點名的規則回，並重開視窗
 *             不是、但 AI 想插一句 → 一個視窗最多 windowMaxReplies 句、跟上一句至少隔 windowCooldownMs，
 *             這種插話不延長視窗；onFire 收到 allowChimeIn 告訴它現在能不能插話
 *             每個視窗最多判斷 windowMaxJudges 次
 *
 * 共通規則：
 *   - 只在講話時段內（台北時間 hours.start～hours.end）
 *   - 回覆前隨機等 delayMs[0]～delayMs[1]；等待中又有新訊息 → 改看最新那句、重新計時（mention 優先權最高）
 *   - 同一群 cooldownMs 內最多回一次
 *   - 從觸發到送出最多 maxWaitMs（LINE replyToken 會過期），超過就放棄
 */

export const DEFAULTS = {
  hours: { start: 9 * 60, end: 22 * 60 + 30 }, // 分鐘數，台北時間
  idleThreshold: 20,
  windowMs: 5 * 60_000,
  windowMaxJudges: 10,
  windowMaxReplies: 2,       // 不是在跟小帥說話時，一個視窗內最多自己插幾句
  windowCooldownMs: 60_000,  // 自己插話跟上一句至少隔多久
  delayMs: [2000, 6000],
  cooldownMs: 15_000,
  maxWaitMs: 20_000,
  maxDebounceMs: 8000,   // 一直有人講話時，最多延後這麼久就要開口（不然熱絡的群永遠等不到）
  bufferSize: 30,
};

const PRIORITY = { window: 1, idle: 2, mention: 3 };

/** 台北時間的「當天第幾分鐘」 */
export function taipeiMinutes(ts) {
  const d = new Date(ts + 8 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function createBrain({
  cfg = {},
  isEnabled,
  onFire,                     // async (chatId, { mode, replyToken, transcript }) => { replied: boolean, text?: string }
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
}) {
  const c = { ...DEFAULTS, ...cfg, hours: { ...DEFAULTS.hours, ...(cfg.hours || {}) } };
  const chats = new Map();

  function st(chatId) {
    if (!chats.has(chatId)) {
      chats.set(chatId, {
        buf: [], unmentioned: 0, windowUntil: 0, windowJudges: 0, windowReplies: 0,
        lastReplyAt: -Infinity, pending: null, busy: false,
      });
    }
    return chats.get(chatId);
  }

  function inHours(ts = now()) {
    const m = taipeiMinutes(ts);
    return m >= c.hours.start && m < c.hours.end;
  }

  /** 記下一則訊息（所有群組文字都進來；/ 開頭的指令不進對話紀錄） */
  function observe(chatId, entry) {
    if (!entry?.text || entry.text.trim().startsWith('/')) return null;
    const s = st(chatId);
    const item = { name: entry.name || '', userId: entry.userId || '', text: entry.text, ts: entry.ts ?? now(), self: !!entry.self };
    if (entry.imageId) item.imageId = String(entry.imageId); // 照片：之後有人問才下載來看
    s.buf.push(item);
    if (s.buf.length > c.bufferSize) s.buf.splice(0, s.buf.length - c.bufferSize);
    return item; // 回傳參考，呼叫端可事後補上名字
  }

  /**
   * 沒命中指令的群組訊息。回傳 true = 小帥在這群開著（接手，不交給其他 AI）
   */
  /**
   * trigger：觸發這次的那則訊息（observe 回傳的物件）。等待中被新訊息合併時，
   * 點名那句會保留下來，AI 才知道真正要回的是哪一句
   */
  function handle(chatId, { replyToken, isMention, trigger = null }) {
    if (!isEnabled(chatId)) return false;
    const s = st(chatId);
    const t = now();

    if (!inHours(t)) { s.unmentioned = 0; return true; } // 時段外不講話，也不累積插話計數

    if (isMention) s.unmentioned = 0;
    else s.unmentioned++;

    let mode = null;
    if (isMention) mode = 'mention';
    else if (windowOpen(s, t)) mode = 'window';
    else if (s.unmentioned >= c.idleThreshold) mode = 'idle';
    else if (s.pending) mode = s.pending.mode; // 正在等著回：沿用原本的模式，改看最新這句
    if (!mode) return true;
    if (mode === 'idle') s.unmentioned = 0;

    // 合併等待中的工作：模式取優先權高的，replyToken 與時間用最新的
    const prev = s.pending;
    if (prev) clearTimer(prev.timer);
    const merged = prev && PRIORITY[prev.mode] > PRIORITY[mode] ? prev.mode : mode;
    const keepPrevTrigger = prev && merged === prev.mode && prev.mode === 'mention' && !isMention;
    const job = {
      mode: merged, replyToken, receivedAt: t, firstAt: prev?.firstAt ?? t, timer: null,
      trigger: keepPrevTrigger ? prev.trigger : trigger,
    };
    s.pending = job;
    schedule(chatId, job);
    return true;
  }

  function windowOpen(s, t) {
    return t < s.windowUntil && s.windowJudges < c.windowMaxJudges;
  }

  function canChimeIn(s, t) {
    return s.windowReplies < c.windowMaxReplies && t - s.lastReplyAt >= c.windowCooldownMs;
  }

  function schedule(chatId, job) {
    const s = st(chatId);
    const t = now();
    const [lo, hi] = c.delayMs;
    const cooldown = c.cooldownMs;
    const delay = t - job.firstAt >= c.maxDebounceMs ? 0 : lo + Math.floor(random() * (hi - lo + 1));
    const fireAt = Math.max(t + delay, s.lastReplyAt + cooldown);
    if (fireAt - job.receivedAt > c.maxWaitMs) {
      if (s.pending === job) s.pending = null;
      return;
    }
    job.timer = setTimer(() => fire(chatId, job), fireAt - t);
  }

  async function fire(chatId, job) {
    const s = st(chatId);
    if (s.pending !== job) return;
    if (!isEnabled(chatId) || !inHours()) { s.pending = null; return; }
    if (s.busy) {
      // 上一句還在想：1 秒後再看，超過 maxWait 就放棄
      if (now() + 1000 - job.receivedAt > c.maxWaitMs) { s.pending = null; return; }
      job.timer = setTimer(() => fire(chatId, job), 1000);
      return;
    }
    s.pending = null;
    if (job.mode === 'window') {
      if (!windowOpen(s, now())) return;
      s.windowJudges++;
    }
    s.busy = true;
    try {
      const allowChimeIn = job.mode === 'window' ? canChimeIn(s, now()) : true;
      const r = await onFire(chatId, { mode: job.mode, replyToken: job.replyToken, trigger: job.trigger, transcript: s.buf.slice(), allowChimeIn });
      if (r?.replied) {
        const t = now();
        s.lastReplyAt = t;
        s.unmentioned = 0;
        if (job.mode === 'window' && !r.asMention) {
          s.windowReplies++;
        } else {
          // 被點名、語意判斷在跟小帥說話、冷場插話 → 重開視窗；單純插話不延長，避免聊個沒完
          s.windowUntil = t + c.windowMs;
          s.windowJudges = 0;
          s.windowReplies = 0;
        }
        if (r.text) observe(chatId, { name: '小帥', text: r.text, ts: t, self: true });
      }
    } catch (err) {
      console.error(`[xiaoshuai] fire error: ${err.message}`);
    } finally {
      s.busy = false;
    }
  }

  /** 關掉時清掉計時與視窗（對話紀錄保留） */
  function reset(chatId) {
    const s = chats.get(chatId);
    if (!s) return;
    if (s.pending) clearTimer(s.pending.timer);
    s.pending = null;
    s.windowUntil = 0;
    s.windowJudges = 0;
    s.windowReplies = 0;
    s.unmentioned = 0;
  }

  function status(chatId) {
    const s = chats.get(chatId);
    const t = now();
    return {
      inHours: inHours(t),
      windowLeftMs: s ? Math.max(0, s.windowUntil - t) : 0,
      unmentioned: s?.unmentioned || 0,
      buffered: s?.buf.length || 0,
    };
  }

  return { observe, handle, reset, status, inHours, config: c, _state: st };
}
