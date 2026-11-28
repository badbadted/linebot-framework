// 公司文件查詢 前端。所有文字一律 textContent，不用 innerHTML。
'use strict';

const $ = s => document.querySelector(s);
const EXAMPLES = ['SQL 要怎麼防注入', '請假要走什麼流程', '基準文件的檔案命名原則'];
const STALE_DAYS = 14;

const state = { current: null, busy: false, timer: null };

// ── 小工具 ──
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : String(k));
  return e;
}
function icon(id, cls = 'ic') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('class', cls);
  const u = document.createElementNS(ns, 'use');
  u.setAttribute('href', `#${id}`);
  s.append(u);
  return s;
}
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (method !== 'GET') opts.headers['X-Sop-Desk'] = '1';
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error('連不到查詢服務：請從桌面捷徑重新開啟'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 1800);
}
const docLabel = s => `${s.title}${s.version ? ` ${s.version}` : ''}${s.date ? `（${s.date}）` : ''}`;
const dept = c => (String(c || '').split('｜')[0] || '').replace(/[()（）]/g, '');

// ── 狀態列 ──
async function loadStatus() {
  const bar = $('#status');
  try {
    const h = await api('/api/health');
    const at = h.kb.exportedAt ? new Date(h.kb.exportedAt) : null;
    const stale = at && (Date.now() - at) / 86400000 > STALE_DAYS;
    const atText = at ? `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} 匯出` : '匯出時間未知';
    bar.replaceChildren(
      el('span', { class: stale ? 'stale' : null }, h.kb.disabled ? `知識庫停用：${h.kb.disabled}` : `知識庫 ${h.kb.count.toLocaleString()} 段・${atText}${stale ? '（超過兩週，記得同步）' : ''}`),
      el('span', {}, el('span', { class: `dot${h.ollama ? '' : ' off'}` }), h.ollama ? 'Ollama 可用' : 'Ollama 無法連線'),
      el('span', {}, el('span', { class: `dot${h.claude.available && h.claude.loggedIn !== false ? '' : ' off'}` }),
        !h.claude.available ? '找不到 Claude CLI'
          : h.claude.loggedIn === false ? 'Claude 沒登入（PowerShell 執行 claude auth login）'
            : `Claude 可用（${h.claude.model}）`),
    );
  } catch (e) {
    bar.replaceChildren(el('span', {}, el('span', { class: 'dot off' }), e.message));
  }
}

