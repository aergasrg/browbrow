// End-to-end check in a real browser: serves the site, opens demo mode, and
// verifies the heart rate on screen matches the simulated subject, with no
// console errors. Saves screenshots when SCREENSHOTS=<dir> is set.
//
// Needs Playwright: npm i -D playwright (or a global install).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ScreenshotDir = process.env.SCREENSHOTS;
const Types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.task': 'application/octet-stream', '.wasm': 'application/wasm' };

let Playwright;
try {
  Playwright = await import('playwright');
} catch {
  console.log('Playwright is not installed; skipping the browser test (npm i -D playwright).');
  process.exit(0);
}

/** Tiny static file server for the repo. */
const Server = http.createServer((Request, Response) => {
  const Url = new URL(Request.url ?? '/', 'http://localhost');
  let File = path.join(Root, decodeURIComponent(Url.pathname));
  if (!File.startsWith(Root)) return Response.writeHead(403).end();
  if (fs.existsSync(File) && fs.statSync(File).isDirectory()) File = path.join(File, 'index.html');
  if (!fs.existsSync(File)) return Response.writeHead(404).end();
  Response.writeHead(200, { 'content-type': Types[path.extname(File)] ?? 'application/octet-stream' });
  fs.createReadStream(File).pipe(Response);
});
await new Promise((Resolve) => Server.listen(0, Resolve));
const Port = /** @type {import('node:net').AddressInfo} */ (Server.address()).port;

const Browser = await Playwright.chromium.launch();
const Failures = [];
try {
  for (const [Name, Viewport, Scale] of [
    ['phone', { width: 430, height: 932 }, 3],
    ['desktop', { width: 1440, height: 900 }, 1],
  ]) {
    const Page = await Browser.newPage({ viewport: Viewport, deviceScaleFactor: Scale });
    const Errors = [];
    Page.on('pageerror', (Error) => Errors.push(Error.message));
    Page.on('console', (Message) => {
      // Web fonts may be unreachable in CI; that is not an app error.
      if (Message.type() === 'error' && !/fonts\.g/.test(Message.text()) && !/ERR_/.test(Message.text())) Errors.push(Message.text());
    });
    if (ScreenshotDir) {
      await Page.goto(`http://localhost:${Port}/`);
      await Page.waitForTimeout(800);
      await Page.screenshot({ path: path.join(ScreenshotDir, `${Name}-start.png`) });
    }
    await Page.goto(`http://localhost:${Port}/?demo`);
    await Page.waitForFunction(() => document.querySelector('#hero-card')?.classList.contains('measuring'), null, { timeout: 20000 });
    await Page.waitForTimeout(9000);
    const Reading = await Page.evaluate(() => {
      const App = /** @type {any} */ (window).BrowbrowPulse;
      const Subject = App.Subject;
      const Now = performance.now() / 1000 - App.DemoStart;
      let Truth = 0;
      for (let Step = 0; Step < 10; Step++) Truth += Subject.heartRateAt(Now - Step);
      return { Shown: Number(document.querySelector('#bpm-value')?.textContent), Truth: Truth / 10 };
    });
    console.log(`${Name}: showing ${Reading.Shown} BPM, simulated ${Reading.Truth.toFixed(1)} BPM`);
    if (!(Math.abs(Reading.Shown - Reading.Truth) <= 5)) Failures.push(`${Name}: showed ${Reading.Shown}, expected about ${Reading.Truth.toFixed(1)}`);
    if (Errors.length) Failures.push(`${Name}: console errors: ${Errors.join(' | ')}`);
    if (ScreenshotDir) {
      await Page.screenshot({ path: path.join(ScreenshotDir, `${Name}-demo.png`) });
      await Page.screenshot({ path: path.join(ScreenshotDir, `${Name}-demo-full.png`), fullPage: true });
    }
    await Page.close();
  }
} finally {
  await Browser.close();
  Server.close();
}
if (Failures.length) {
  console.error(`FAILED\n${Failures.join('\n')}`);
  process.exit(1);
}
console.log('Browser test passed.');
