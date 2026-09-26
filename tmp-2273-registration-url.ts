import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  if (!context) throw new Error('No browser context');

  const page = await context.newPage();

  try {
    const response = await page.goto(
      'https://codeforces.com/contestRegistration/2273',
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }
    );

    console.log('HTTP STATUS:', response?.status());
    console.log('FINAL URL:', page.url());
    console.log('TITLE:', await page.title());

    const body = (await page.locator('body').innerText())
      .replace(/\s+/g, ' ')
      .trim();

    console.log('BODY:', body.slice(0, 5000));
  } finally {
    await page.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
