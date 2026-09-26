import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];

  if (!context) {
    throw new Error('No Chrome context found');
  }

  const page = await context.newPage();

  try {
    const url = 'https://codeforces.com/contests/2273,2274';

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log('STATUS:', response?.status());
    console.log('FINAL URL:', page.url());
    console.log('TITLE:', await page.title());

    const links = await page.locator('a').evaluateAll(as =>
      as.map(a => ({
        text: (a.textContent || '').trim(),
        href: a.getAttribute('href')
      })).filter(x =>
        (x.href || '').includes('2273') ||
        (x.href || '').includes('2274') ||
        /register/i.test(x.text)
      )
    );

    console.log('MATCHING LINKS:', JSON.stringify(links, null, 2));

    const body = await page.locator('body').innerText();
    console.log('BODY:', body.slice(0, 5000));
  } finally {
    await page.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
