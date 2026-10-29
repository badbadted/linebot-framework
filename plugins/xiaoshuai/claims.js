/**
 * 完成宣稱檢查（2026-10-29）：「做好了沒」只由程式講，AI 的 reply 不可以自己宣稱做完
 *
 * 起因：滑雪群 TED 說「加到行程裡就好不用記」→ 小帥用文字問「你確認我就照著改」→ TED 回「對」
 *       → 小帥說「我加進行程了」，但行程網頁根本沒改（那輪沒有 trip_edit），還違反「不用記」寫了記憶。
 *
 * 做法：一張表對應「宣稱的說法」↔「這一輪程式真的做成的動作」（parsed.done）。
 *   reply 裡出現已完成的宣稱、對應的動作卻沒做成 → 拿掉那一句，改成程式寫的如實說明。
 *   AI 用文字自問確認（「你確認我就改」）卻沒給對應的結構化欄位 → 拿掉那句，說明回「好」不會改任何東西。
 *   每個動作成功後的「✅ …」結果由各功能的程式自己附，不靠 AI 講。
 */

// done 的值：trip（行程真的套用了）、trip_pending（列出修改等確認）、nj（妞揪團建立了）、nj_draft、memory（記憶寫入了）、
//            link（收藏存了）、fitness（健身紀錄寫了）、poll、share（程式開了投票、排了／推了分享）、kb（小卡存了）
export const CLAIMS = [
  {
    key: 'trip',
    re: /(?:加進|加到|加入|放進|排進|寫進|補進|改進)[^。！!？?\n]{0,14}行程|行程[^。！!？?\n]{0,10}(?:改好|更新好|更新了|加好|加上了|改了|改完|補上了|寫好)|(?:已經|已|幫你)(?:改好|更新)(?:行程|了)/,
    ok: (d) => d.has('trip'),
    note: '（行程還沒改到：要改的話直接跟我說要加或改什麼，我會列出修改內容，大家回「好」才會真的改）',
  },
  {
    key: 'nj',
    re: /(?:團|活動)[^。！!？?\n]{0,6}(?:開好了|建立好了|開好囉|已經開了|送出了)|(?:開好|建立好)[^。！!？?\n]{0,4}(?:團|活動)|已經開團|幫你開團了|送出開團|開團送出|(?:已經|已|我)送出了|幫你送出|發到妞揪了/,
    ok: (d) => d.has('nj'),
    note: '（團還沒開：開團要照流程整理好內容，最後回「好」才會建立）',
  },
  {
    key: 'poll',
    re: /(?:投票|報名)[^。！!？?\n]{0,4}(?:開好了|開了喔|開好囉)|開好(?:投票|報名)/,
    ok: (d) => d.has('poll'),
    note: '（投票／報名還沒開：要開請說「小帥 開投票 標題：選項A、選項B」或「小帥 開報名 標題」）',
  },
  {
    key: 'share',
    re: /(?:分享|貼|轉|發)(?:出去|過去|到[^。！!？?\n]{0,10}群)了|已經(?:分享|貼過去|轉過去|發到)|分享好了|(?:幫你|已)(?:分享|轉發)了/,
    ok: (d) => d.has('share'),
    note: '（還沒分享出去：要分享請 TED 說「小帥 把這個活動分享到○○群」）',
  },
  {
    key: 'link',
    re: /收藏好了|(?:存|加)(?:到|進)收藏|已(?:經)?收藏|幫你收藏(?:了|好)/,
    ok: (d) => d.has('link'),
    note: '（還沒收藏：要收藏請說「小帥 幫我存 分類 網址」）',
  },
  {
    key: 'memory',
    re: /記住了|記下了|記下來了|記起來了|幫你記(?:了|好|下)|我記了|已經記|用記的|存起來了|幫你存了|存好了/,
    // 健身紀錄、收藏、小卡也會說「記下了／存好了」：那幾個真的做了就不算謊稱
    ok: (d) => d.has('memory') || d.has('fitness') || d.has('link') || d.has('kb') || d.has('trip'),
    note: '（這次沒有記下來）',
  },
];

// AI 用文字自問確認：「你確認我就照著改」「說好我就開」
export const SELF_CONFIRM_RE = /(?:確認|說好|回好|回個好|同意|沒問題)(?:的話|後|之後)?[，,、\s]*我(?:就|再|馬上)?(?:照著|幫你|直接)?(?:改|加|開|排|記|存|貼|更新)/;
const SELF_CONFIRM_NOTE = '（我還沒有列出要改的內容，所以回「好」不會改任何東西；要改就直接說要加或改什麼）';

const splitSentences = (s) => String(s || '').match(/[^。！!？?\n]+[。！!？?]*\n?|\n/g) || [];

/**
 * 一句話裡有宣稱：從宣稱那一小段（逗號、空白分開的）開始切到句尾，前面的話留著
 * （「沒罷工啦，我只是在默默加班😂 照片我用記的幫你存了：…」→「沒罷工啦，我只是在默默加班😂」）
 * 宣稱跨了好幾小段、找不到是哪一段時整句拿掉
 */
function cutClaim(sentence, re) {
  const clauses = sentence.match(/[^，,；;\s]+[，,；;\s]*/g) || [sentence];
  const kept = [];
  for (const c of clauses) {
    if (re.test(c)) return kept.join('').replace(/[，,；;、\s]+$/, '');
    kept.push(c);
  }
  return '';
}

/**
 * @param reply AI 的 reply（程式附加的結果另外接，不經過這裡）
 * @param done 這一輪程式真的做成的動作
 * @param structured AI 這一輪有沒有給結構化欄位（trip_edit、nj_event…），有就不算文字自問確認
 * @returns {{ reply: string, removed: string[] }}
 */
export function guardClaims(reply, done = new Set(), { structured = false } = {}) {
  let parts = splitSentences(reply);
  const removed = [];
  const notes = [];
  for (const c of CLAIMS) {
    if (c.ok(done)) continue;
    if (!parts.some(p => c.re.test(p))) continue;
    parts = parts.map(p => (c.re.test(p) ? cutClaim(p, c.re) : p)).filter(Boolean);
    removed.push(c.key);
    notes.push(c.note);
  }
  if (!structured && !done.has('trip_pending') && !done.has('nj_draft')) {
    if (parts.some(p => SELF_CONFIRM_RE.test(p))) {
      parts = parts.map(p => (SELF_CONFIRM_RE.test(p) ? cutClaim(p, SELF_CONFIRM_RE) : p)).filter(Boolean);
      removed.push('self_confirm');
      notes.push(SELF_CONFIRM_NOTE);
    }
  }
  if (!removed.length) return { reply: String(reply || ''), removed };
  const kept = parts.join('').trim();
  return { reply: [kept, ...notes].filter(Boolean).join('\n'), removed };
}

// 「不用記」：這句或前 1～2 句有人這樣說，這一輪不寫記憶（程式判斷，不靠 AI）
export const NO_MEMORY_RE = /不用記|不要記|別記|不必記|不需要記|不用存|不要存|別存|不必存/;
export function noMemoryAsked(trigger, transcript = []) {
  if (NO_MEMORY_RE.test(String(trigger?.text || ''))) return true;
  const others = (transcript || []).filter(t => !t.self).slice(-3); // 含這句本身在內的最後幾句
  return others.slice(-3).some(t => NO_MEMORY_RE.test(String(t.text || '')));
}