// ── 歷史 ──
async function loadHistory() {
  const box = $('#history');
  let items = [];
  try { items = (await api('/api/history')).items; } catch { /* 狀態列會顯示 */ }
  // created_at 是本機時間（SQLite localtime），日期也用本機時間比
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = ymd(new Date());
  const y = ymd(new Date(Date.now() - 86400000));
  const groups = new Map();
  for (const it of items) {
    const d = it.created_at.slice(0, 10);
    const g = d === today ? '今天' : d === y ? '昨天' : '更早';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  const kids = [];
  for (const [g, list] of groups) {
    kids.push(el('div', { class: 'grp' }, g));
    for (const it of list) {
      const del = el('button', { class: 'del', type: 'button', title: '刪除這筆', 'aria-label': `刪除：${it.question}`, onclick: e => { e.stopPropagation(); removeHistory(it.id); } }, icon('i-del'));
      kids.push(el('div', {
        class: `item${state.current === it.id ? ' on' : ''}`, tabindex: '0', role: 'button', title: it.question,
        onclick: () => openHistory(it.id),
        onkeydown: e => {
          if (e.key === 'Enter') openHistory(it.id);
          if (e.key === 'Delete') removeHistory(it.id);
        },
      }, el('span', { class: 'q' }, it.question), del));
    }
  }
  if (!kids.length) kids.push(el('div', { class: 'muted', style: null }, '還沒有查詢紀錄'));
  box.replaceChildren(...kids);
}
async function removeHistory(id) {
  try { await api(`/api/history/${id}`, { method: 'DELETE' }); } catch (e) { toast(e.message); return; }
  if (state.current === id) { state.current = null; showEmpty(); }
  loadHistory();
}
async function openHistory(id) {
  try {
    const h = await api(`/api/history/${id}`);
    state.current = id;
    $('#q').value = h.question;
    if (h.status === 'answered') { renderCards(h.hits); renderAnswer({ answer: h.answer, sources: h.sources, durationMs: h.duration_ms }); }
    else if (h.status === 'raw') { renderCards(h.hits); renderRawInfo(h.hits.length); }
    else if (h.status === 'not_found') { renderNotFound(h.hits); }
    else { renderCards(h.hits); renderError({ errorKind: 'claude', error: h.error || '這題當時沒有回答成功' }, h.question); }
    loadHistory();
  } catch (e) { toast(e.message); }
}

// ── 右欄段落 ──
function card(h, label) {
  const c = el('div', { class: 'card', 'data-id': h.id });
  const more = el('button', { class: 'more', type: 'button', onclick: () => {
    c.classList.toggle('open');
    more.textContent = c.classList.contains('open') ? '收合' : '展開全文';
  } }, '展開全文');
  const text = h.content.split('\n').slice(1).join('\n').trim();
  c.append(
    label != null ? el('span', { class: 'n' }, String(label)) : '',
    el('span', { class: 't' }, `${h.title}${h.version ? ` ${h.version}` : ''}`),
    el('div', { class: 'meta' }, [h.date, dept(h.category)].filter(Boolean).join('・')),
    el('div', { class: 'x' }, text || h.content),
    more,
  );
  return c;
}
function renderCards(hits, { label = 'docN', note } = {}) {
  const box = $('#cards');
  $('#panel-count').textContent = hits.length ? `${hits.length} 段` : '';
  const kids = [];
  if (note) kids.push(el('div', { class: 'lbl' }, note));
  for (const h of hits) kids.push(card(h, label === 'none' ? null : h.docN));
  if (!hits.length) kids.push(el('div', { class: 'empty-hint pad' }, note ? '沒有相近段落' : '沒有段落'));
  box.replaceChildren(...kids);
  $('#panel').scrollTop = 0;
}
function relabelCards(sources) {
  const map = new Map();
  for (const s of sources) for (const id of s.hitIds) map.set(String(id), s.n);
  for (const c of document.querySelectorAll('#cards .card')) {
    const n = c.querySelector('.n');
    if (n) n.textContent = map.has(c.dataset.id) ? String(map.get(c.dataset.id)) : '·';
  }
}
function focusSource(s, btn) {
  document.querySelectorAll('.cite.hl,.card.hl').forEach(e => e.classList.remove('hl'));
  if (btn) btn.classList.add('hl');
  let first = null;
  for (const id of s.hitIds) {
    const c = document.querySelector(`#cards .card[data-id="${CSS.escape(String(id))}"]`);
    if (!c) continue;
    c.classList.add('hl', 'open');
    const more = c.querySelector('.more');
    if (more) more.textContent = '收合';
    first ||= c;
  }
  if (first) first.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ── 中欄 ──
function showEmpty() {
  $('#result').replaceChildren(
    el('div', { class: 'chips' }, EXAMPLES.map(t => el('button', { class: 'chip', type: 'button', onclick: () => { $('#q').value = t; ask(); } }, t))),
    el('div', { class: 'empty-hint hint-top' }, '先找出最相關的 6 段公司文件，再由 Claude 整理成答案並附出處'),
  );
  $('#cards').replaceChildren(el('div', { class: 'empty-hint pad' }, '送出問題後顯示'));
  $('#panel-count').textContent = '';
}
function renderWaiting(n) {
  const sec = el('span', {}, '0');
  $('#result').replaceChildren(el('div', { class: 'ans' },
    el('div', { class: 'wait' }, el('span', { class: 'spin' }),
      el('div', {}, el('b', {}, n ? `已找到 ${n} 段原文，可以先在右邊閱讀` : '查詢中'), el('span', { class: 'muted' }, '正在整理答案・已等 ', sec, ' 秒'))),
    el('div', { class: 'skel', style: null }), el('div', { class: 'skel' }), el('div', { class: 'skel' }),
  ));
  const t0 = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => { sec.textContent = String(Math.floor((Date.now() - t0) / 1000)); }, 500);
}
function renderAnswer({ answer, sources, durationMs }) {
  clearInterval(state.timer);
  const body = el('div', { class: 'body-text' });
  for (const part of answer.split(/(\[\d+\])/)) {
    const m = /^\[(\d+)\]$/.exec(part);
    const s = m && sources.find(x => x.n === Number(m[1]));
    if (s) {
      const b = el('button', { class: 'cite', type: 'button', title: docLabel(s) }, part);
      b.addEventListener('click', () => focusSource(s, b));
      body.append(b);
    } else body.append(part);
  }
  const copyText = `${answer}\n\n出處\n${sources.map(s => `[${s.n}] ${docLabel(s)}`).join('\n')}\n內容以原檔為準`;
  const copy = el('button', { class: 'btn ghost r', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(copyText); toast('已複製答案與出處'); } catch { toast('複製失敗'); }
  } }, icon('i-copy'), '複製（含出處）');
  $('#result').replaceChildren(el('div', { class: 'ans' },
    el('div', { class: 'hd' }, '答案', durationMs ? el('span', { class: 'muted' }, `${(durationMs / 1000).toFixed(1)} 秒`) : '', copy),
    body,
    el('div', { class: 'src' }, sources.map(s => el('div', {}, `[${s.n}] ${docLabel(s)}`)), el('div', { class: 'muted' }, '內容以原檔為準')),
  ));
  relabelCards(sources);
}
function renderRawInfo(n) {
  clearInterval(state.timer);
  $('#result').replaceChildren(el('div', { class: 'info' }, icon('i-doc'), ` 找到 ${n} 段原文，列在右邊。要 Claude 整理成答案，關掉「只看原文」再按查詢。`));
}
function renderNotFound(nearest, byModel) {
  clearInterval(state.timer);
  $('#result').replaceChildren(el('div', { class: 'info' },
    el('b', {}, '文件裡找不到足以回答的內容'),
    el('div', { class: 'muted', style: null }, byModel ? 'Claude 看過右邊的段落，判斷不足以回答。可以展開看看，或換個說法再問。' : '右邊是可能相關的段落，可以展開看看；或換個說法再問。'),
  ));
  if (!byModel) renderCards(nearest, { label: 'none', note: '可能相關，但不足以回答這個問題' });
}
function renderError(r, q) {
  clearInterval(state.timer);
  const timeout = r.errorKind === 'timeout';
  const retry = el('button', { class: 'btn ghost', type: 'button', onclick: () => { $('#q').value = q; $('#raw').checked = false; ask(); } }, icon('i-retry'), timeout ? '重新整理答案' : '再試一次');
  $('#result').replaceChildren(el('div', { class: 'banner warn' }, icon('i-warn', 'ic'),
    timeout ? 'Claude 整理逾時（60 秒）。找到的原文段落在右邊。' : `${r.error}。找到的原文段落在右邊。`, retry));
}
function renderFatal(msg) {
  clearInterval(state.timer);
  const retry = el('button', { class: 'btn ghost', type: 'button', onclick: () => { loadStatus(); ask(); } }, icon('i-retry'), '重試連線');
  $('#result').replaceChildren(el('div', { class: 'banner err' }, icon('i-warn'), `無法查詢文件：${msg}`, retry));
  $('#cards').replaceChildren(el('div', { class: 'empty-hint pad' }, '無法查詢'));
  $('#panel-count').textContent = '';
}

// ── 查詢 ──
async function ask() {
  const q = $('#q').value.trim();
  if (state.busy) return;
  if (q.length < 4) { toast('問題請寫 4 個字以上'); return; }
  const raw = $('#raw').checked;
  state.busy = true;
  $('#go').disabled = true;
  try {
    const s = await api('/api/search', { method: 'POST', body: { q } });
    if (s.status === 'ok') {
      renderCards(s.hits);
      if (!raw) renderWaiting(s.hits.length);
    }
    const r = await api('/api/answer', { method: 'POST', body: { q, raw } });
    state.current = r.id;
    if (r.status === 'answered') renderAnswer(r);
    else if (r.status === 'raw') renderRawInfo(r.hits.length);
    else if (r.status === 'not_found') renderNotFound(r.nearest, r.reason === 'model');
    else renderError(r, q);
    loadHistory();
  } catch (e) {
    renderFatal(e.message);
    loadStatus();
  } finally {
    state.busy = false;
    $('#go').disabled = false;
  }
}

$('#ask').addEventListener('submit', e => { e.preventDefault(); ask(); });
showEmpty();
loadStatus();
loadHistory();
$('#q').focus();
