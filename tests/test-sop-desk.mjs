/**
 * sop-desk（自用本機查詢 App）測試
 *  - guard：錯的 Host、外來 Origin、跨站、缺自訂標頭、非 JSON 都擋
 *  - claude-cli：參數陣列（工具全關）、問題走 stdin、環境變數拿掉、逾時會殺、錯誤訊息轉白話
 *  - 伺服器：search／answer（答／找不到／只看原文／逾時）、歷史、忙碌中擋第二題、靜態檔不能跳出資料夾
 */
import http from 'http';
import { EventEmitter } from 'events';
import { checkRequest, createRateLimit } from '../apps/sop-desk/guard.mjs';
import { createClaudeCli, buildArgs, cleanEnv, explainError } from '../apps/sop-desk/claude-cli.mjs';
import { createApp, hitsToDto, splitAnswer } from '../apps/sop-desk/server.mjs';
import { openHistory } from '../apps/sop-desk/history.mjs';
import { parseHeader } from '../plugins/sop/retriever.js';

let fail = 0;
function check(label, cond) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fail++;
}

// ── guard ──
const P = 4790;
const req = (o) => ({ url: '/api/answer', method: 'POST', headers: { host: `127.0.0.1:${P}`, 'x-sop-desk': '1', 'content-type': 'application/json', origin: `http://127.0.0.1:${P}`, ...o.headers }, ...o, headers: { host: `127.0.0.1:${P}`, 'x-sop-desk': '1', 'content-type': 'application/json', origin: `http://127.0.0.1:${P}`, ...(o.headers || {}) } });
check('正常請求放行', checkRequest(req({}), P) === null);
check('localhost 也放行', checkRequest(req({ headers: { host: `localhost:${P}`, origin: `http://localhost:${P}` } }), P) === null);
check('錯的 Host（DNS rebinding）擋', checkRequest(req({ headers: { host: 'evil.example:4790' } }), P) === 'bad host');
check('外來 Origin 擋', checkRequest(req({ headers: { origin: 'https://evil.example' } }), P) === 'bad origin');
check('跨站 Sec-Fetch-Site 擋', checkRequest(req({ headers: { 'sec-fetch-site': 'cross-site' } }), P) === 'cross-site');
check('缺 X-Sop-Desk 擋', checkRequest(req({ headers: { 'x-sop-desk': undefined } }), P) === 'missing header');
check('POST 不是 JSON 擋', checkRequest(req({ headers: { 'content-type': 'text/plain' } }), P) === 'not json');
check('GET 靜態檔不需自訂標頭', checkRequest({ url: '/', method: 'GET', headers: { host: `127.0.0.1:${P}` } }, P) === null);
let t = 0;
const rl = createRateLimit(2, () => t);
check('每分鐘上限', rl() && rl() && !rl());
t = 61_000;
check('過一分鐘恢復', rl());

// ── claude-cli ──
const args = buildArgs({ model: 'haiku', system: 'SYS' });
check('工具全關、不載自訂設定', args.includes('--tools') && args[args.indexOf('--tools') + 1] === ''
  && ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'].every(f => args.includes(f)));
check('問題不放命令列（system 只帶規則）', !args.join(' ').includes('問題'));
const env = cleanEnv({ PATH: 'x', ANTHROPIC_FOO: 'a', CLAUDECODE: '1', CLAUDE_CODE_BAR: 'b', CLAUDE_OTHER: 'keep' });
check('環境變數拿掉 ANTHROPIC_*、CLAUDECODE、CLAUDE_CODE_*', JSON.stringify(Object.keys(env).sort()) === JSON.stringify(['CLAUDE_OTHER', 'PATH']));
check('登入錯誤轉白話', /claude auth login/.test(explainError('Failed to authenticate: OAuth session expired')));

function fakeSpawn(behavior) {
  const calls = [];
  const spawn = (exe, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = { on() {}, end(s) { input = s; calls.push({ exe, argv, opts, input }); behavior(child, input); } };
    child.kill = () => { calls.at(-1).killed = true; };
    return child;
  };
  return { spawn, calls };
}
{
  const { spawn, calls } = fakeSpawn((child) => setTimeout(() => {
    child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: '答案 [1]' }));
    child.emit('close', 0);
  }, 5));
  const cli = createClaudeCli({ exe: 'X', spawn });
  const out = await cli.generate({ system: 'S', messages: [{ role: 'user', content: '<問題>Q</問題>' }] });
  check('成功時回傳 result 文字', out === '答案 [1]');
  check('問題走 stdin', calls[0].input === '<問題>Q</問題>');
  check('不經 shell、cwd 是暫存資料夾', calls[0].opts.shell === false && /sop-desk-/.test(calls[0].opts.cwd));
}
{
  const { spawn } = fakeSpawn((child) => setTimeout(() => {
    child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: true, result: 'Failed to authenticate' }));
    child.emit('close', 1);
  }, 5));
  let msg = '';
  try { await createClaudeCli({ exe: 'X', spawn }).generate({ system: 'S', messages: [] }); } catch (e) { msg = e.message; }
  check('CLI 回錯誤 → 丟出白話訊息', /claude auth login/.test(msg));
}
{
  const { spawn, calls } = fakeSpawn(() => { /* 永遠不回 */ });
  let code = '';
  try { await createClaudeCli({ exe: 'X', spawn, timeoutMs: 30 }).generate({ system: 'S', messages: [] }); } catch (e) { code = e.code; }
  check('逾時 → 殺掉子程序、丟 TIMEOUT', code === 'TIMEOUT' && calls[0].killed === true);
}

