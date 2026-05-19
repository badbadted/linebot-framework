/**
 * Plugin Loader
 *
 * 掃描 plugins/ 目錄，載入每個 plugin 的 index.js。
 * Plugin 必須 export default:
 *   {
 *     name: string,
 *     commands: [{ pattern: RegExp, handler: fn, type: 'action'|'query', name: string }],
 *     schedules: [{ name: string, cron: string, handler: fn }],
 *     init?: async (ctx) => void,   // 可選的初始化 hook
 *   }
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';

export async function loadPlugins(pluginsDir, { router, scheduler, lineApi, enabledList }) {
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
        for (const cmd of plugin.commands) {
          router.add(cmd.pattern, cmd.handler, {
            type: cmd.type || 'query',
            name: cmd.name || cmd.pattern.source,
            plugin: plugin.name,
          });
        }
      }

      // 註冊 schedules → scheduler
      if (plugin.schedules) {
        for (const sched of plugin.schedules) {
          scheduler.add(sched.name, sched.cron, sched.handler, {
            plugin: plugin.name,
            timezone: sched.timezone,
          });
        }
      }

      // 呼叫 init hook
      if (plugin.init) {
        await plugin.init({ lineApi, router, scheduler });
      }

      loaded.push(plugin.name);
      console.log(`[plugin-loader] loaded: ${plugin.name} (${plugin.commands?.length || 0} cmds, ${plugin.schedules?.length || 0} schedules)`);
    } catch (err) {
      console.error(`[plugin-loader] failed to load ${pluginName}: ${err.message}`);
    }
  }

  return loaded;
}
