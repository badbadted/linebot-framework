/**
 * 小帥的 LINE Flex 卡片（2026-10-28，版面照 共用/AI產出/mockup/小帥卡片版面預覽.html）
 *
 * 「找來的資料」才用卡片：行程總覽、附圖、店家推薦、上網查到的重點；閒聊照舊純文字。
 * AI 只在 JSON 給結構化欄位，Flex JSON 一律由這裡組：
 *   - 卡片裡的文字都當資料：去控制字元、壓空白、限長（標題 2 行、內容最多 4 項且每項 1 行）
 *   - 按鈕網址只收 https，而且要通過呼叫端給的白名單（程式組的地圖／行程網頁、Commons 檔案頁、這輪工具真的搜到的網址）
 *   - 每則 Flex 都有 altText（通知預覽、舊版 LINE 看的重點文字）
 * 窄卡 kilo（約螢幕 70%，露出下一張）給清單類；附圖用 mega＋hero 圖。行程最多 7 張，其他最多 5 張。
 */

export const MAX_TRIP = 7;
export const MAX_OTHER = 5;
const ALT_MAX = 400;

// 行程網頁的顏色代號 → 卡片標頭（滑雪日藍、城市日綠、飛行日橘）
export const DAY_COLORS = { 'c-ski': '#2563a8', 'c-tokyo': '#0f8a6a', 'c-fly': '#c2620a' };
const BTN = '#0f8a6a';
const DARK = '#1e293b';

/** 卡片文字：去 HTML 標籤與控制字元、壓空白、限長（超過加…） */
export function clean(s, max = 60) {
  const t = String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(t);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
}

/** 按鈕網址：https、合法、不超過 1000 字，而且 allow(url) 要過；不合格回 null */
export function safeUri(u, allow = () => false) {
  let x;
  try { x = new URL(String(u || '').trim()); } catch { return null; }
  if (x.protocol !== 'https:' || x.username || x.password) return null;
  const s = x.toString();
  if (s.length > 1000 || !allow(s)) return null;
  return s;
}

const text = (t, o = {}) => ({ type: 'text', text: t || ' ', wrap: true, ...o });

function button(b) {
  if (b.uri) return { type: 'button', style: b.primary ? 'primary' : 'secondary', height: 'sm', ...(b.primary ? { color: BTN } : {}), action: { type: 'uri', label: clean(b.label, 20), uri: b.uri } };
  return { type: 'button', style: b.primary ? 'primary' : 'secondary', height: 'sm', ...(b.primary ? { color: BTN } : {}), action: { type: 'message', label: clean(b.label, 20), text: clean(b.text, 60) } };
}

/**
 * 一張卡
 * @param o { size, color, sub, title, hero, rows:[[label, text]], lines:[text], more, note, credit, buttons:[{label, uri|text, primary}] }
 */
