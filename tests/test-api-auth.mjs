/**
 * API Auth + Logger PII masking 測試
 */

import express from 'express';
import { createApiAuth, maskUserId } from '../src/core/api-auth.js';

console.log('=== API Auth 測試 ===\n');

// 1. maskUserId 測試
console.log('--- maskUserId ---');
console.log(`'U1234567890abcdef' → '${maskUserId('U1234567890abcdef')}'`);
console.log(`'U12345'            → '${maskUserId('U12345')}'`);
console.log(`null                → '${maskUserId(null)}'`);
console.log(`''                  → '${maskUserId('')}'`);

// 2. API Key 模式
console.log('\n--- API Key auth ---');
const auth = createApiAuth({ apiKey: 'test-secret-123' });

function mockReq(ip, headers = {}, query = {}) {
  return { ip, headers, query, path: '/api/test' };
}
function mockRes() {
  let statusCode;
  return {
    status(code) { statusCode = code; return this; },
    json(body) { return { statusCode, body }; },
    get statusCode() { return statusCode; },
  };
}

// 正確 API Key → 通過
let passed = false;
auth(
  mockReq('1.2.3.4', { 'x-api-key': 'test-secret-123' }),
  mockRes(),
  () => { passed = true; }
);
console.log(`✓ 正確 API Key: ${passed ? 'PASS' : 'FAIL'}`);

// 錯誤 API Key → 被擋
passed = false;
const res1 = mockRes();
auth(
  mockReq('1.2.3.4', { 'x-api-key': 'wrong-key' }),
  res1,
  () => { passed = true; }
);
console.log(`✓ 錯誤 API Key: ${!passed && res1.statusCode === 403 ? 'BLOCKED (403)' : 'FAIL'}`);

// localhost → 通過（即使沒 API Key）
passed = false;
auth(
  mockReq('127.0.0.1', {}),
  mockRes(),
  () => { passed = true; }
);
console.log(`✓ localhost 無 Key: ${passed ? 'PASS (localhost allowed)' : 'FAIL'}`);

// 外部 IP 無 Key → 被擋
passed = false;
const res2 = mockRes();
auth(
  mockReq('203.0.113.50', {}),
  res2,
  () => { passed = true; }
);
console.log(`✓ 外部 IP 無 Key: ${!passed && res2.statusCode === 403 ? 'BLOCKED (403)' : 'FAIL'}`);

// query param API Key → 通過
passed = false;
auth(
  mockReq('1.2.3.4', {}, { apiKey: 'test-secret-123' }),
  mockRes(),
  () => { passed = true; }
);
console.log(`✓ Query param Key: ${passed ? 'PASS' : 'FAIL'}`);

console.log('\n✓ 測試完成');
