import 'dotenv/config';
import { chromium } from 'playwright';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { authenticatedHandle, hasManualVerification } from '../src/codeforces/browser.js';

const directory = resolve('.auth');
const destination = join(directory, 'storage-state.json');
const temporary = join(directory, `.state-${randomUUID()}.tmp`);
const cdpUrl = 'http://127.0.0.1:9222';
const launchInstruction = 'Local Chrome CDP is unavailable. Run `npm run session:create` to launch the dedicated Chrome session first, complete login manually, and retry.';
const verificationIncomplete = 'Codeforces verification did not complete. Login manually in a normal browser and retry later.';
class SessionSetupError extends Error {}
const prompt = createInterface({ input: process.stdin, output: process.stdout });
let exitCode = 0;
try {
  const answer = await prompt.question('Have you completed manual Codeforces login and reached a normal authenticated page? Type yes to export: ');
  if (answer.trim().toLowerCase() !== 'yes') throw new SessionSetupError('Session export cancelled. Complete manual login before retrying.');
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  try { browser = await chromium.connectOverCDP(cdpUrl, { timeout: 5000 }); }
  catch { throw new SessionSetupError(launchInstruction); }
  // This process only attaches to the already-running browser. It never navigates,
  // fills a form, or closes the user's Chrome session.
  const context = browser.contexts()[0];
  if (!context) throw new SessionSetupError(launchInstruction);
  let handle: string | null = null;
  let sawVerification = false;
  for (const page of context.pages()) {
    let url: URL;
    try { url = new URL(page.url()); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== 'codeforces.com') continue;
    const html = await page.content();
    if (hasManualVerification(html)) { sawVerification = true; continue; }
    handle = authenticatedHandle(html);
    if (handle) break;
  }
  if (!handle) throw new SessionSetupError(sawVerification ? verificationIncomplete :
    'No authenticated Codeforces page is open in the dedicated Chrome session. Complete login manually and retry.');
  const expectedHandle = process.env.CF_EXPECTED_HANDLE?.trim();
  if (expectedHandle && handle.toLowerCase() !== expectedHandle.toLowerCase()) {
    throw new SessionSetupError('The logged-in Codeforces handle does not match CF_EXPECTED_HANDLE.');
  }
  const state = await context.storageState();
  state.cookies = state.cookies.filter((cookie) => cookie.domain === 'codeforces.com' || cookie.domain === '.codeforces.com');
  state.origins = state.origins.filter((origin) => origin.origin === 'https://codeforces.com');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, destination);
  console.log('Verified Codeforces session saved to .auth/storage-state.json (permissions 0600). Chrome remains open.');
} catch (error) {
  console.error(error instanceof SessionSetupError ? error.message :
    'Session export failed. Keep the dedicated Chrome session open and retry after manual login.');
  exitCode = 1;
} finally {
  prompt.close();
  await unlink(temporary).catch(() => undefined);
}
// Disconnect the CDP client by ending this helper process; never close Chrome.
process.exit(exitCode);
