/**
 * 小帥看照片、回貼圖（2026-10-27）
 *
 * 照片：群組貼照片時只記「［照片］」與訊息 ID，不花 AI；
 *   只有被點名或接話、而且「用回覆功能回那張照片」、「貼照片的人 5 分鐘內自己叫小帥」或「5 分鐘內有人講到圖片／這張…」才下載那一張給 AI 看。
 *   照片是群組成員自己貼的，跟他打字同等看待：可以照著提行程修改（一樣要有人回好），但那輪不寫記憶。
 * 貼圖：只能用 LINE 開放給機器人的官方貼圖（packageId 11537 熊大兔兔），AI 覺得這句真的貼切才給一個；
 *   程式只擋連續與太頻繁：上一張之後至少再回 3 句、而且隔 10 分鐘（使用者 2026-10-28 定：合適就貼，但不要連續、太常）。
 */

const IMAGE_WINDOW_MS = 5 * 60_000;
const MAX_BYTES = 1_350_000; // Luna 收 2MB 的 JSON，base64 會多 1/3
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ABOUT_IMAGE_RE = /圖|照片|相片|這張|那張|這是|這個|看看|看一下|幫我看|是什麼|是啥|在哪|哪裡|好看|好吃|可愛|帥不帥|美不美/;

/**
 * 這次要看哪一張照片：回覆到照片 → 那張；講到圖片而且 5 分鐘內有人貼照片 → 最新那張。沒有就回 null
 * @param transcript brain 的對話紀錄（照片那則有 imageId）
 * @param trigger 觸發這次的那則（quotedId：用回覆功能回的那則訊息 ID）
 */
export function pickImage(transcript, trigger, now = Date.now()) {
  const imgs = (transcript || []).filter(t => t.imageId);
  if (!imgs.length) return null;
  if (trigger?.quotedId) {
    const q = imgs.find(t => t.imageId === String(trigger.quotedId));
    if (q) return q;
  }
  const at = trigger?.ts || now;
  const recent = imgs.filter(t => at - t.ts <= IMAGE_WINDOW_MS && t.ts <= at);
  if (!recent.length) return null;
  const img = recent[recent.length - 1];
  // 貼照片的人自己接著叫小帥（例：貼行程表照片後說「小帥 幫我補行程」）→ 一定是在講那張；
  // 小帥看過、回過之後就不再每句都重看（它的回覆已經寫下照片內容，要再看請講到「照片、這張」或用回覆）
  const answered = (transcript || []).some(t => t.self && t.ts > img.ts);
  if (!answered && trigger?.userId && img.userId === trigger.userId) return img;
  // 或照片之後（含這句）有人講到圖片、這張…
  const after = (transcript || []).filter(t => !t.self && t.ts >= img.ts && t !== img).map(t => t.text);
  if (trigger?.text) after.push(trigger.text);
  return after.some(x => ABOUT_IMAGE_RE.test(String(x || ''))) ? img : null;
}

/** 下載照片轉成給 AI 的格式；太大就改抓 LINE 的預覽圖；失敗回 null */
export async function loadImage(lineApi, imageId) {
  if (!lineApi?.getContent) return null;
  for (const preview of [false, true]) {
    try {
      const r = await lineApi.getContent(imageId, { preview, maxBytes: MAX_BYTES });
      if (r && IMAGE_TYPES.has(r.contentType)) return { mediaType: r.contentType, data: r.buffer.toString('base64'), preview };
    } catch (err) {
      console.warn(`[xiaoshuai-media] 照片下載失敗：${err.message}`);
    }
  }
  return null;
}

// ── 貼圖 ──────────────────────────────────────────

// 2026-10-27 從 LINE 官方「機器人可用貼圖」清單（developers.line.biz sticker-list）的 11537 挑，看過圖確認意思
export const STICKERS = {
  慶祝: '52002734',
  OK: '52002740',
  愛心: '52002743',
  疑問: '52002744',
  開心: '52002745',
  驚訝: '52002749',
  大哭: '52002750',
  沮喪: '52002751',
  哇: '52002752',
  無言: '52002754',
  拜託: '52002755',
  看戲: '52002762',
  晚安: '52002764',
  加油: '52002767',
  嗨: '52002768',
  生氣: '52002772',
};
export const STICKER_KEYS = Object.keys(STICKERS).join('、');
// 2026-10-28 改：不再固定「5 次一張」，AI 覺得這句真的貼切才給；程式只擋連續與太頻繁
export const GAP_REPLIES = 3;          // 上一張之後至少再回幾句（不連續）
export const GAP_MS = 10 * 60_000;     // 同一群／私訊至少隔多久
// 上一張之後回了幾句、上一張的時間：存 DB（只放記憶體時 bot 一天重開好幾次，次數一直歸零）
let db = null;
const memState = new Map(); // 沒有 DB 時（測試）的備用

export function initStickers(database) {
  db = database;
  db.exec('CREATE TABLE IF NOT EXISTS sticker_state (chat_id TEXT PRIMARY KEY, since INTEGER NOT NULL DEFAULT 0)');
  if (!db.all('PRAGMA table_info(sticker_state)').some(c => c.name === 'last_at')) db.exec('ALTER TABLE sticker_state ADD COLUMN last_at INTEGER NOT NULL DEFAULT 0');
}
// 沒有紀錄（還沒貼過）＝可以貼
function getState(chatId) {
  const r = db ? db.get('SELECT since, last_at FROM sticker_state WHERE chat_id = ?', chatId) : memState.get(chatId);
  return r ? { since: r.since, lastAt: r.last_at ?? r.lastAt ?? 0 } : { since: GAP_REPLIES, lastAt: 0 };
}
function setState(chatId, since, lastAt) {
  if (!db) { memState.set(chatId, { since, lastAt }); return; }
  db.run(`INSERT INTO sticker_state (chat_id, since, last_at) VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET since = excluded.since, last_at = excluded.last_at`, chatId, since, lastAt);
}

/** 這次能不能貼（給 AI 的 prompt 用：不能貼就別給、也別說要貼） */
export function canSticker(chatId, now = Date.now()) {
  const st = getState(chatId);
  return st.since >= GAP_REPLIES && now - st.lastAt >= GAP_MS;
}

/**
 * 每次小帥回話都呼叫一次：AI 有給心情、而且沒連續、離上一張夠久才回貼圖訊息，其他回 null
 */
export function stickerMessage(chatId, mood, now = Date.now()) {
  const id = STICKERS[String(mood || '').trim()];
  const st = getState(chatId);
  if (id && canSticker(chatId, now)) {
    setState(chatId, 0, now);
    return { type: 'sticker', packageId: '11537', stickerId: id };
  }
  setState(chatId, st.since + 1, st.lastAt);
  return null;
}
