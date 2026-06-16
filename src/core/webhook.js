/**
 * LINE Webhook 處理器
 *
 * - 驗證 X-Line-Signature（HMAC-SHA256）
 * - 解析事件，分派到 router
 * - 支援 text message 事件（其他類型可擴充）
 */

import { createHmac, timingSafeEqual } from 'crypto';

export function createWebhookHandler({ channelSecret, router, lineApi, allowlist, onUnmatched, onFollow, onUnfollow, onJoin, onLeave, onChatSeen, logger }) {
  // 事件去重：防止同一 webhookEventId 被重複處理
  const recentEventIds = new Map(); // eventId → timestamp
  const DEDUP_WINDOW = 5 * 60_000;  // 5 分鐘
  setInterval(() => {
    const cutoff = Date.now() - DEDUP_WINDOW;
    for (const [id, ts] of recentEventIds) {
      if (ts < cutoff) recentEventIds.delete(id);
    }
  }, 60_000);

  return async function handleWebhook(req, res) {
    // 立即回 200（LINE 要求 1 秒內回應）
    res.status(200).end();

    if (!channelSecret || !req.rawBody) return;

    // 簽章驗證
    const signature = req.headers['x-line-signature'];
    if (!signature) return;

    const hmac = createHmac('sha256', channelSecret)
      .update(req.rawBody)
      .digest('base64');
    // timing-safe compare 防止逐 byte 暴力破解簽章
    const hmacBuf = Buffer.from(hmac);
    const sigBuf = Buffer.from(signature);
    if (hmacBuf.length !== sigBuf.length || !timingSafeEqual(hmacBuf, sigBuf)) {
      console.log('[webhook] invalid signature');
      return;
    }

    // 解析事件
    let data;
    try {
      data = JSON.parse(req.rawBody.toString());
    } catch {
      return;
    }

    for (const event of (data.events || [])) {
      // 防重播攻擊：拒絕超過 5 分鐘的事件
      const eventTs = Number(event.timestamp || 0);
      if (Math.abs(Date.now() - eventTs) > 5 * 60_000) {
        console.log(`[webhook] rejected stale event: ${eventTs}`);
        continue;
      }

      // 事件去重：同一 webhookEventId 只處理一次
      const eventId = event.webhookEventId;
      if (eventId) {
        if (recentEventIds.has(eventId)) {
          console.log(`[webhook] deduplicated event: ${eventId.slice(0, 8)}`);
          continue;
        }
        recentEventIds.set(eventId, Date.now());
      }

      const evUserId = event.source?.userId;

      // 加好友 / 封鎖（unfollow 無 replyToken）
      if (event.type === 'follow') {
        if (onFollow && evUserId) {
          try { await onFollow({ userId: evUserId, replyToken: event.replyToken }); }
          catch (err) { console.error(`[webhook] follow handler error: ${err.message}`); }
        }
        continue;
      }
      if (event.type === 'unfollow') {
        if (onUnfollow && evUserId) {
          try { await onUnfollow({ userId: evUserId }); }
          catch (err) { console.error(`[webhook] unfollow handler error: ${err.message}`); }
        }
        continue;
      }

      // 被加入 / 被移出 群組或聊天室
      if (event.type === 'join') {
        const gid = event.source?.groupId || event.source?.roomId;
        if (onJoin && gid) {
          try { await onJoin({ groupId: gid, sourceType: event.source?.type, replyToken: event.replyToken }); }
          catch (err) { console.error(`[webhook] join handler error: ${err.message}`); }
        }
        continue;
      }
      if (event.type === 'leave') {
        const gid = event.source?.groupId || event.source?.roomId;
        if (onLeave && gid) {
          try { await onLeave({ groupId: gid }); }
          catch (err) { console.error(`[webhook] leave handler error: ${err.message}`); }
        }
        continue;
      }

      // 之後只處理 text message
      if (event.type !== 'message' || event.message?.type !== 'text') continue;

      const userId = evUserId;
      const text = event.message.text;
      const replyToken = event.replyToken;
      if (!userId || !text || !replyToken) continue;

      // 來源類型：user / group / room
      const sourceType = event.source?.type || 'user';
      const groupId = event.source?.groupId || null;
      const roomId = event.source?.roomId || null;

      // 延遲發現：群組/聊天室訊息 → 讓上層登記未知群組（fire-and-forget，不阻塞）
      const chatId = groupId || roomId;
      if (chatId && onChatSeen) { Promise.resolve(onChatSeen({ chatId })).catch(() => {}); }

      // 白名單檢查（可選，僅對個人訊息生效）
      if (allowlist && sourceType === 'user' && !allowlist.has(userId)) {
        console.log(`[webhook] blocked ${userId.slice(0, 8)}...`);
        await lineApi.reply(replyToken, `你好！\n你的 LINE ID：\n${userId}\n\n請聯繫管理員加入白名單。`);
        continue;
      }

      const sourceLabel = groupId ? `group:${groupId.slice(0, 8)}` : userId.slice(0, 8);
      if (groupId) console.log(`[webhook] groupId: ${groupId}`);
      console.log(`[webhook] ${sourceLabel}...: ${text.slice(0, 80)}`);

      // scopeId：私訊 = userId，群組 = groupId，聊天室 = roomId
      const scopeId = groupId || roomId || userId;

      // Router 比對（帶 sourceType + groupId 做 scope 和群組權限過濾）
      const t0 = Date.now();
      const matchResult = router.match(text, { sourceType, groupId });
      if (matchResult.matched) {
        // scope 限制：指令不適用於此對話場景
        if (matchResult.scopeBlocked) {
          const scopeLabel = matchResult.route.scope === 'private' ? '私訊' : '群組';
          try {
            await lineApi.reply(replyToken, `此指令僅限${scopeLabel}使用`);
          } catch { /* ignore */ }
          if (logger) logger.log({
            userId, sourceType, text,
            route: matchResult.route.name,
            plugin: matchResult.route.plugin,
            type: 'scope-blocked',
            response: `scope: ${matchResult.route.scope}`,
            durationMs: Date.now() - t0,
          });
          continue;
        }

        // 群組權限限制：此群組未開放此 plugin
        if (matchResult.groupBlocked) {
          // 靜默忽略，不回覆（避免在群組刷屏）
          if (logger) logger.log({
            userId, sourceType, text,
            route: matchResult.route.name,
            plugin: matchResult.route.plugin,
            type: 'group-blocked',
            response: `group ${groupId} not allowed for ${matchResult.route.plugin}`,
            durationMs: Date.now() - t0,
          });
          continue;
        }

        try {
          const ctx = { userId, groupId, roomId, sourceType, scopeId, replyToken, lineApi, event };
          const { type, result } = await router.execute(matchResult, ctx);

          // result 可能是字串或 LINE message 物件（如帶 mention 的 text message）
          const isMessageObj = result && typeof result === 'object' && result.type;
          const responseText = isMessageObj ? (result.text || '') : (result ? String(result) : '');

          // query 類型：回覆結果
          if (type === 'query' && result) {
            const replyPayload = isMessageObj ? result : responseText;
            try {
              await lineApi.reply(replyToken, replyPayload);
            } catch {
              await lineApi.push(userId, replyPayload);
            }
          }
          // action 類型：靜默執行，不回覆

          // 記錄
          if (logger) logger.log({
            userId, sourceType, text,
            route: matchResult.name || matchResult.pattern?.toString(),
            plugin: matchResult.plugin,
            type,
            response: responseText,
            durationMs: Date.now() - t0,
          });
        } catch (err) {
          console.error(`[webhook] handler error: ${err.message}`);
          if (logger) logger.log({
            userId, sourceType, text,
            route: matchResult.name || matchResult.pattern?.toString(),
            plugin: matchResult.plugin,
            type: matchResult.type,
            durationMs: Date.now() - t0,
            error: err.message,
          });
        }
        continue;
      }

      // 未匹配 → 交給 fallback（如 LLM）
      if (onUnmatched) {
        try {
          await onUnmatched({ userId, groupId, roomId, sourceType, text, replyToken, event });
          if (logger) logger.log({
            userId, sourceType, text,
            route: 'unmatched',
            type: 'fallback',
            durationMs: Date.now() - t0,
          });
        } catch (err) {
          console.error(`[webhook] unmatched handler error: ${err.message}`);
          if (logger) logger.log({
            userId, sourceType, text,
            route: 'unmatched',
            type: 'fallback',
            durationMs: Date.now() - t0,
            error: err.message,
          });
        }
      } else {
        if (logger) logger.log({
          userId, sourceType, text,
          route: 'unmatched',
          type: 'ignored',
          durationMs: Date.now() - t0,
        });
      }
    }
  };
}
