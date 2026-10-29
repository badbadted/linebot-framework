/**
 * 「沒人要用的回覆」（2026-10-29）：群組裡有些訊息的 replyToken 本來就不會被用掉，
 * 可以拿來免費貼排著的東西（例：小帥分享活動、公告），不必推播扣額度。
 *
 * 只有這兩種時機才交給 plugin 的 onIdleReply，保證不搶指令或其他 plugin 的回覆：
 *   1. 群組文字訊息：沒命中任何指令、沒有 plugin 接手（onUnmatched 都回 false），而且那群沒開 _llm（不會有 AI 自動回）
 *   2. 群組的貼圖、照片、位置：框架與 plugin 都不回這種訊息
 * 以「/」開頭的訊息一律不算（打錯指令）。
 */

/** 這則文字訊息走到最後、確定沒人會回時，能不能拿它的回覆 */
export function idleAllowed({ isGroup, text = '', groupPerms = [] }) {
  if (!isGroup) return false;
  if (String(text).trim().startsWith('/')) return false;
  return !groupPerms.includes('_llm');
}

/** 群組的非文字訊息（貼圖、照片、位置）：沒有人會回 */
export const idleEvent = (event) => !!event?.replyToken && ['sticker', 'image', 'location'].includes(event?.message?.type);

/** 依序問 plugin 要不要用；有一個用了就停（回 true） */
export async function runIdleHooks(hooks, ctx) {
  for (const h of hooks || []) {
    try {
      if (await h.fn(ctx)) return true;
    } catch (err) { console.error(`[hook:${h.plugin}] idleReply error: ${err.message}`); }
  }
  return false;
}
