// Opt-in WalletConnect QR check against the configured local web app. No signing.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const url = process.env.BROWSER_TEST_URL || 'http://localhost:3015';
if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw Error('Local web app only');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: /WalletConnect/ }).first().click();
  await page.getByText('Scan with your phone', { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] svg')].some(svg =>
    svg.getBoundingClientRect().width >= 200 && svg.querySelectorAll('rect').length >= 6 && [...svg.querySelectorAll('path')].some(path => (path.getAttribute('d') || '').length > 1000)), null, { timeout: 30000 });
  assert.deepEqual(errors, []);
  // Do not persist QR/pairing secrets in committed artifacts or logs.
  if (process.env.QR_SCREENSHOT) await page.screenshot({ path: process.env.QR_SCREENSHOT });
  console.log(JSON.stringify({ walletConnectQrRendered: true, browserErrors: errors, phonePaired: false }));
} finally { await browser.close(); }
