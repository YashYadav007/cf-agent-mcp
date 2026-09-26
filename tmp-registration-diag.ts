import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

  const contexts = browser.contexts();

  if (contexts.length === 0) {
    throw new Error('No Chrome context found');
  }

  const context = contexts[0];
  const page = await context.newPage();

  try {
    const url = 'https://codeforces.com/contests/2268,2269';

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    console.log('STATUS:', response?.status());
    console.log('FINAL URL:', page.url());
    console.log('TITLE:', await page.title());

    const links = await page.locator('a').evaluateAll((anchors) =>
      anchors
        .map((a) => ({
          text: (a.textContent || '').trim(),
          href: a.getAttribute('href'),
        }))
        .filter(
          (x) =>
            (x.href || '').includes('contestRegistration') ||
            /register/i.test(x.text)
        )
    );

    console.log(
      'REGISTER LINKS:',
      JSON.stringify(links, null, 2)
    );

    const body = await page.locator('body').innerText();

    console.log(
      'BODY SNIPPET:',
      body.slice(0, 3000)
    );
  } finally {
    await page.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
