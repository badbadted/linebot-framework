/**
 * 抓「使用者給的網址」專用（防 SSRF）：bot 跑在家裡的 Mac mini，群組成員貼的網址不能讓 bot 去讀內網
 * （Luna、Home Assistant、路由器…）再把內容帶回群組。
 *
 * - 只收 http／https、預設埠（80／443）
 * - 每一跳轉址都自己處理（redirect: 'manual'），每一跳都先查 DNS，任何一個解析結果是內網／本機／保留位址就拒絕
 * - 回應最多讀 maxBytes，逾時中止
 *
 * 已知限制：查 DNS 與實際連線之間有時間差（DNS rebinding），這裡是降低風險不是根絕；
 * 真正要抓的都是公開社群網站，被針對的機會低。
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4num = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);

export function isBlockedIp(ip) {
  if (isIP(ip) === 4) {
    const n = v4num(ip);
    return BLOCKED_V4.some(([base, bits]) => {
      const size = 2 ** (32 - bits);
      const b = v4num(base);
      return n >= b && n < b + size;
    });
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return s === '::' || s === '::1'
      || /^f[cd]/.test(s)            // fc00::/7 唯一本地
      || /^fe[89ab]/.test(s)         // fe80::/10 鏈路本地
      || /^ff/.test(s)               // 多播
      || s.startsWith('64:ff9b:')    // NAT64
      || s.startsWith('2001:db8:');  // 文件用
  }
  return true; // 不是合法 IP 一律擋
}

async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('網址格式不對'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只接受 http／https 網址');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('不接受指定連接埠的網址');
  if (u.username || u.password) throw new Error('不接受帶帳密的網址');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isBlockedIp(a.address))) throw new Error('不接受內網或保留位址');
  return u;
}

async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

/**
 * @returns {Promise<{ finalUrl: string, status: number, text: string }>}
 */
export async function safeFetch(url, { headers = {}, timeoutMs = 8000, maxBytes = 1_500_000, maxRedirects = 5 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const u = await checkUrl(current);
      const res = await fetch(u, { redirect: 'manual', headers, signal: ctrl.signal });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel().catch(() => {});
        current = new URL(loc, u).toString();
        continue;
      }
      return { finalUrl: u.toString(), status: res.status, text: await readCapped(res, maxBytes) };
    }
    throw new Error('轉址次數太多');
  } finally {
    clearTimeout(timer);
  }
}