// ── 資料轉換 ──
const H = (id, title, c = 0.7) => ({ id, content: `【1150101${title}V1.0】(測試部SOP)\n內容${id}`, header: parseHeader(`【1150101${title}V1.0】(測試部SOP)`), cosine: c });
const hits = [H(1, '測試部-甲'), H(2, '測試部-甲'), H(3, '測試部-乙'), H(4, '測試部-丙')];
const dto = hitsToDto(hits);
check('段落編上文件編號（同文件同號）', dto.map(h => h.docN).join() === '1,1,2,3');
const sp = splitAnswer('文件問答\n1. 甲 [1]\n2. 丙 [2]\n\n出處\n[1] x\n[2] y\n內容以原檔為準', [1, 3], dto);
check('答案拆出正文', sp.body === '1. 甲 [1]\n2. 丙 [2]');
check('出處 [2] 對到原本第 3 份文件的段落', sp.sources[1].n === 2 && sp.sources[1].title === '測試部-丙' && sp.sources[1].hitIds.join() === '4');

// ── 伺服器 ──
let mode = 'ok';
const retriever = {
  size: 4, meta: { exported_at: '2026-11-28T00:00:00Z' }, disabledReason: '', maybeReload() {},
  search: async () => (mode === 'nf' ? { status: 'not_found', topCosine: 0.5, nearest: [H(9, '測試部-丁', 0.5)] } : { status: 'ok', topCosine: 0.7, hits }),
};
let llmReply = async () => '1. 甲 [1]';
const llm = { model: 'haiku', available: () => true, generate: (...a) => llmReply(...a) };
const history = openHistory(':memory:');
const server = http.createServer(createApp({ retriever, llm, history, port: 0, ollamaUrl: 'http://127.0.0.1:1', perMinute: 100 }));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
// createApp 用 port 驗 Host：測試伺服器另外建一個綁真實 port 的
server.close();
const app = createApp({ retriever, llm, history, port, ollamaUrl: 'http://127.0.0.1:1', perMinute: 100 });
const srv = http.createServer(app);
await new Promise(r => srv.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${port}`;
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sop-Desk': '1', ...headers }, body: JSON.stringify(body) });

const health = await (await fetch(`${base}/api/health`)).json();
check('health 回知識庫段數、Ollama 狀態', health.kb.count === 4 && health.ollama === false && health.claude.available === true);
{
  const sp2 = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    setTimeout(() => { child.stdout.emit('data', '{"loggedIn": false}'); child.emit('close', 0); }, 5);
    child.kill = () => {};
    return child;
  };
  const st = await createClaudeCli({ exe: process.execPath, spawn: sp2 }).status();
  check('登入狀態：auth status 回 loggedIn=false 就標沒登入', st.available === true && st.loggedIn === false);
}

const s = await (await post('/api/search', { q: 'SQL 怎麼防' })).json();
check('search 回 4 段、帶文件編號', s.status === 'ok' && s.hits.length === 4 && s.hits[2].docN === 2);
check('問題太短回 400', (await post('/api/search', { q: '問' })).status === 400);
check('沒帶自訂標頭回 403', (await fetch(`${base}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"q":"SQL 怎麼防"}' })).status === 403);

const a = await (await post('/api/answer', { q: 'SQL 怎麼防' })).json();
check('answer 回正文與出處', a.status === 'answered' && a.answer === '1. 甲 [1]' && a.sources[0].hitIds.join() === '1,2');

const raw = await (await post('/api/answer', { q: 'SQL 怎麼防', raw: true })).json();
check('只看原文不叫模型', raw.status === 'raw' && raw.hits.length === 4);

mode = 'nf';
const nf = await (await post('/api/answer', { q: '年終獎金怎麼算' })).json();
check('找不到回最接近段落', nf.status === 'not_found' && nf.nearest.length === 1 && nf.nearest[0].title === '測試部-丁');
mode = 'ok';

llmReply = async () => { throw Object.assign(new Error('Claude 回答逾時（60 秒）'), { code: 'TIMEOUT' }); };
const to = await (await post('/api/answer', { q: 'SQL 怎麼防' })).json();
check('逾時仍回原文段落', to.status === 'error' && to.errorKind === 'timeout' && to.hits.length === 4);

let release;
llmReply = () => new Promise(r => { release = () => r('1. 甲 [1]'); });
const first = post('/api/answer', { q: 'SQL 怎麼防' });
await new Promise(r => setTimeout(r, 30));
const second = await post('/api/answer', { q: '第二題問問看' });
check('整理中再問第二題 → 409', second.status === 409);
release();
check('第一題照常完成', (await (await first).json()).status === 'answered');

const list = (await (await fetch(`${base}/api/history`)).json()).items;
check('歷史有記錄（含找不到、原文、錯誤）', list.length === 5 && list.some(i => i.status === 'raw') && list.some(i => i.status === 'error'));
const one = await (await fetch(`${base}/api/history/${list[0].id}`)).json();
check('單筆歷史可重看（含段落）', one.question === 'SQL 怎麼防' && Array.isArray(one.hits));
const del = await fetch(`${base}/api/history/${list[0].id}`, { method: 'DELETE', headers: { 'X-Sop-Desk': '1' } });
check('刪除單筆', (await del.json()).ok === true && (await (await fetch(`${base}/api/history`)).json()).items.length === 4);
check('DELETE 沒帶自訂標頭回 403', (await fetch(`${base}/api/history/1`, { method: 'DELETE' })).status === 403);

const trav = await fetch(`${base}/..%2f..%2fpackage.json`);
check('靜態檔不能跳出 public 資料夾', trav.status === 404);
const idx = await fetch(`${base}/`);
check('首頁有 CSP 標頭', idx.headers.get('content-security-policy')?.includes("script-src 'self'"));

srv.close();
history.close();
console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