export function bubble(o) {
  const b = { type: 'bubble', size: o.size || 'kilo' };
  if (o.hero) b.hero = { type: 'image', url: o.hero, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' };
  if (o.title && !o.hero) {
    b.header = {
      type: 'box', layout: 'vertical', backgroundColor: o.color || DARK, paddingAll: '12px', spacing: 'xs',
      contents: [
        ...(o.sub ? [text(clean(o.sub, 40), { size: 'xs', color: '#ffffffcc', wrap: false })] : []),
        text(clean(o.title, 40), { size: 'md', weight: 'bold', color: '#ffffff', maxLines: 2 }),
      ],
    };
  }
  const body = [];
  if (o.title && o.hero) body.push(text(clean(o.title, 40), { size: 'md', weight: 'bold', maxLines: 2 }));
  const rows = (o.rows || []).filter(r => clean(r[1], 60));
  for (const [label, val] of rows.slice(0, 4)) {
    body.push({
      type: 'box', layout: 'baseline', spacing: 'sm',
      contents: [
        text(clean(label, 8) || '・', { size: 'xs', color: '#64748b', flex: 2, wrap: false }),
        text(clean(val, 60), { size: 'sm', flex: 6, wrap: false }),
      ],
    });
  }
  const lines = (o.lines || []).map(l => clean(l, 80)).filter(Boolean);
  for (const l of lines.slice(0, 4)) body.push(text(l, { size: 'sm', color: '#334155', maxLines: o.hero ? 2 : 1, wrap: !!o.hero }));
  const more = (o.more || 0) + Math.max(0, rows.length - 4) + Math.max(0, lines.length - 4);
  if (more > 0) body.push(text(`還有 ${more} 項…`, { size: 'xs', color: '#64748b', wrap: false }));
  if (o.note) body.push(text(clean(o.note, 60), { size: 'xs', color: '#64748b', maxLines: 2 }));
  if (o.credit) body.push(text(clean(o.credit, 80), { size: 'xxs', color: '#94a3b8', maxLines: 2, margin: 'md' }));
  b.body = { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: body.length ? body : [text(' ', { size: 'xs' })] };
  const btns = (o.buttons || []).filter(x => x && (x.uri || x.text)).slice(0, 3);
  if (btns.length) {
    // 兩個按鈕並排（跟版面預覽一樣），其他直排
    b.footer = btns.length === 2
      ? { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '10px', contents: btns.map(button) }
      : { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '10px', contents: btns.map(button) };
  }
  return b;
}

/** 一則 Flex 訊息：一張卡直接放，多張變 carousel；altText 是重點文字 */
export function flex(bubbles, alt, max = MAX_OTHER) {
  const list = (bubbles || []).filter(Boolean).slice(0, max);
  if (!list.length) return null;
  // altText 保留換行（通知預覽、舊版 LINE 一行一項比較好讀），每行各自清乾淨，總長限 400
  const lines = String(alt ?? '').split('\n').map(l => clean(l, ALT_MAX)).filter(Boolean);
  const joined = Array.from(lines.join('\n'));
  const altText = (joined.length > ALT_MAX ? `${joined.slice(0, ALT_MAX - 1).join('')}…` : joined.join('')) || '小帥整理的資料';
  return { type: 'flex', altText, contents: list.length === 1 ? list[0] : { type: 'carousel', contents: list } };
}

// ── 行程 ──────────────────────────────────────────

const itemText = (it) => clean([it?.title, it?.text].filter(Boolean).join(' '), 60);

/**
 * 行程卡：資料從綁定的行程 JSON 取（不是 AI 寫的）
 * @param t 行程 JSON（trips/<name>.json）
 * @param days ['D3', …] 只要這幾天；空陣列或含 'all' ＝封面＋前幾天
 * @param url 行程網頁網址（程式組）
 */
export function tripFlex(t, { days = [], url, title = '' } = {}) {
  const all = Array.isArray(t?.days) ? t.days : [];
  if (!all.length) return null;
  const want = (days || []).map(d => String(d).toUpperCase());
  const whole = !want.length || want.includes('ALL');
  const picked = whole ? all.slice(0, MAX_TRIP - 1) : all.filter(d => want.includes(String(d.id).toUpperCase())).slice(0, MAX_TRIP);
  if (!picked.length) return null;
  const name = clean(t.meta?.title || t.title || title, 40);
  const first = all[0], last = all[all.length - 1];
  const dates = clean(t.meta?.dates, 40) || `${clean(first.glance?.d || first.date, 12)} – ${clean(last.glance?.d || last.date, 12)}・${all.length} 天`;
  const dayUrl = (d) => (url ? `${url}#${String(d.key || d.id).toLowerCase()}` : null);
  const bubbles = [];
  if (whole) {
    const rest = all.length - picked.length;
    bubbles.push(bubble({
      color: DARK, sub: dates, title: name,
      lines: [
        ...(t.meta?.subtitle ? [t.meta.subtitle] : []),
        ...all.slice(0, 3).map(d => `${d.id} ${d.glance?.emoji || ''} ${d.glance?.place || d.place || ''}`),
      ],
      note: rest > 0 ? `往右滑看前 ${picked.length} 天，${all[picked.length].id} 之後跟我說「小帥 ${all[picked.length].id} 要幹嘛」` : '往右滑看每一天 →',
      buttons: [
        url && { label: '開完整行程網頁', uri: url, primary: true },
        { label: '📸 截一覽表', text: '小帥 截 一覽' },
      ],
    }));
  }
  for (const d of picked) {
    const items = Array.isArray(d.items) ? d.items : [];
    bubbles.push(bubble({
      color: DAY_COLORS[d.color] || DAY_COLORS[d.glance?.color] || BTN,
      sub: `${d.id} ${d.date || ''}`,
      title: d.place || d.glance?.place || d.id,
      rows: items.slice(0, 4).map(it => [it.when, itemText(it)]),
      more: Math.max(0, items.length - 4),
      buttons: [
        { label: '📸 截這天', text: `小帥 截 ${d.id}`, primary: true },
        dayUrl(d) && { label: '開網頁', uri: dayUrl(d) },
      ],
    }));
  }
  const alt = whole
    ? `${name}（${dates}）：${all.map(d => `${d.id} ${clean(d.glance?.place || d.place, 20)}`).join('、')}`
    : picked.map(d => `${d.id} ${clean(d.place, 30)}：${(d.items || []).slice(0, 4).map(it => `${it.when ? `${it.when} ` : ''}${itemText(it)}`).join('、')}`).join('\n');
  return flex(bubbles, alt, MAX_TRIP);
}

// ── 附圖 ──────────────────────────────────────────

/**
 * 附圖卡（mega＋hero）：圖、標題、2 行說明、底部小字署名；按鈕：地圖、圖片來源（Commons 檔案頁）
 * @param p photo.findPhoto 的結果 { url, page, artist, license }
 */
export function photoFlex(p, { title, text: desc, mapUri, note } = {}) {
  if (!p?.url) return null;
  const credit = `📷 ${p.artist || (p.kind === 'pd' ? '作者不詳' : 'Wikimedia Commons')}・${p.license}・Wikimedia Commons`;
  const b = bubble({
    size: 'mega', hero: p.url, title: title || '參考圖',
    lines: desc ? [desc] : [], note, credit,
    buttons: [
      mapUri && { label: '📍 地圖', uri: mapUri, primary: true },
      p.page && { label: '圖片來源', uri: p.page },
    ],
  });
  const alt = `${clean(title, 40) || '參考圖'}${desc ? `：${clean(desc, 100)}` : ''}（${credit}）`;
  return withFallback(flex([b], alt), [{ type: 'image', originalContentUrl: p.url, previewImageUrl: p.previewUrl || p.url }, { type: 'text', text: clean(alt, 400) }]);
}

// ── 店家推薦 ──────────────────────────────────────

const KIND_COLORS = [
  [/壽司|寿司|海鮮|生魚|丼|魚/, '#b4462b'],
  [/拉麵|ラーメン|麵|うどん|蕎麥|そば/, '#c2620a'],
  [/燒肉|焼肉|牛|豬|豚|炸|カツ|肉/, '#8a3b12'],
  [/甜|和菓子|咖啡|カフェ|cafe|蛋糕|麵包|パン/i, '#7a5aa6'],
];
export const kindColor = (k) => (KIND_COLORS.find(([re]) => re.test(String(k || ''))) || [null, BTN])[1];

/**
 * 店家卡：一家一張，不放店家照片（版權），只有程式組的 Google 地圖按鈕
 * @param shops AI 給的 [{ name, kind, area, price, tip, map }]
 * @param mapLink (query) => 地圖網址（photo.mapLink）
 */
export function shopsFlex(shops, mapLink) {
  const list = (Array.isArray(shops) ? shops : []).filter(s => s && clean(s.name, 30)).slice(0, MAX_OTHER);
  if (!list.length) return null;
  const bubbles = list.map(s => bubble({
    color: kindColor(s.kind), sub: clean(s.kind, 20), title: clean(s.name, 30),
    rows: [['地點', s.area], ['價位', s.price], ['提醒', s.tip]],
    buttons: [{ label: '📍 Google 地圖', uri: mapLink(clean(s.map, 60) || `${clean(s.name, 30)} ${clean(s.area, 30)}`), primary: true }],
  }));
  const alt = list.map((s, i) => `${i + 1}. ${clean(s.name, 30)}${s.area ? `（${clean(s.area, 30)}）` : ''}${s.tip ? ` ${clean(s.tip, 30)}` : ''}`).join('\n');
  return flex(bubbles, alt);
}

// ── 上網查到的重點 ────────────────────────────────

const normUrl = (u) => {
  try { const x = new URL(String(u).trim()); x.hash = ''; return x.toString().replace(/\/$/, ''); } catch { return ''; }
};

/**
 * 查資料卡：每個重點一張；「看來源」只收這輪工具真的搜到或讀過的網址（sources），拿不到清單就不放按鈕
 * @param cards AI 給的 [{ title, lines:[...], source }]
 * @param sources Luna 回的 [{ url, title }]
 */
export function researchFlex(cards, sources = []) {
  const allowed = new Map((sources || []).map(s => [normUrl(s?.url), s.url]).filter(([k]) => k));
  const list = (Array.isArray(cards) ? cards : []).filter(c => c && clean(c.title, 40)).slice(0, MAX_OTHER);
  if (!list.length) return null;
  const bubbles = list.map(c => {
    const src = allowed.get(normUrl(c.source));
    const uri = src ? safeUri(src, () => true) : null;
    return bubble({
      color: DARK, title: clean(c.title, 40),
      lines: (Array.isArray(c.lines) ? c.lines : [c.lines]).filter(x => typeof x === 'string'),
      buttons: [uri && { label: '看來源', uri }],
    });
  });
  const alt = list.map(c => `・${clean(c.title, 40)}：${(Array.isArray(c.lines) ? c.lines : []).map(l => clean(l, 60)).filter(Boolean).slice(0, 2).join('，')}`).join('\n');
  return flex(bubbles, alt);
}

// Flex 送不出去時要換成的訊息（例：附圖卡 → 圖片＋文字）；用 WeakMap 記，不能塞進訊息本身（LINE 會擋不認得的欄位）
const fallbacks = new WeakMap();
export function withFallback(msg, fb) {
  if (msg && fb?.length) fallbacks.set(msg, fb);
  return msg;
}

/** Flex 送失敗時退回純文字：每則 Flex 換成它登記的替代訊息，沒有就用 altText；總數仍限 5 則 */
export const plainFallback = (messages) => messages
  .flatMap(m => (m?.type === 'flex' ? (fallbacks.get(m) || [{ type: 'text', text: m.altText }]) : [m]))
  .slice(0, 5);
