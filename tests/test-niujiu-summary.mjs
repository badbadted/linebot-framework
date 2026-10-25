/**
 * /美食 summary 字數上限測試
 */

import assert from 'node:assert/strict';
import { clampSummary, parseEnrichResponse, SUMMARY_MAX_CHARS, previewHintFromHtml } from '../plugins/niujiu/gemini.js';

const len = (s) => Array.from(s).length;
let passed = 0;

function check(label, fn) {
  fn();
  passed++;
  console.log(`✓ ${label}`);
}

console.log('=== /美食 summary 字數上限測試 ===\n');

check('上限是 30 字', () => {
  assert.equal(SUMMARY_MAX_CHARS, 30);
});

check('未超過上限：原樣回傳', () => {
  const s = '羽田機場內的平價拉麵店';
  assert.equal(clampSummary(s), s);
});

check('剛好 30 字：原樣回傳', () => {
  const s = '一'.repeat(30);
  assert.equal(clampSummary(s), s);
});

check('超過上限且有標點：在上限內最後一個標點斷句', () => {
  const s = '以清爽雞白湯聞名的拉麵店，麵條每日現做，叉燒採低溫烹調，深受旅客與機場員工喜愛';
  const out = clampSummary(s);
  assert.equal(out, '以清爽雞白湯聞名的拉麵店，麵條每日現做，叉燒採低溫烹調');
  assert.ok(len(out) <= 30);
});

check('第 31 個字剛好是標點：保留完整 30 字', () => {
  const s = '一'.repeat(30) + '，後面還有很多字';
  assert.equal(clampSummary(s), '一'.repeat(30));
});

check('超過上限且沒有標點：硬切 29 字加「…」', () => {
  const out = clampSummary('一'.repeat(45));
  assert.equal(out, '一'.repeat(29) + '…');
  assert.equal(len(out), 30);
});

check('標點太靠前：不在那裡斷，改硬切', () => {
  const s = '好吃，' + '一'.repeat(40);
  const out = clampSummary(s);
  assert.equal(len(out), 30);
  assert.ok(out.endsWith('…'));
  assert.ok(out.startsWith('好吃，'));
});

check('硬切位置落在標點上：不留下「，…」', () => {
  const s = '一二三，' + '一'.repeat(24) + '，' + '一'.repeat(20);
  const out = clampSummary(s);
  assert.ok(len(out) <= 30);
  assert.ok(!/[，、；。]…?$/.test(out.replace(/…$/, '')));
});

check('頓號不當斷點：不會只留下並列清單的前半', () => {
  const s = '台東在地老字號海鮮熱炒，囊括山珍海味，芋頭米粉、四季酥排骨為招牌菜，曾獲500盤推薦。';
  assert.equal(clampSummary(s), '台東在地老字號海鮮熱炒，囊括山珍海味');
});

check('半形標點也算斷點', () => {
  const s = 'Famous tonkotsu ramen shop, rich broth and handmade noodles daily';
  const out = clampSummary(s);
  assert.equal(out, 'Famous tonkotsu ramen shop');
});

check('emoji 算一個字，不會切到一半', () => {
  const s = '🍜'.repeat(40);
  const out = clampSummary(s);
  assert.equal(len(out), 30);
  assert.equal(out, '🍜'.repeat(29) + '…');
});

check('換行與多餘空白收成一個空格', () => {
  assert.equal(clampSummary('  平價拉麵\n\n名店  '), '平價拉麵 名店');
});

check('非字串：回空字串', () => {
  assert.equal(clampSummary(null), '');
  assert.equal(clampSummary(undefined), '');
  assert.equal(clampSummary(123), '');
});

check('parseEnrichResponse：超長 summary 會被截短，其他欄位不動', () => {
  const longHours = '週一至週五 11:00–21:00\n週六、週日 10:00–22:00\n每月第三個週二公休';
  const fields = parseEnrichResponse(JSON.stringify({
    address: '東京都大田區羽田機場三丁目3-2 第一航廈',
    summary: '以清爽雞白湯聞名的拉麵店，麵條每日現做，叉燒採低溫烹調，深受旅客與機場員工喜愛',
    hours: longHours,
  }));
  assert.ok(len(fields.summary) <= 30);
  assert.equal(fields.hours, longHours);
  assert.equal(fields.address, '東京都大田區羽田機場三丁目3-2 第一航廈');
});

check('parseEnrichResponse：空 summary 不寫入欄位', () => {
  const fields = parseEnrichResponse(JSON.stringify({ summary: '   ', area: '東京羽田' }));
  assert.ok(!('summary' in fields));
  assert.equal(fields.area, '東京羽田');
});

check('parseEnrichResponse：包在 code fence 裡也能處理', () => {
  const fields = parseEnrichResponse('```json\n{"summary": "' + '一'.repeat(50) + '"}\n```');
  assert.equal(len(fields.summary), 30);
});

check('FB 預覽：og:title 放完整貼文、description 被包含就不重複', () => {
  const html = '<meta property="og:title" content="52&#xa0;萬次觀看 | &#x1f4cd;東京最後一天，別急著去機場。&#10;📍Narita Omotesando | Lex Goh" />'
    + '<meta property="og:description" content="&#x1f4cd;東京最後一天，別急著去機場。..." />';
  const h = previewHintFromHtml(html);
  assert.ok(h.includes('📍Narita Omotesando'));
  assert.ok(!h.includes(' — '));
});

check('FB 登入牆：沒有預覽就回空字串', () => {
  assert.equal(previewHintFromHtml('<html><title>Facebook</title></html>'), '');
});

check('一般網頁：標題＋說明都保留', () => {
  const h = previewHintFromHtml('<title>阿裕牛肉湯｜台南美食</title><meta name="description" content="仁德區溫體牛肉湯">');
  assert.equal(h, '阿裕牛肉湯｜台南美食 — 仁德區溫體牛肉湯');
});

console.log(`\n${passed} 項全過`);
