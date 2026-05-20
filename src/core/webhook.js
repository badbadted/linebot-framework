/**
 * LINE Webhook 處理器
 *
 * - 驗證 X-Line-Signature（HMAC-SHA256）
 * - 解析事件，分派到 router
 * - 支援 text message 事件（其他類型可擴充）
 */

import { createHmac } from 'crypto';

export function createWebhookHandler({ channelSecret, router, lineApi, allowlist, onUnmatched, logger }) {
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
    if (hmac !== signature) {
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

      // Router 比對
      const t0 = Date.now();
      const matchResult = router.match(text);
      if (matchResult.matched) {
        try {
          const ctx = { userId, groupId, roomId, sourceType, replyToken, lineApi, event };
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
