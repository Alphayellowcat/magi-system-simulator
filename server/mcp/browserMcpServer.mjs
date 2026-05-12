#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const protocolVersion = '2025-06-18';
const artifactDir = path.resolve(
  process.cwd(),
  process.env.MAGI_BROWSER_ARTIFACT_DIR || path.join('.magi', 'artifacts', 'browser'),
);

let browser;
let page;
let buffer = '';

const launchBrowser = async () => {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const channel = process.env.MAGI_BROWSER_CHANNEL || 'chrome';
    if (channel === 'none') throw error;
    return chromium.launch({ headless: true, channel });
  }
};

const tools = [
  {
    name: 'browser_navigate',
    title: 'Browser Navigate',
    description: 'Open a URL in a persistent headless Chromium page and wait for it to load.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], default: 'domcontentloaded' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'browser_read_page',
    title: 'Browser Read Page',
    description: 'Read the current page URL, title, and visible body text.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', default: 12000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'browser_screenshot',
    title: 'Browser Screenshot',
    description: 'Capture a screenshot of the current browser page and return the artifact path.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        fullPage: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'browser_click',
    title: 'Browser Click',
    description: 'Click a CSS selector on the current page. This may change state and should require approval.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        timeoutMs: { type: 'number', default: 5000 },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'browser_type',
    title: 'Browser Type',
    description: 'Fill text into a CSS selector on the current page. This may submit secrets or change state and should require approval.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean', default: true },
        timeoutMs: { type: 'number', default: 5000 },
      },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'browser_close',
    title: 'Browser Close',
    description: 'Close the persistent browser page.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

const send = (id, result, error) => {
  const payload = error
    ? { jsonrpc: '2.0', id, error: { code: -32000, message: error.message || String(error) } }
    : { jsonrpc: '2.0', id, result };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const ensurePage = async () => {
  if (!browser) {
    browser = await launchBrowser();
  }
  if (!page || page.isClosed()) {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  }
  return page;
};

const toolResult = (data) => ({
  content: [
    {
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    },
  ],
  structuredContent: data,
});

const safeName = (value) => String(value || 'page')
  .toLowerCase()
  .replace(/[^a-z0-9_.-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'page';

const callTool = async (name, args = {}) => {
  if (name === 'browser_navigate') {
    const url = typeof args.url === 'string' ? args.url : '';
    if (!url) throw new Error('browser_navigate requires url');
    const currentPage = await ensurePage();
    await currentPage.goto(url, { waitUntil: args.waitUntil || 'domcontentloaded', timeout: 30000 });
    return toolResult({
      url: currentPage.url(),
      title: await currentPage.title(),
    });
  }

  if (name === 'browser_read_page') {
    const currentPage = await ensurePage();
    const maxChars = Number(args.maxChars || 12000);
    const text = await currentPage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    return toolResult({
      url: currentPage.url(),
      title: await currentPage.title(),
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
    });
  }

  if (name === 'browser_screenshot') {
    const currentPage = await ensurePage();
    await fs.mkdir(artifactDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(artifactDir, `${stamp}-${safeName(args.name)}.png`);
    await currentPage.screenshot({ path: filePath, fullPage: args.fullPage !== false });
    return toolResult({
      url: currentPage.url(),
      title: await currentPage.title(),
      artifactPath: filePath,
    });
  }

  if (name === 'browser_click') {
    const selector = typeof args.selector === 'string' ? args.selector : '';
    if (!selector) throw new Error('browser_click requires selector');
    const currentPage = await ensurePage();
    await currentPage.locator(selector).click({ timeout: Number(args.timeoutMs || 5000) });
    return toolResult({
      url: currentPage.url(),
      selector,
      clicked: true,
    });
  }

  if (name === 'browser_type') {
    const selector = typeof args.selector === 'string' ? args.selector : '';
    const text = typeof args.text === 'string' ? args.text : '';
    if (!selector) throw new Error('browser_type requires selector');
    const currentPage = await ensurePage();
    const locator = currentPage.locator(selector);
    if (args.clear !== false) {
      await locator.fill(text, { timeout: Number(args.timeoutMs || 5000) });
    } else {
      await locator.type(text, { timeout: Number(args.timeoutMs || 5000) });
    }
    return toolResult({
      url: currentPage.url(),
      selector,
      typedChars: text.length,
    });
  }

  if (name === 'browser_close') {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    page = undefined;
    browser = undefined;
    return toolResult({ closed: true });
  }

  throw new Error(`Unknown browser tool: ${name}`);
};

const handle = async (message) => {
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'magi-browser-mcp', version: '0.1.0' },
    });
    return;
  }

  if (message.method === 'tools/list') {
    send(message.id, { tools });
    return;
  }

  if (message.method === 'tools/call') {
    const params = message.params || {};
    send(message.id, await callTool(params.name, params.arguments || {}));
    return;
  }

  if (message.id !== undefined) {
    send(message.id, null, new Error(`Unsupported method: ${message.method}`));
  }
};

process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      handle(message).catch(error => send(message.id, null, error));
    } catch (error) {
      send(null, null, error);
    }
  }
});

const shutdown = async () => {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
