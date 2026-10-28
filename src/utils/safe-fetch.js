/**
 * 抓「使用者給的網址」專用（防 SSRF）：bot 跑在家裡的 Mac mini，群組成員貼的網址不能讓 bot 去讀內網
 * （Luna、Home Assistant、路由器…）再把內容帶回群組。
 *
 * - 只收 http／https、預設埠（80／443）、不帶帳密
 * - 位址判斷用 net.BlockList（解析成數字比對；::ffff:7f00:1 這類 IPv4 映射寫法也認得）
 * - 連線用 http／https 模組＋自訂 lookup：查 DNS 的同時檢查每個結果，連線就用這次檢查過的位址，
 *   查完到連線之間沒有空檔可換位址（防 DNS rebinding）；網址直接寫 IP 的先檢查再連
 * - 每一跳轉址自己處理、重新檢查；回應最多讀 maxBytes，逾時中止
 */

import http from 'http';
import https from 'https';
import { lookup as dnsLookup } from 'dns';
import { BlockList, isIP } from 'net';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 96],          // 未指定、IPv4 相容（::a.b.c.d）
  ['::1', 128],        // 本機
  ['100::', 64],       // 丟棄
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64（可夾帶內網 IPv4）
  ['2001::', 23],      // IETF 保留（含 Teredo 2001::/32）
  ['2001:db8::', 32],  // 文件用
  ['2002::', 16],      // 6to4（可夾帶內網 IPv4）
  ['fc00::', 7],       // 唯一本地
  ['fe80::', 10],      // 鏈路本地
  ['ff00::', 8],       // 多播
]) blocked.addSubnet(net, bits, 'ipv6');

/** 內網／本機／保留位址回 true；不是合法 IP 也回 true。IPv4 映射的 IPv6（任何寫法）會套 IPv4 規則 */
export function isBlockedIp(ip) {
  const v = isIP(String(ip || ''));
  if (!v) return true;
  return blocked.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

// 給 http／https 用的 lookup：解析後每個位址都要合法，連線就用這裡回傳的位址
function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => isBlockedIp(a.address))) {
      return cb(Object.assign(new Error('不接受內網或保留位址'), { code: 'EBLOCKED' }));
    }
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('網址格式不對'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只接受 http／https 網址');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('不接受指定連接埠的網址');
  if (u.username || u.password) throw new Error('不接受帶帳密的網址');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedIp(host)) throw new Error('不接受內網或保留位址');
  return u;
}

function requestOnce(u, { headers, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', headers: { ...headers, 'Accept-Encoding': 'identity' }, lookup: guardedLookup, signal }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        return resolve({ status: res.statusCode, location: loc });
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        if (total >= maxBytes) return;
        const room = maxBytes - total;
        chunks.push(c.length > room ? c.subarray(0, room) : c);
        total += Math.min(c.length, room);
        if (total >= maxBytes) res.destroy(); // 夠了就斷線，不再收
      });
      const done = () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, text: buffer.toString('utf8'), buffer, contentType: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() });
      };
      res.on('end', done);
      res.on('close', done);
      res.on('error', (e) => (total >= maxBytes ? done() : reject(e)));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * @returns {Promise<{ finalUrl: string, status: number, text: string, buffer: Buffer, contentType: string }>}
 *   buffer／contentType：原始內容與類型（下載圖片用；text 是同一份內容當 UTF-8 讀）
 */
export async function safeFetch(url, { headers = {}, timeoutMs = 8000, maxBytes = 1_500_000, maxRedirects = 5 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const u = checkUrl(current);
      const r = await requestOnce(u, { headers, signal: ctrl.signal, maxBytes });
      if (r.location) { current = new URL(r.location, u).toString(); continue; }
      return { finalUrl: u.toString(), status: r.status, text: r.text, buffer: r.buffer, contentType: r.contentType };
    }
    throw new Error('轉址次數太多');
  } finally {
    clearTimeout(timer);
  }
}
