/**
 * sop 檢索模組測試：標題解析（含巢狀【】）、同文件上限、找不到門檻、索引段標記、
 * 匯出檔混進其他分類就停用、探針自檢、檔案替換後自動重載
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRetriever, parseHeader, vecToBlob } from '../plugins/sop/retriever.js';

let fail = 0;
function check(label, cond) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fail++;
}

// ── 標題解析 ──
{
  const h = parseHeader('【1150511某公司-丙對照表(甲系統(ABC))【系】V23.0】(測試部｜管理性文件)\n內文');
  check('巢狀【】標題：檔名完整', h.title === '某公司-丙對照表(甲系統(ABC))【系】');
  check('巢狀【】標題：版次 V23.0', h.version === 'V23.0');
  check('巢狀【】標題：日期 115/05/11', h.date === '115/05/11');
  check('巢狀【】標題：分類', h.category === '測試部｜管理性文件');
  const idx = parseHeader('【1130125測試部-丁查檢表(英文名)V3.0】(測試部｜工作文件範本｜索引)');
  check('索引段標記', idx.isIndex === true);
  const nov = parseHeader('【1080925測試部-沒有版次的文件】(測試部SOP)');
  check('沒有版次就留空', nov.version === '' && nov.title === '測試部-沒有版次的文件');
  const raw = parseHeader('沒有標題列的段落');
  check('沒有標題列不丟例外', typeof raw.title === 'string' && raw.isIndex === false);
}

// ── 夾具資料庫 ──
const dir = mkdtempSync(join(tmpdir(), 'sop-ret-'));
function makeDb(path, rows, extraScope) {
  const db = new Database(path);
  db.exec('CREATE TABLE chunks (id INTEGER PRIMARY KEY, scope TEXT, content TEXT, vec BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const ins = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
  rows.forEach(r => ins.run(r.id, extraScope && r.id === 99 ? extraScope : r.scope, r.content, vecToBlob(r.vec)));
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('probe_text', '探針');
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('probe_vec', JSON.stringify([0, 0, 0, 1]));
  db.close();
}
const docA = '【1150911測試部-甲指導書V11.0】(測試部SOP)\n';
const docB = '【1150319測試部-乙準則V2.0】(測試部SOP)\n';
const rows = [
  { id: 1, scope: 'skill:rag', content: docA + 'SQL 注入 參數化查詢 一', vec: [1, 0, 0, 0] },
  { id: 2, scope: 'skill:rag', content: docA + 'SQL 注入 二', vec: [0.98, 0.2, 0, 0] },
  { id: 3, scope: 'skill:rag', content: docA + 'SQL 注入 三', vec: [0.97, 0.24, 0, 0] },
  { id: 4, scope: 'skill:rag', content: docA + 'SQL 注入 四', vec: [0.96, 0.28, 0, 0] },
  { id: 5, scope: 'skill:km', content: docB + '參數化查詢', vec: [0.9, 0.4, 0, 0] },
  { id: 6, scope: 'skill:km', content: '【1130125測試部-丙辦法V3.0】(測試部｜程序書)\n請假', vec: [0, 1, 0, 0] },
  { id: 99, scope: 'skill:km', content: '【1130125測試部-其他V1.0】(測試部｜程序書)\n其他', vec: [0, 0, 1, 0] },
];
const kb = join(dir, 'sop-kb.db');
makeDb(kb, rows);

// 假的 embed：字串對應固定向量
const VEC = {
  'SQL 注入怎麼防': [1, 0.05, 0, 0],
  '今天天氣如何': [0, 0, -1, 1], // 跟每段都不像（餘弦 ≤ 0）
  '探針': [0, 0, 0, 1],
};
const embed = async t => VEC[t] || [0.3, 0.3, 0.3, 0.3];

const r = createRetriever({ dbPath: kb, embed, minCosine: 0.6, topK: 6, perDoc: 3 });
check('載入成功', r.load() === true && r.size === 7);

const res = await r.search('SQL 注入怎麼防');
check('有答案：status ok', res.status === 'ok');
check('有答案：第一名是漏洞處理指導書', res.hits[0]?.header.title === '測試部-甲指導書');
const aCount = res.hits.filter(h => h.header.docName === '測試部-甲指導書').length;
check('同一份文件最多 3 段', aCount === 3);
check('第二份文件也排得進來', res.hits.some(h => h.id === 5));

check('太不像的段落（請假、餘弦 0.05）不送進 prompt', !res.hits.some(h => h.id === 6));

const nf = await r.search('今天天氣如何');
check('沒答案：低於門檻回 not_found', nf.status === 'not_found' && nf.topCosine < 0.6);
check('找不到時附最接近的段落，每份文件一段、最多 3 段', Array.isArray(nf.nearest) && nf.nearest.length === 3
  && new Set(nf.nearest.map(h => h.header.docName)).size === 3);

const sc = await r.selfCheck();
check('探針自檢一致就通過', sc.ok === true);
const r2 = createRetriever({ dbPath: kb, embed: async () => [1, 0, 0, 0] });
r2.load();
const sc2 = await r2.selfCheck();
check('向量模型不一致就不通過', sc2.ok === false && /不一致/.test(sc2.reason));

// ── 混進其他分類就整個停用 ──
const kbBad = join(dir, 'bad.db');
makeDb(kbBad, rows, 'global');
const rb = createRetriever({ dbPath: kbBad, embed });
check('含 global 分類：拒絕載入', rb.load() === false && /不允許的分類/.test(rb.disabledReason));
const rbRes = await rb.search('SQL 注入怎麼防');
check('含 global 分類：搜尋回 disabled', rbRes.status === 'disabled');

// ── 找不到檔案 ──
const rm = createRetriever({ dbPath: join(dir, 'nope.db'), embed });
check('沒有檔案：不丟例外', rm.load() === false);
check('沒有檔案：搜尋回 disabled', (await rm.search('x')).status === 'disabled');

// ── 檔案替換後自動重載 ──
const next = join(dir, 'next.db');
makeDb(next, rows.slice(0, 2));
await new Promise(res => setTimeout(res, 20));
renameSync(next, kb);
await r.search('SQL 注入怎麼防');
check('原子替換後自動重載', r.size === 2);

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
