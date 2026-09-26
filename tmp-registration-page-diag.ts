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
    const url =
      'https://codeforces.com/contestRegistration/2269?backUrl=%2Fcontests%2F2268%2C2269';

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    console.log('STATUS:', response?.status());
    console.log('FINAL URL:', page.url());
    console.log('TITLE:', await page.title());

    const forms = await page.locator('form').evaluateAll((forms) =>
      forms.map((form) => ({
        action: form.getAttribute('action'),
        method: form.getAttribute('method'),
        text: (form.textContent || '').trim().slice(0, 1000),
      }))
    );

    console.log('FORMS:', JSON.stringify(forms, null, 2));

    const controls = await page
      .locator('input, button, select')
      .evaluateAll((els) =>
        els.map((el) => ({
          tag: el.tagName,
          type: el.getAttribute('type'),
          name: el.getAttribute('name'),
          value: el.getAttribute('value'),
          text: (el.textContent || '').trim(),
        }))
      );

    console.log('CONTROLS:', JSON.stringify(controls, null, 2));

    const body = await page.locator('body').innerText();

    console.log(
      'BODY SNIPPET:',
      body.slice(0, 5000)
    );
  } finally {
    await page.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
