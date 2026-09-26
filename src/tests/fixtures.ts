import type { Browser, Page } from 'playwright';
export const problemHtml = `<html><head><title>Problem</title></head><body><nav>Noise</nav>
<div class="problem-statement"><div class="header"><div class="title">A. Example</div><div class="time-limit">time limit per test 1 second</div><div class="memory-limit">memory limit per test 256 megabytes</div></div>
<div><p>Find <span class="tex-span">$n$</span> &lt; 10.</p><span class="MathJax">rendered noise</span><script type="math/tex">x^2</script><script>secret()</script></div>
<div class="input-specification"><div class="section-title">Input</div><p>Read n.</p></div>
<div class="output-specification"><div class="section-title">Output</div><p>Print n.</p></div>
<div class="sample-tests"><div class="sample-test"><div class="input"><pre>  2<br><br>3 &lt; 4</pre></div><div class="output"><pre><div>  yes</div><div>no</div></pre></div></div></div>
<div class="note"><div class="section-title">Note</div><p>A note.</p></div></div><footer>Noise</footer></body></html>`;
export const header = (handle: string) => `<div id="header"><div class="lang-chooser"><a href="/profile/${handle}">${handle}</a><a href="/logout?csrf_token=SECRET">Logout</a></div></div>`;
export function fakePage(html: string) {
  return { goto: async () => ({ status: () => 200 }), content: async () => html,
    locator: () => ({ waitFor: async () => undefined }), close: async () => undefined,
  } as unknown as Page;
}
export function browserMock(options: { html?: string; credentialLogin?: boolean; loginFails?: boolean } = {}) {
  let html = options.html ?? '<div id="header"><a href="/enter">Enter</a></div>';
  const calls = { launches: 0, contexts: 0, pages: 0, clicks: 0, closes: 0 };
  const page = { goto: async () => ({ status: () => 200 }), content: async () => html, close: async () => undefined,
    waitForLoadState: async () => undefined,
    locator: () => ({ fill: async () => undefined, first() { return this; }, click: async () => {
      calls.clicks++;
      if (options.loginFails) throw new Error('password=DO_NOT_LEAK csrf=DO_NOT_LEAK');
      if (options.credentialLogin) html = header('tester');
    } }),
  };
  const browser = { newContext: async () => { calls.contexts++; return {
    newPage: async () => { calls.pages++; return page; }, setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, close: async () => undefined,
  }; }, close: async () => { calls.closes++; } } as unknown as Browser;
  return { calls, launch: async () => { calls.launches++; return browser; } };
}
