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

    const task = cron.schedule(schedule, async () => {
      console.log(`[scheduler] firing: ${name}`);
      try {
        await handler({ lineApi, jobName: name });
      } catch (err) {
        console.error(`[scheduler] error in "${name}": ${err.message}`);
      }
    }, {
      timezone: opts.timezone || 'Asia/Taipei',
    });

    jobs.set(name, {
      task,
      schedule,
      handler,
      plugin: opts.plugin || 'unknown',
    });

    console.log(`[scheduler] registered: ${name} (${schedule})`);
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
    }));
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

    const timer = setTimeout(async () => {
      console.log(`[scheduler] firing once: ${name}`);
      try {
        await handler({ lineApi, jobName: name });
      } catch (err) {
        console.error(`[scheduler] once error in "${name}": ${err.message}`);
      }
      jobs.delete(name);
    }, delay);

    // 存入 jobs（stop/list 時可管理）
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

  return { add, addDynamic, addOnce, trigger, httpHandler, list, stop, stopAll };
}
