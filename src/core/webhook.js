/**
 * LINE Webhook 處理器
 *
 * - 驗證 X-Line-Signature（HMAC-SHA256）
 * - 解析事件，分派到 router
 * - 支援 text message 事件（其他類型可擴充）
 */

import { createMemoryDedup } from './event-dedup.js';
import { createHmac, timingSafeEqual } from 'crypto';

const MAX_AGE_MS = 5 * 60_000;            // 一般事件：超過 5 分鐘不收（防重播）
const MAX_REDELIVERY_AGE_MS = 30 * 60_000; // LINE 重送的事件（timestamp 是原本的時間）：放寬到 30 分鐘

/** 事件夠不夠新：LINE 重送（deliveryContext.isRedelivery）放寬，其他照舊 5 分鐘 */
export function eventFresh(event, now = Date.now()) {
  const ts = Number(event?.timestamp || 0);
  const max = event?.deliveryContext?.isRedelivery === true ? MAX_REDELIVERY_AGE_MS : MAX_AGE_MS;
  return Math.abs(now - ts) <= max;
}

export function createWebhookHandler({ channelSecret, router, lineApi, allowlist, onUnmatched, onFollow, onUnfollow, onJoin, onLeave, onChatSeen, onGroupText, onPostback, logger, dedup = null }) {
  // 啟動期告警：未設 channelSecret 時 webhook 會對所有請求靜默 return，bot 變成「活著但永不回應」
  // 且沒有任何錯誤訊息可察覺。這裡在建構時（啟動一次）大聲提示，避免部署忘了設 secret 後默默失效。
  if (!channelSecret) {
    console.error('[webhook] ⚠️ 未設定 LINE_CHANNEL_SECRET — webhook 將忽略所有請求，bot 不會回應任何訊息！請檢查設定。');
  }

  // 事件去重：防止同一 webhookEventId 被重複處理（存 DB，bot 重開後 LINE 重送的事件也認得）
  const seen = dedup || createMemoryDedup();

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
      // 防重播攻擊：拒絕太舊的事件（LINE 重送的放寬到 30 分鐘）
      const eventTs = Number(event.timestamp || 0);
      if (!eventFresh(event)) {
        console.log(`[webhook] rejected stale event: ${eventTs}${event.deliveryContext?.isRedelivery ? '（重送）' : ''}`);
        continue;
      }
      if (event.deliveryContext?.isRedelivery) console.log(`[webhook] LINE 重送的事件（晚了 ${Math.round((Date.now() - eventTs) / 1000)} 秒）`);

      // 事件去重：同一 webhookEventId 只處理一次
      const eventId = event.webhookEventId;
      if (eventId) {
        if (seen.has(eventId)) {
          console.log(`[webhook] deduplicated event: ${eventId.slice(0, 8)}`);
          continue;
        }
        seen.add(eventId);
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

      // 按了 Flex 卡片上的 postback 按鈕（例：小帥投票）：交給 plugin，data 的格式與權限由 plugin 自己驗
      if (event.type === 'postback') {
        const chat = event.source?.groupId || event.source?.roomId || evUserId;
        console.log(`[webhook] postback ${String(chat || '').slice(0, 8)}... ${(evUserId || '').slice(0, 8)}: ${String(event.postback?.data || '').slice(0, 40)}`);
        if (onPostback && chat && evUserId) {
          try { await onPostback({ chatId: chat, userId: evUserId, sourceType: event.source?.type, data: String(event.postback?.data || ''), replyToken: event.replyToken, event }); }
          catch (err) { console.error(`[webhook] postback handler error: ${err.message}`); }
        }
        continue;
      }

      // 之後只處理 text message；略過的訊息也記一行，事後才分得出「沒收到」還是「收到但略過」
      const src = event.source?.groupId ? `group:${event.source.groupId.slice(0, 8)}`
        : event.source?.roomId ? `room:${event.source.roomId.slice(0, 8)}`
        : (evUserId || '').slice(0, 8);
      // 群組或私訊裡分享位置：轉成一句文字給 plugin 記進對話（如小帥答「附近有什麼」），不觸發回覆
      // 私訊（source.type 為 user）也一樣轉給 plugin，chatId 用 userId（小帥私訊；plugin 自己判斷要不要記）
      const chatOrDm = event.source?.groupId || event.source?.roomId || (event.source?.type === 'user' ? evUserId : null);
      if (event.type === 'message' && event.message?.type === 'location' && onGroupText) {
        const chat = chatOrDm;
        const m = event.message;
        if (chat) {
          // 地址只留到鄉鎮區、路名為止：去掉開頭郵遞區號，從第一個數字（巷弄門牌）起整段不送
          // 地點名稱也套同一規則：從第一個「數字（含中文數字）＋段巷弄號…」或第一個阿拉伯數字起整段不送
          const coarse = (s) => String(s || '').normalize('NFKC')
            .replace(/^〒?\s*[\d-]{3,}\s*/, '')
            .replace(/[\d一二三四五六七八九十百千〇零兩]+\s*[段巷弄號号樓楼室丁目番地].*$/, '')
            .replace(/\d.*$/, '')
            .trim();
          const where = [coarse(m.title), coarse(m.address)].filter(Boolean).join(' ') || '（沒有地址）';
          // 座標只留到小數第二位（約 1 公里），精確位置不送進 AI（會上網搜尋）
          const r2 = (n) => (Number.isFinite(+n) ? (+n).toFixed(2) : '?');
          const text = `［分享位置］${where}（約 緯度 ${r2(m.latitude)}，經度 ${r2(m.longitude)}）`;
          console.log(`[webhook] ${src}... ${(evUserId || '').slice(0, 8)}: location`);
          try { onGroupText({ chatId: chat, userId: evUserId, text, event }); }
          catch (err) { console.error(`[webhook] groupText hook error: ${err.message}`); }
          continue;
        }
      }
      // 群組或私訊裡的貼圖、照片：轉成一句文字給 plugin 記進對話，不觸發回覆
      // 貼圖用 LINE 附的關鍵字（不看圖、不花 AI）；照片只記「［照片］」，真的有人問才由 plugin 去下載來看
      if (event.type === 'message' && ['sticker', 'image'].includes(event.message?.type) && onGroupText) {
        const chat = chatOrDm;
        if (chat) {
          const m = event.message;
          const clean = (s) => String(s || '').replace(/[\r\n［］【】<>]/g, ' ').trim().slice(0, 20);
          let text = '［照片］';
          if (m.type === 'sticker') {
            const words = [m.text, ...(Array.isArray(m.keywords) ? m.keywords : [])].map(clean).filter(Boolean);
            text = words.length ? `［貼圖：${[...new Set(words)].slice(0, 3).join('、')}］` : '［貼圖］';
          }
          console.log(`[webhook] ${src}... ${(evUserId || '').slice(0, 8)}: ${m.type}`);
          try { onGroupText({ chatId: chat, userId: evUserId, text, event }); }
          catch (err) { console.error(`[webhook] groupText hook error: ${err.message}`); }
          continue;
        }
      }
      if (event.type !== 'message' || event.message?.type !== 'text') {
        if (event.type === 'message') {
          console.log(`[webhook] skipped non-text ${src}... ${(evUserId || '').slice(0, 8)}: ${event.message?.type || 'unknown'}`);
        } else {
          console.log(`[webhook] skipped event ${src}...: ${event.type}`);
        }
        continue;
      }

      const userId = evUserId;
      const text = event.message.text;
      const replyToken = event.replyToken;
      if (!userId || !text || !replyToken) {
        console.log(`[webhook] skipped text ${src}...: 缺 ${[!userId && 'userId', !text && 'text', !replyToken && 'replyToken'].filter(Boolean).join('、')}`);
        continue;
      }

      // 來源類型：user / group / room
      const sourceType = event.source?.type || 'user';
      const groupId = event.source?.groupId || null;
      const roomId = event.source?.roomId || null;

      // 延遲發現：群組/聊天室訊息 → 讓上層登記未知群組（fire-and-forget，不阻塞）
      const chatId = groupId || roomId;
      if (chatId && onChatSeen) { Promise.resolve(onChatSeen({ chatId })).catch(() => {}); }

      // 群組／聊天室每則文字訊息都讓 plugin 看一眼（如小帥記最近對話），同步執行、出錯不影響主流程
      if (chatId && onGroupText) {
        try { onGroupText({ chatId, userId, text, event }); }
        catch (err) { console.error(`[webhook] groupText hook error: ${err.message}`); }
      }

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

      // Router 比對（帶 sourceType + 群組/聊天室 ID 做 scope 和群組權限過濾；
      // 聊天室沒有 groupId，不帶 roomId 會被當成私訊而跳過權限檢查）
      const t0 = Date.now();
      const matchResult = router.match(text, { sourceType, groupId: groupId || roomId });
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
