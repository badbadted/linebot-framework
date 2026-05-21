/**
 * Echo Plugin — 範例 plugin，示範框架用法
 *
 * 功能：
 * - /echo <text>  → 回傳原文（query）
 * - /ping         → 回傳 pong（query）
 * - 每日早上 9 點推播 「早安」（schedule 範例，需設定 PUSH_USER_ID）
 */

const PUSH_USER_ID = process.env.PUSH_USER_ID || '';

export default {
  name: 'echo',

  commands: [
    {
      name: 'echo',
      pattern: /^\/echo\s+(.+)/i,
      describe: '/echo <文字> — 回傳原文',
      type: 'query',
      handler: async (match) => match[1],
    },
    {
      name: 'ping',
      pattern: /^\/ping$/i,
      describe: '/ping — 測試連線',
      type: 'query',
      handler: async () => 'pong 🏓',
    },
  ],

  schedules: [
    {
      name: 'echo-morning',
      cron: '0 9 * * *',  // 每天早上 9 點
      describe: '每日早安推播',
      pushTo: [
        { type: 'user', id: PUSH_USER_ID || '(env: PUSH_USER_ID)', label: '預設使用者' },
      ],
      handler: async ({ lineApi }) => {
        if (!PUSH_USER_ID) return;
        await lineApi.push(PUSH_USER_ID, '早安！☀️ 新的一天開始了。');
      },
    },
  ],
};
