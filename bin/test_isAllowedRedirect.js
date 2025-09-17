#!/usr/bin/env node
const { isAllowedRedirect } = require('../lib/redirect');

const cases = [
  ['https://chatgpt.com/aip/api/callback', true],
  ['https://chat.openai.com/aip/api/callback?x=1', true],
  ['https://chatgpt.com/aip/g-abc123/oauth/callback', true],
  ['https://chatgpt.com/aip/g-xyz/oauth/callback?state=abc', true],
  ['https://chatgpt.com/aip/g-/oauth/callback', false],
  ['https://chatgpt.com/aip/g-abc/oauth/callback/extra', false],
  ['https://example.com/aip/api/callback', false],
  ['notaurl', false],
];

let failed = 0;
for (const [url, expected] of cases) {
  const actual = isAllowedRedirect(url);
  if (actual !== expected) {
    console.error(`FAIL: isAllowedRedirect(${url}) => ${actual}, expected ${expected}`);
    failed++;
  }
}

if (failed === 0) {
  console.log('All isAllowedRedirect tests passed.');
  process.exit(0);
} else {
  console.error(`${failed} tests failed.`);
  process.exit(1);
}
