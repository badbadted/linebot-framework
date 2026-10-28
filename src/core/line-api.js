/**
 * LINE Messaging API 封裝
 * - reply: 用 replyToken 回覆（30 秒內有效）
 * - push: 主動推播給指定 userId
 */

const LINE_API = 'https://api.line.me/v2/bot/message';

export function createLineAPI(channelAccessToken) {
  if (!channelAccessToken) {
    console.warn('[line-api] no channelAccessToken — reply/push will fail');
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${channelAccessToken}`,
  };

  async function reply(replyToken, text) {
    const messages = typeof text === 'string'
      ? [{ type: 'text', text }]
      : Array.isArray(text) ? text : [text];

    const res = await fetch(`${LINE_API}/reply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ replyToken, messages }),
    });
    const body = await res.text(); // 必須消耗 body 避免 socket leak
    if (!res.ok) throw new Error(`LINE reply failed: ${res.status} ${body}`);
    // 回傳 { sentMessages: [{ id, quoteToken }] }：之後有人「回覆」這則訊息時，webhook 會帶 quotedMessageId 對得上
    try { return JSON.parse(body); } catch { return {}; }
  }

  /**
   * 驗證要 reply 的訊息格式（不會送出）：LINE /v2/bot/message/validate/reply
   * @returns {{ ok: boolean, status: number, body: string }}
   */
  async function validateReply(messages) {
    const res = await fetch(`${LINE_API}/validate/reply`, { method: 'POST', headers, body: JSON.stringify({ messages }) });
    return { ok: res.ok, status: res.status, body: await res.text() };
  }

  async function push(to, text) {
    const messages = typeof text === 'string'
      ? [{ type: 'text', text }]
      : Array.isArray(text) ? text : [text];

    const res = await fetch(`${LINE_API}/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to, messages }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`LINE push failed: ${res.status} ${body}`);
  }

  async function multicast(userIds, text) {
    const messages = typeof text === 'string'
      ? [{ type: 'text', text }]
      : Array.isArray(text) ? text : [text];

    const res = await fetch(`${LINE_API}/multicast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: userIds, messages }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`LINE multicast failed: ${res.status} ${body}`);
  }

  /**
   * 查詢使用者 Profile
   * @returns {{ displayName, userId, pictureUrl, statusMessage }}
   */
  async function getProfile(userId) {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, { headers });
    const body = await res.text();
    if (!res.ok) return null;
    return JSON.parse(body);
  }

  /**
   * 查詢群組摘要
   * @returns {{ groupId, groupName, pictureUrl, memberCount }}
   */
  async function getGroupSummary(groupId) {
    const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, { headers });
    const body = await res.text();
    if (!res.ok) return null;
    return JSON.parse(body);
  }

  /**
   * 查詢群組成員的 profile（群組成員不一定是好友，需用此端點）
   * @returns {{ displayName, userId, pictureUrl }}
   */
  async function getGroupMemberProfile(groupId, userId) {
    const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, { headers });
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  }

  /**
   * 讓 bot 離開群組（C 開頭）或聊天室（R 開頭）
   */
  async function leaveChat(id) {
    const kind = id.startsWith('R') ? 'room' : 'group';
    const res = await fetch(`https://api.line.me/v2/bot/${kind}/${id}/leave`, { method: 'POST', headers });
    const body = await res.text();
    if (!res.ok) throw new Error(`LINE leave failed: ${res.status} ${body}`);
  }

  /**
   * 下載使用者傳的圖片（只保留一段時間，太舊會 404）。preview＝LINE 縮小過的預覽圖。
   * 回 { buffer, contentType }；超過 maxBytes 或失敗回 null
   */
  async function getContent(messageId, { preview = false, maxBytes = 5_000_000 } = {}) {
    if (!/^\d{1,30}$/.test(String(messageId || ''))) return null;
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content${preview ? '/preview' : ''}`, { headers: { Authorization: headers.Authorization } });
    if (!res.ok) { await res.arrayBuffer().catch(() => {}); return null; }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) { res.body?.cancel?.(); return null; }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) return null;
    return { buffer, contentType: (res.headers.get('content-type') || '').split(';')[0].trim() };
  }

  return { reply, validateReply, push, multicast, getProfile, getGroupSummary, getGroupMemberProfile, leaveChat, getContent };
}
