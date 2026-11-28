/**
 * sop 知識庫匯出測試：個人記憶（global 等）絕不進匯出檔、只有兩個公司分類、筆數相符、
 * 沒向量或模型不同的段落不匯、個資掃描只回 id 與類型
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exportKb, scanPii } from '../bin/sop-kb-export.mjs';
import { createRetriever } from '../plugins/sop/retriever.js';

let fail = 0;
function check(label, cond) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fail++;
}

const CANARY = 'CANARY-家裡的鑰匙放在花盆下';
const dir = mkdtempSync(join(tmpdir(), 'sop-exp-'));
const src = join(dir, 'vector-memory.db');
const db = new Database(src);
db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT 'global', content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'fact', embedding TEXT, created_at TEXT, updated_at TEXT,
  source_trust TEXT NOT NULL DEFAULT 'ai_inferred', importance INTEGER NOT NULL DEFAULT 5, embed_model TEXT)`);
const ins = db.prepare('INSERT INTO memories (scope, content, embedding, embed_model) VALUES (?, ?, ?, ?)');
const v = JSON.stringify([1, 0, 0, 0]);
ins.run('global', CANARY, v, 'bge-m3');
ins.run('skill:pr', `${CANARY}-pr`, v, 'bge-m3');
ins.run('project:living-tv', `${CANARY}-proj`, v, 'bge-m3');
ins.run('skill:rag', '【1150911測試部-甲指導書V11.0】(測試部SOP)\n參數化查詢', v, 'bge-m3');
ins.run('skill:km', '【1130125測試部-丙辦法V3.0】(測試部｜程序書)\n聯絡電話 0912-345-678', v, 'bge-m3');
ins.run('skill:km', '【1150707測試部-聯絡名單V3.0】(測試部｜管理性文件)\nEXCLUDED-聯絡人', v, 'bge-m3');
ins.run('skill:km', '【1130125測試部-沒有向量V1.0】(測試部｜程序書)\n沒有向量', null, null);
ins.run('skill:km', '【1130125測試部-舊模型V1.0】(測試部｜程序書)\n舊模型', v, 'gemini');
db.close();

const out = join(dir, 'kb', 'sop-kb.db');
const res = await exportKb({ src, out, embed: async () => [0, 0, 0, 1], exclude: ['測試部-聯絡名單'] });

check('只匯出 2 段（rag 1、km 1）', res.count === 2 && res.byScope['skill:rag'] === 1 && res.byScope['skill:km'] === 1);
const raw = readFileSync(out);
check('排除清單的文件整份不匯出', res.excluded === 1 && !raw.includes(Buffer.from('EXCLUDED')));
check('匯出檔全文找不到個人記憶誘餌字串', !raw.includes(Buffer.from('CANARY')));
const o = new Database(out, { readonly: true });
const scopes = o.prepare('SELECT DISTINCT scope FROM chunks').all().map(r => r.scope).sort();
const meta = Object.fromEntries(o.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
o.close();
check('分類只有 skill:km、skill:rag', JSON.stringify(scopes) === JSON.stringify(['skill:km', 'skill:rag']));
check('meta 有探針與模型', meta.probe_text && meta.probe_vec && meta.embed_model === 'bge-m3' && meta.count === '2');
check('沒留下暫存檔', !existsSync(`${out}.export-tmp`));
check('個資掃描抓到手機、只回 id 與類型', res.pii.length === 1 && res.pii[0].types.includes('手機') && !('content' in res.pii[0]));

// 匯出檔能被檢索模組載入、自檢通過
const r = createRetriever({ dbPath: out, embed: async () => [0, 0, 0, 1] });
check('檢索模組能載入匯出檔', r.load() === true && r.size === 2);
check('探針自檢通過', (await r.selfCheck()).ok === true);

// 身分證檢查碼：A123456789 有效、A123456788 無效
check('身分證檢查碼成立才算', scanPii([{ id: 1, scope: 'skill:km', content: 'A123456789' }]).length === 1
  && scanPii([{ id: 2, scope: 'skill:km', content: 'A123456788' }]).length === 0);

// 來源不存在
let threw = false;
try { await exportKb({ src: join(dir, 'nope.db'), out, embed: async () => [1] }); } catch { threw = true; }
check('來源不存在就丟錯', threw);

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
