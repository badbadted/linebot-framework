// 用小帥真正的聊天規則（PERSONA）問聊天 AI，看模糊情境會不會先問、明確情境會不會直接給 draw
// 打本機 Luna /api/ext/llm（不帶金鑰、不印金鑰）；用法：node brain-eval.mjs
process.env.XIAOSHUAI_CAL_NO_ENRICH = '1';
const { PERSONA, parseReply } = await import('../plugins/xiaoshuai/index.js');

const CASES = [
  { want: 'ask', name: '分不清聊天還是要畫', lines: ['阿庭：我們剛剛看到野生企鵝', '小美：小帥 這個好可愛喔'] },
  { want: 'ask', name: '兩個都畫但指不清', lines: ['小美：小帥 兩個都畫'] },
  { want: 'draw', name: '再來一隻（明確是新的）', lines: ['阿庭：小帥 畫一隻恐龍', '小帥：好，小帥開始畫「恐龍」，大約 1～3 分鐘', '小帥：🎨 畫好了：恐龍', '阿庭：小帥 再來一隻藍色的'] },
  { want: 'ask', name: '新的還是改剛剛那張', lines: ['阿庭：小帥 畫一隻恐龍', '小帥：🎨 畫好了：恐龍', '阿庭：小帥 藍色的呢'] },
  { want: 'ask', name: '要改哪一張（照片和畫好的都有）', lines: ['小美：［照片］', '小帥：🎨 畫好了：恐龍', '小美：小帥 把這張背景換掉'] },
  { want: 'draw', name: '換句話叫畫（明確）', lines: ['小美：小帥可以把一隻在月亮上釣魚的貓弄成一張圖嗎'] },
  { want: 'edit', name: '接著改剛畫好的（明確）', lines: ['阿庭：小帥 畫一隻恐龍', '小帥：🎨 畫好了：恐龍', '阿庭：小帥 幫牠加點腹肌'] },
  { want: 'nodraw', name: '行程圖改卡片', lines: ['小美：小帥 把聖誕滑雪的行程弄成一張圖'] },
  { want: 'nodraw', name: '畫一下行程（11-14 實測誤畫的原句）', lines: ['小美：小帥 畫一下我們2026的滑雪行程'] },
];

const SYS = PERSONA;
let pass = 0;
for (const c of CASES) {
  const user = `【最近的對話】\n${c.lines.join('\n')}\n\n【叫你的那句】${c.lines.at(-1)}\n\n有人在叫你，要回話。只輸出一個 JSON 物件。`;
  const res = await fetch('http://127.0.0.1:18797/api/ext/llm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: SYS, messages: [{ role: 'user', content: user }], maxTokens: 1200, model: 'sonnet' }),
  });
  const j = await res.json();
  const p = parseReply(j.text || '', 'mention');
  const got = p.draw ? (p.draw.edit ? 'edit' : 'draw') : (/[?？嗎]/.test(p.reply) ? 'ask' : 'nodraw');
  const ok = got === c.want || (c.want === 'nodraw' && got === 'ask');
  if (ok) pass++;
  console.log(`${ok ? 'OK ' : 'NG '} ${c.name}：想要 ${c.want}，得到 ${got}｜${p.draw ? JSON.stringify(p.draw) : ''} ${p.reply.slice(0, 80)}`);
}
console.log(`${pass}/${CASES.length}`);
process.exit(0);
