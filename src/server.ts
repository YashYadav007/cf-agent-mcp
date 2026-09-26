import 'dotenv/config';
import { createApp } from './app.js';
import { closeBrowser } from './codeforces/browser.js';

export function listenConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.HOST || (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const port = Number(env.PORT || (env.NODE_ENV === 'production' ? 8080 : 3000));
  const timeoutMs = Number(env.CODEFORCES_TIMEOUT_MS || 15000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('CODEFORCES_TIMEOUT_MS must be between 1000 and 60000.');
  return { host, port, timeoutMs };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { host, port, timeoutMs } = listenConfig();
  const app = createApp({ host, timeoutMs, allowedHosts: process.env.ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean) });
  const server = app.listen(port, host, () => console.error('[SERVER] started', { port }));
  server.requestTimeout = 300_000;
  server.headersTimeout = 10_000;
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    console.error('[SERVER] shutting down');
    app.locals.stopWrites();
    const drained = new Promise<void>((resolve) => server.close(() => resolve()));
    const timeout = setTimeout(() => process.exit(1), 9000).unref();
    await drained;
    await closeBrowser();
    clearTimeout(timeout);
    // Playwright's CDP socket is only dropped by ending this process. Never
    // call browser.close() on the user's externally owned Chrome instance.
    if (process.env.CF_BROWSER_CDP_URL) process.exit(0);
  }
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}
