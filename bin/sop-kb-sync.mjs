#!/usr/bin/env node
/**
 * 匯出公司文件知識庫並同步到 Mac mini（Windows 上跑，/sop ingest 匯入新文件後的最後一步）
 *
 *   node bin/sop-kb-sync.mjs [--dry-run] [--ack-pii]
 *
 * 個資樣式掃描有命中時預設中止，不上傳；人工看過那幾段、確認可以公開給部門後，加 --ack-pii 才上傳。
 *
 * 流程：匯出到本機 data/kb/sop-kb.db（含自我檢查）→ scp 成遠端 .tmp → 遠端 mv 原子替換。
 * bot 下次被問時發現檔案換了會自動重載並重跑探針自檢，不用重啟服務。
 */

import { spawnSync } from 'child_process';
import { exportKb, DEFAULT_OUT } from './sop-kb-export.mjs';

const HOST = process.env.SOP_SYNC_HOST || 'macmini';
const REMOTE_DIR = '~/linebot-framework/data/kb';
const dryRun = process.argv.includes('--dry-run');
const ackPii = process.argv.includes('--ack-pii');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} 失敗（exit ${r.status}）`);
}

try {
  const res = await exportKb({ out: DEFAULT_OUT });
  console.log(`匯出 ${res.count} 段：${Object.entries(res.byScope).map(([k, v]) => `${k} ${v}`).join('、')}；排除 ${res.excluded} 段`);
  if (res.pii.length) console.log(`個資樣式 ${res.pii.length} 段（id：${res.pii.map(p => p.id).join(', ')}），請人工確認`);
  if (res.pii.length && !ackPii && !dryRun) {
    console.error('有個資樣式的段落，已中止上傳。人工確認可公開後加 --ack-pii 重跑。');
    process.exit(2);
  }
  if (dryRun) {
    console.log('dry-run：不上傳');
    process.exit(0);
  }
  run('ssh', [HOST, `mkdir -p ${REMOTE_DIR}`]);
  run('scp', ['-q', DEFAULT_OUT, `${HOST}:${REMOTE_DIR}/sop-kb.db.tmp`]);
  run('ssh', [HOST, `mv -f ${REMOTE_DIR}/sop-kb.db.tmp ${REMOTE_DIR}/sop-kb.db && ls -l ${REMOTE_DIR}/sop-kb.db`]);
  console.log(`已同步到 ${HOST}`);
} catch (err) {
  console.error(`同步失敗：${err.message}`);
  process.exit(1);
}
