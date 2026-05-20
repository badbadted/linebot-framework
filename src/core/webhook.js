/**
 * LINE Webhook 處理器
 *
 * - 驗證 X-Line-Signature（HMAC-SHA256）
 * - 解析事件，分派到 router
 * - 支援 text message 事件（其他類型可擴充）
 */

import { createHmac, timingSafeEqual } from 'crypto';

export function createWebhookHandler({ channelSecret, router, lineApi, allowlist, onUnmatched, logger }) {
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
      // 目前只處理 text message
      if (event.type !== 'message' || event.message?.type !== 'text') continue;

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

      const userId = event.source?.userId;
      const text = event.message.text;
      const replyToken = event.replyToken;
      if (!userId || !text || !replyToken) continue;

      // 來源類型：user / group / room
      const sourceType = event.source?.type || 'user';
      const groupId = event.source?.groupId || null;
      const roomId = event.source?.roomId || null;

      // 白名單檢查（可選，僅對個人訊息生效）
      if (allowlist && sourceType === 'user' && !allowlist.has(userId)) {
        console.log(`[webhook] blocked ${userId.slice(0, 8)}...`);
        await lineApi.reply(replyToken, `你好！\n你的 LINE ID：\n${userId}\n\n請聯繫管理員加入白名單。`);
        continue;
      }

      const sourceLabel = groupId ? `group:${groupId.slice(0, 8)}` : userId.slice(0, 8);
      console.log(`[webhook] ${sourceLabel}...: ${text.slice(0, 80)}`);

      // scopeId：私訊 = userId，群組 = groupId，聊天室 = roomId
      const scopeId = groupId || roomId || userId;

      // Router 比對（帶 sourceType 做 scope 過濾）
      const t0 = Date.now();
      const matchResult = router.match(text, { sourceType });
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

        try {
          const ctx = { userId, groupId, roomId, sourceType, scopeId, replyToken, lineApi, event };
          const { type, result } = await router.execute(matchResult, ctx);
          const responseText = result ? String(result) : '';

          // query 類型：回覆結果
          if (type === 'query' && result) {
            try {
              await lineApi.reply(replyToken, responseText);
            } catch {
              await lineApi.push(userId, responseText);
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
