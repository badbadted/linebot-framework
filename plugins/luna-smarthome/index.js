/**
 * Luna SmartHome Plugin
 *
 * 從 Luna 的 quick-commands.js 遷移而來的 regex router。
 * 透過 HTTP 呼叫 Luna server 的 tool executor。
 *
 * 環境變數：
 *   LUNA_API_URL — Luna server 位址（預設 http://localhost:3000）
 */

const LUNA_API = process.env.LUNA_API_URL || 'http://localhost:3000';

async function callLunaTool(toolName, args = {}) {
  const res = await fetch(`${LUNA_API}/api/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: toolName, args }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Luna tool ${toolName} failed: ${res.status}`);
  try { return JSON.parse(body); } catch { return body; }
}

export default {
  name: 'luna-smarthome',

  commands: [
    // ── 冷氣 ──
    {
      name: 'ac-on',
      pattern: /^開冷氣\s*(\d{1,2})?\s*度?$/,
      type: 'action',
      handler: async (match) => {
        const temp = match[1] ? parseInt(match[1]) : 26;
        await callLunaTool('control_ac', { action: 'on', temperature: temp });
      },
    },
    {
      name: 'ac-off',
      pattern: /^關冷氣$/,
      type: 'action',
      handler: async () => {
        await callLunaTool('control_ac', { action: 'off' });
      },
    },

    // ── 燈光 ──
    {
      name: 'lights-on',
      pattern: /^開燈$/,
      type: 'action',
      handler: async () => {
        await callLunaTool('control_light', { action: 'on' });
      },
    },
    {
      name: 'lights-off',
      pattern: /^關燈$/,
      type: 'action',
      handler: async () => {
        await callLunaTool('control_light', { action: 'off' });
      },
    },

    // ── 音樂 ──
    {
      name: 'music-play',
      pattern: /^播放?音樂$/,
      type: 'action',
      handler: async () => {
        await callLunaTool('control_spotify', { action: 'play' });
      },
    },
    {
      name: 'music-stop',
      pattern: /^(?:關|停止?|暫停)音樂$/,
      type: 'action',
      handler: async () => {
        await callLunaTool('control_spotify', { action: 'pause' });
      },
    },
    {
      name: 'music-next',
      pattern: /^下一首$/,
      type: 'action',
      handler: async () => {
        await callLunaTool('control_spotify', { action: 'next' });
      },
    },
    {
      name: 'volume-up',
      pattern: /^大聲一?點$|^音量[大升]$/,
      type: 'action',
      handler: async () => {
        await callLunaTool('control_spotify', { action: 'volume_up' });
      },
    },
    {
      name: 'volume-down',
      pattern: /^小聲一?點$|^音量[小降]$/,
      type: 'action',
      handler: async () => {
        await callLunaTool('control_spotify', { action: 'volume_down' });
      },
    },

    // ── 查詢類 ──
    {
      name: 'weather',
      pattern: /^(?:今天)?天氣/,
      type: 'query',
      handler: async () => {
        const result = await callLunaTool('get_weather');
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    },
    {
      name: 'home-status',
      pattern: /^(?:家[裡里]|房間)(?:狀態|狀況|溫度|溫濕度)/,
      type: 'query',
      handler: async () => {
        const result = await callLunaTool('get_home_status');
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    },
  ],

  schedules: [
    // 範例：每天早上 7:30 推播天氣
    // {
    //   name: 'luna-morning-weather',
    //   cron: '30 7 * * *',
    //   handler: async ({ lineApi }) => {
    //     const weather = await callLunaTool('get_weather');
    //     await lineApi.push(OWNER_USER_ID, `🌤️ 早安！今天天氣：\n${weather}`);
    //   },
    // },
  ],
};
