/**
 * Plugin Loader
 *
 * 掃描 plugins/ 目錄，載入每個 plugin 的 index.js。
 * Plugin 必須 export default:
 *   {
 *     name: string,
 *     prefix?: string,           // 可選：指令前綴（如 'todo'）
 *     defaultCommand?: string,   // 可選：裸 /<prefix> 時觸發的 command name
 *     scope?: 'all'|'private'|'group',  // 可選：plugin 層級預設場景
 *     commands: [{
 *       name: string,
 *       command?: string,        // prefix 模式：動作名（如 'add' → /todo_add）
 *       pattern: RegExp,         // prefix 模式：只比對參數部分
 *       handler: fn,
 *       type: 'action'|'query',
 *       scope?: 'all'|'private'|'group',  // 可選：覆蓋 plugin 層級
 *     }],
 *     schedules: [{ name: string, cron: string, handler: fn }],
 *     init?: async (ctx) => void,
 *   }
 *
 * 前綴模式（prefix + command）：
 *   每個 command 宣告 command 欄位，框架自動組合為 /<prefix>_<command> 指令。
 *   pattern 只需比對參數部分（不含指令本身）。
 *   例：prefix='todo', command='add', pattern=/^(.+)/ → 匹配 "/todo_add 買牛奶"
 *   例：prefix='todo', command='done', pattern=/^(\d+)$/ → 匹配 "/todo_done 1"
 *   裸 /<prefix>（如 /todo）觸發 defaultCommand。
 *   不設 prefix 的 plugin 行為不變（向後相容）。
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';

/**
 * 為 prefix 模式建立完整 pattern
 * prefix='todo', command='add', argsPattern=/^(.+)/ → /^\/todo_add\s+(.+)$/
 * prefix='todo', command='list', argsPattern=null    → /^\/todo_list$/
 */
function buildPrefixedPattern(prefix, command, argsPattern) {
  const slug = `${prefix}_${command}`;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (!argsPattern) {
    return new RegExp(`^\\/${escaped}$`, 'i');
  }

  let src = argsPattern.source;
  const flags = argsPattern.flags;

  // 移除 ^ $ 錨點（由外層提供）
  if (src.startsWith('^')) src = src.slice(1);
  if (src.endsWith('$')) src = src.slice(0, -1);

  return new RegExp(`^\\/${escaped}\\s+${src}$`, flags);
}

export async function loadPlugins(pluginsDir, { router, scheduler, lineApi, providers, enabledList }) {
  const loaded = [];

  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[plugin-loader] cannot read plugins dir: ${err.message}`);
    return loaded;
  }

  const dirs = entries.filter(e => e.isDirectory());

  for (const dir of dirs) {
    const pluginName = dir.name;

    // 若有 enabledList，只載入白名單內的 plugin
    if (enabledList?.length > 0 && !enabledList.includes(pluginName)) {
      console.log(`[plugin-loader] skipped (not enabled): ${pluginName}`);
      continue;
    }

    const indexPath = join(pluginsDir, pluginName, 'index.js');

    try {
      const moduleURL = pathToFileURL(indexPath).href;
      const mod = await import(moduleURL);
      const plugin = mod.default || mod;

      if (!plugin.name) {
        console.warn(`[plugin-loader] ${pluginName}/index.js missing "name", skipped`);
        continue;
      }

      // 註冊 commands → router
      if (plugin.commands) {
        const prefix = plugin.prefix || null;

        for (const cmd of plugin.commands) {
          let pattern;

          if (prefix && cmd.command) {
            // prefix 模式：/<prefix>_<command> <args>
            pattern = buildPrefixedPattern(prefix, cmd.command, cmd.pattern);
          } else {
            // 傳統模式：直接用 plugin 定義的 pattern
            pattern = cmd.pattern;
          }

          router.add(pattern, cmd.handler, {
            type: cmd.type || 'query',
            name: cmd.name || `${prefix}_${cmd.command}`,
            plugin: plugin.name,
            describe: cmd.describe || '',
            scope: cmd.scope || plugin.scope || 'all',
          });
        }

        // prefix 模式：裸 /<prefix> 觸發 defaultCommand
        if (prefix && plugin.defaultCommand) {
          const defaultCmd = plugin.commands.find(c => c.name === plugin.defaultCommand);
          if (defaultCmd) {
            const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            router.add(new RegExp(`^\\/${escaped}$`, 'i'), defaultCmd.handler, {
              type: defaultCmd.type || 'query',
              name: `${plugin.defaultCommand} (default)`,
              plugin: plugin.name,
              describe: defaultCmd.describe || '',
              scope: defaultCmd.scope || plugin.scope || 'all',
            });
          }
        }
      }

      // 註冊 schedules → scheduler
      if (plugin.schedules) {
        for (const sched of plugin.schedules) {
          scheduler.add(sched.name, sched.cron, sched.handler, {
            plugin: plugin.name,
            timezone: sched.timezone,
            describe: sched.describe || '',
            pushTo: sched.pushTo || [],
          });
        }
      }

      // 提供 providers 給 plugin
      const dbProvider = providers?.get('db');
      const db = dbProvider ? dbProvider.getDatabase(plugin.name) : null;

      // 呼叫 init hook（傳入所有 providers）
      if (plugin.init) {
        await plugin.init({
          lineApi, router, scheduler,
          db,                              // 向後相容：直接拿 db
          providers: providers?.getAll(),  // 完整 providers（llm, cache, ...）
        });
      }

      loaded.push(plugin.name);
      console.log(`[plugin-loader] loaded: ${plugin.name} (${plugin.commands?.length || 0} cmds, ${plugin.schedules?.length || 0} schedules)`);
    } catch (err) {
      console.error(`[plugin-loader] failed to load ${pluginName}: ${err.message}`);
    }
  }

  // ── 內建指令：/help ──────────────────────────────────
  router.add(/^\/help$/i, async () => {
    const allRoutes = router.list()
      .filter(r => r.describe && r.plugin !== '_system');

    if (!allRoutes.length) return '📖 目前沒有已註冊的指令說明';

    // 依 plugin 分群，去除重複 describe
    const grouped = {};
    for (const r of allRoutes) {
      if (!grouped[r.plugin]) grouped[r.plugin] = new Set();
      grouped[r.plugin].add(r.describe);
    }

    const sections = Object.entries(grouped).map(
      ([plugin, descs]) => `【${plugin}】\n${[...descs].join('\n')}`
    );

    return `📖 可用指令\n\n${sections.join('\n\n')}\n\n輸入 /help 隨時查看`;
  }, {
    type: 'query',
    name: 'help',
    plugin: '_system',
  });

  return loaded;
}
