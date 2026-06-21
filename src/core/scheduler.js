/**
 * 排程管理器（Hybrid 模式）
 *
 * 1. 內建 node-cron：Plugin 透過 schedules[] 定義 cron expression
 * 2. HTTP trigger：外部 cron（launchd/systemd）透過 POST /api/cron/:jobName 觸發
 */

import cron from 'node-cron';

export function createScheduler({ lineApi }) {
  const jobs = new Map();  // name → { task, schedule, handler, plugin }

  /**
   * 註冊排程任務
   * @param {string} name - 任務名稱（唯一）
   * @param {string} schedule - cron expression（如 '0 8 * * *'）
   * @param {Function} handler - async (ctx) => void
   * @param {Object} opts - { plugin, timezone }
   */
  function add(name, schedule, handler, opts = {}) {
    if (jobs.has(name)) {
      console.warn(`[scheduler] job "${name}" already exists, replacing`);
      jobs.get(name).task?.stop();
    }

    // 無效 cron（如 dow 欄為空的 '20 7 * * '）先擋下，避免 cron.schedule 拋例外中斷整批註冊
    if (!cron.validate(schedule)) {
      console.error(`[scheduler] invalid cron expression for "${name}": "${schedule}" — 跳過註冊`);
      return false;
    }

    let task;
    try {
      task = cron.schedule(schedule, async () => {
        const job = jobs.get(name);
        if (job && !job.enabled) {
          console.log(`[scheduler] skipped (disabled): ${name}`);
          return;
        }
        console.log(`[scheduler] firing: ${name}`);
        try {
          await handler({ lineApi, jobName: name });
        } catch (err) {
          console.error(`[scheduler] error in "${name}": ${err.message}`);
        }
      }, {
        timezone: opts.timezone || 'Asia/Taipei',
      });
    } catch (err) {
      console.error(`[scheduler] failed to schedule "${name}" (${schedule}): ${err.message} — 跳過註冊`);
      return false;
    }

    jobs.set(name, {
      task,
      schedule,
      handler,
      plugin: opts.plugin || 'unknown',
      describe: opts.describe || '',
      pushTo: opts.pushTo || [],   // [{ type: 'user'|'group', id, label }]
      enabled: opts.enabled !== false, // 預設啟用
    });

    console.log(`[scheduler] registered: ${name} (${schedule})`);
    return true;
  }

  /**
   * 手動觸發（HTTP trigger 用）
   */
  async function trigger(name) {
    const job = jobs.get(name);
    if (!job) throw new Error(`job "${name}" not found`);

    console.log(`[scheduler] manual trigger: ${name}`);
    await job.handler({ lineApi, jobName: name });
  }

  /**
   * Express route handler for HTTP trigger
   * POST /api/cron/:jobName
   */
  function httpHandler(req, res) {
    const { jobName } = req.params;
    const job = jobs.get(jobName);
    if (!job) {
      return res.status(404).json({ error: `job "${jobName}" not found` });
    }

    // 非同步執行，不阻塞回應
    trigger(jobName).catch(err => {
      console.error(`[scheduler] http trigger error: ${err.message}`);
    });

    res.json({ ok: true, job: jobName, triggered: new Date().toISOString() });
  }

  function list() {
    return Array.from(jobs.entries()).map(([name, job]) => ({
      name,
      schedule: job.schedule,
      plugin: job.plugin,
      describe: job.describe || '',
      pushTo: job.pushTo || [],
      enabled: job.enabled,
    }));
  }

  /**
   * 開關排程（runtime toggle，不影響 cron task 本身，只控制是否執行 handler）
   */
  function setEnabled(name, enabled) {
    const job = jobs.get(name);
    if (!job) throw new Error(`job "${name}" not found`);
    job.enabled = !!enabled;
    console.log(`[scheduler] ${name} → ${job.enabled ? 'enabled' : 'disabled'}`);
    return job.enabled;
  }

  /**
   * 動態新增 cron 排程（runtime 使用，如 plugin handler 中新增）
   * 與 add() 相同，但語意上用於 runtime 動態建立
   */
  function addDynamic(name, schedule, handler, opts = {}) {
    return add(name, schedule, handler, opts);
  }

  /**
   * 一次性排程：在指定時間觸發一次後自動移除
   * @param {string} name - 任務名稱（唯一）
   * @param {Date|string|number} datetime - 觸發時間（Date 物件、ISO 字串、timestamp）
   * @param {Function} handler - async (ctx) => void
   * @param {Object} opts - { plugin }
   */
  function addOnce(name, datetime, handler, opts = {}) {
    const targetTime = new Date(datetime).getTime();
    const now = Date.now();
    const delay = targetTime - now;

    if (delay <= 0) {
      console.warn(`[scheduler] once "${name}" is in the past, firing immediately`);
      handler({ lineApi, jobName: name }).catch(err => {
        console.error(`[scheduler] once error in "${name}": ${err.message}`);
      });
      return;
    }

    // setTimeout 的 delay 是 32-bit 有號整數，上限約 24.8 天；超過會溢位取模導致幾乎立即誤觸發。
    // 對長延遲分段：先睡到上限再重算剩餘時間續排，直到剩餘落在安全範圍內才真正觸發。
    const MAX_DELAY = 2147483647;
    let timer = null;

    const fire = async () => {
      console.log(`[scheduler] firing once: ${name}`);
      try {
        await handler({ lineApi, jobName: name });
      } catch (err) {
        console.error(`[scheduler] once error in "${name}": ${err.message}`);
      }
      jobs.delete(name);
    };
    const arm = () => {
      const remaining = targetTime - Date.now();
      timer = remaining > MAX_DELAY
        ? setTimeout(arm, MAX_DELAY)
        : setTimeout(fire, Math.max(0, remaining));
    };
    arm();

    // 存入 jobs（stop/list 時可管理）；timer 由 arm() 動態更新，stop 永遠清掉當前 timer
    jobs.set(name, {
      task: { stop: () => clearTimeout(timer) },
      schedule: `once@${new Date(targetTime).toISOString()}`,
      handler,
      plugin: opts.plugin || 'dynamic',
    });

    console.log(`[scheduler] once registered: ${name} → ${new Date(targetTime).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  }

  function stop(name) {
    const job = jobs.get(name);
    if (job) {
      job.task?.stop();
      jobs.delete(name);
    }
  }

  function stopAll() {
    for (const [name, job] of jobs) {
      job.task?.stop();
    }
    jobs.clear();
  }

  return { add, addDynamic, addOnce, trigger, httpHandler, list, setEnabled, stop, stopAll };
}
