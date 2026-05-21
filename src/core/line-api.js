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

  return { reply, push, multicast, getProfile, getGroupSummary };
}
