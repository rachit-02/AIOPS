/**
 * Screenshot the running dashboard after a real delay.
 *
 * `msedge --screenshot` captures as soon as the load event fires, and
 * --virtual-time-budget fast-forwards timers without waiting on a long-lived
 * SSE stream - so neither can capture Kira mid-investigation, which is the one
 * view worth checking. This drives the browser over CDP instead and waits in
 * real time.
 *
 *   node scripts/shot.mjs <url> <out.png> [waitMs] [height]
 */
const [url, out, waitMs = '15000', height = '1000', width = '1600', evalFile] = process.argv.slice(2);
// Optional JS file evaluated in the page before the capture, so a screenshot
// can show a state that only exists after interaction (a drawer open, a real
// error rendered) rather than only the initial paint.
const PORT = 9333;

const { spawn } = await import('node:child_process');
const { writeFileSync } = await import('node:fs');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--window-size=${width},${height}`,
    `--user-data-dir=${process.env.TEMP}/edge-cdp-profile`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* browser still starting */
    }
    await sleep(500);
  }
  throw new Error('devtools endpoint never came up');
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
await sleep(Number(waitMs));

if (evalFile) {
  const { readFileSync } = await import('node:fs');
  const expression = readFileSync(evalFile, 'utf8');
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) {
    console.error('page script threw:', r.exceptionDetails.text ?? JSON.stringify(r.exceptionDetails).slice(0, 300));
  } else if (r?.result?.value !== undefined) {
    console.log('page script ->', JSON.stringify(r.result.value).slice(0, 400));
  }
}
const { data } = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(data, 'base64'));
console.log(`captured ${out} after ${waitMs}ms`);
ws.close();
child.kill();
process.exit(0);
