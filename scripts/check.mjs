import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'scripts/check.mjs';
const failures = [];
const fail = (what, detail) => failures.push(`${what}: ${detail}`);

const BANNED = [
  { word: /flywheel/i, use: 'a plain description of the loop' },
  { word: /punch list/i, use: 'list' },
  { word: /stale/i, use: 'out of date, superseded, no longer current, abandoned' },
  { word: /whole/i, use: 'entire, all of, end to end, or drop it' },
  { word: /console/i, use: 'dashboard', allow: /console\s*\.\s*\w|['"`]console['"`]/ },
];

const APP_PATHS = ['/', '/buy', '/claim'];

const HOSTS = [
  'app.farahbrunache.com',
  'chargingthefuture.com',
  'app.chargingthefuture.com',
  'chargingthefuture.github.io',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['.git', 'node_modules', '.vercel'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function checkWords(files) {
  for (const file of files) {
    const name = file.slice(ROOT.length);
    if (!/\.(js|mjs|html|css|md)$/.test(name) || name === SELF) continue;
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      for (const banned of BANNED) {
        const hit = line.match(banned.word);
        if (!hit || (banned.allow && banned.allow.test(line))) continue;
        fail('banned word', `${name}:${index + 1} uses "${hit[0]}". Write ${banned.use}.`);
      }
    }
  }
}

function checkLinks(html) {
  for (const [, attr, value] of html.matchAll(/\b(href|src|action)="([^"]*)"/g)) {
    if (value.startsWith('#')) {
      if (!html.includes(`id="${value.slice(1)}"`)) fail('link', `${attr}="${value}" has no matching id`);
      continue;
    }
    if (value.startsWith('/')) {
      if (!existsSync(join(ROOT, value.split(/[?#]/)[0]))) fail('link', `${attr}="${value}" is not a file here`);
      continue;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      fail('link', `${attr}="${value}" is not an absolute address`);
      continue;
    }
    if (url.protocol !== 'https:') fail('link', `${value} is not https`);
    if (!HOSTS.includes(url.hostname)) fail('link', `${value} points at a host not on the list in ${SELF}`);
    if (url.hostname === 'app.farahbrunache.com' && !APP_PATHS.includes(url.pathname)) {
      fail('link', `${value} is not an address the app serves`);
    }
  }
}

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

async function checkRender() {
  const server = createServer((req, res) => {
    const path = req.url.split(/[?#]/)[0];
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    for (const message of errors) fail('script error', message);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow !== 0) fail('390px render', `the page is ${overflow}px wider than the screen`);

    const rate = page.locator('#rate');
    if (await rate.count()) {
      await rate.fill('7');
      const figure = await page.locator('#calcout .calc-figure').textContent();
      if (figure !== '$350,000') fail('calculator', `7 gave "${figure}", expected "$350,000"`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

const files = listFiles(ROOT);
checkWords(files);
checkLinks(readFileSync(join(ROOT, 'index.html'), 'utf8'));
await checkRender();

if (failures.length) {
  for (const line of failures) console.error(line);
  console.error(`\n${failures.length} failed.`);
  process.exit(1);
}
console.log('Words, links, 390px render: passed.');
