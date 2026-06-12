/**
 * LINE Flex Message 工具函數
 *
 * 快速建立常用的 Flex Message，免手寫巨大 JSON。
 * 產出的物件可直接傳給 lineApi.reply() / lineApi.push()。
 *
 * 用法：
 *   import { flex } from '../utils/flex.js';
 *   await lineApi.reply(replyToken, flex.card({ title: '...', body: '...' }));
 */

/**
 * 簡易卡片（標題 + 內文 + 可選按鈕）
 * @param {Object} opts
 * @param {string} opts.title - 標題
 * @param {string} opts.body - 內文
 * @param {string} [opts.footer] - 底部文字
 * @param {Array} [opts.actions] - 按鈕動作 [{ label, text?, uri? }]
 * @param {string} [opts.color] - 標題底色（預設 #0367D3）
 */
function card({ title, body, footer, actions, color = '#0367D3' }) {
  const contents = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: color,
      paddingAll: '16px',
      contents: [
        { type: 'text', text: title, color: '#ffffff', weight: 'bold', size: 'lg' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: body, wrap: true, size: 'sm', color: '#333333' },
      ],
    },
  };

  if (footer) {
    contents.footer = {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        { type: 'text', text: footer, size: 'xs', color: '#999999', wrap: true },
      ],
    };
  }

  if (actions?.length) {
    contents.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '12px',
      contents: actions.map(a => ({
        type: 'button',
        style: 'primary',
        color: color,
        height: 'sm',
        action: a.uri
          ? { type: 'uri', label: a.label, uri: a.uri }
          : { type: 'message', label: a.label, text: a.text || a.label },
      })),
    };
  }

  return { type: 'flex', altText: title, contents };
}

/**
 * 簡約確認卡（白底、無色塊、文字標題 + 文字連結按鈕）
 * 與簡約式清單同一視覺語言。
 * @param {Object} opts
 * @param {string} [opts.icon] - 標題前小圖示（如 ✓ ⏰ 🧳）
 * @param {string} opts.title - 標題（accent 色小字）
 * @param {string} [opts.body] - 內文（深色）
 * @param {string} [opts.accent] - 主色（標題與連結色，預設綠）
 * @param {Array} [opts.actions] - [{ label, text?, uri?, color? }] 底部文字連結
 */
function mini({ icon = '', title, body, accent = '#10b981', actions = [] }) {
  const contents = [
    { type: 'text', text: `${icon} ${title}`.trim(), size: 'sm', color: accent, weight: 'bold' },
  ];
  if (body) {
    contents.push({ type: 'text', text: body, size: 'md', color: '#1e293b', wrap: true, margin: 'md' });
  }
  if (actions.length) {
    contents.push({ type: 'separator', margin: 'lg', color: '#f1f5f9' });
    contents.push({
      type: 'box', layout: 'horizontal', margin: 'md', spacing: 'md',
      contents: actions.map(a => ({
        type: 'text', text: a.label, size: 'sm', weight: 'bold', align: 'center', flex: 1,
        color: a.color || accent,
        action: a.uri
          ? { type: 'uri', label: a.label, uri: a.uri }
          : { type: 'message', label: a.label, text: a.text || a.label },
      })),
    });
  }
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents },
    },
  };
}

/**
 * 清單（多行項目）
 * @param {string} title - 標題
 * @param {Array} items - [{ label, value }]
 * @param {string} [color] - 標題底色
 */
function list(title, items, color = '#0367D3') {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: color,
        paddingAll: '16px',
        contents: [
          { type: 'text', text: title, color: '#ffffff', weight: 'bold', size: 'lg' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',
        contents: items.map(item => ({
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: item.label, size: 'sm', color: '#555555', flex: 3 },
            { type: 'text', text: String(item.value), size: 'sm', color: '#111111', align: 'end', flex: 2 },
          ],
        })),
      },
    },
  };
}

/**
 * 確認對話框（是/否兩個按鈕）
 * @param {string} text - 問題文字
 * @param {string} yesText - 按「是」送出的訊息
 * @param {string} noText - 按「否」送出的訊息
 */
function confirm(text, yesText = '是', noText = '否') {
  return {
    type: 'template',
    altText: text,
    template: {
      type: 'confirm',
      text,
      actions: [
        { type: 'message', label: '是', text: yesText },
        { type: 'message', label: '否', text: noText },
      ],
    },
  };
}

/**
 * 快速回覆按鈕列（顯示在訊息下方的快速選項）
 * @param {string} text - 主訊息文字
 * @param {Array} options - ['選項1', '選項2', ...]
 */
function quickReply(text, options) {
  return {
    type: 'text',
    text,
    quickReply: {
      items: options.map(opt => ({
        type: 'action',
        action: { type: 'message', label: opt, text: opt },
      })),
    },
  };
}

export const flex = { card, mini, list, confirm, quickReply };
