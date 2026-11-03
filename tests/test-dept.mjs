/**
 * Dept 派工單綁定測試：名單內的名字能綁（大小寫容錯、存標準寫法），名單外的擋掉
 */
const { default: plugin } = await import('../plugins/dept/index.js');

let fail = 0;
function check(label, cond) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) fail++;
}

// 假的 db：只記 run 的參數
const runs = [];
await plugin.init({ db: { exec() {}, run: (...args) => runs.push(args), get() {}, all: () => [] } });

const bind = plugin.commands.find(c => c.name === 'bind');
const call = (text, userId = 'U1') => bind.handler(bind.pattern.exec(text), { userId });

for (const name of ['Ken', 'Peter', 'Steven', 'Ida', 'Kacie', 'Hoho', 'Violet']) {
  runs.length = 0;
  const r = await call(`/派工單綁定 ${name}`);
  check(`${name} 可以綁定`, typeof r === 'object' && runs[0]?.[2] === name);
}

runs.length = 0;
await call('/派工單綁定 violet');
check('小寫 violet 存成 Violet', runs[0]?.[2] === 'Violet');

runs.length = 0;
const bad = await call('/派工單綁定 Nobody');
check('名單外的名字擋掉、列出可綁定名單', typeof bad === 'string' && bad.includes('Violet') && runs.length === 0);

check('使用說明列出 Violet', plugin.helpText.includes('Violet'));

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
