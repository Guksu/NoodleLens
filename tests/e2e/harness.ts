/**
 * E2E 하네스: Chrome for Testing(Playwright 번들)에 build:dev 결과를 설치하고,
 * 툴바 아이콘 클릭(CDP Extensions.triggerAction)으로 실제 사이드 패널을 연다.
 */
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import puppeteer, { type Browser, type Extension, type Page } from 'puppeteer-core';
// @ts-expect-error 타입 선언이 없는 스크립트
import { startDemoServer } from '../../scripts/serve-demo.mjs';

export const EXT_PATH = join(import.meta.dirname, '..', '..', 'dist-dev');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Env {
  browser: Browser;
  extension: Extension;
  extensionId: string;
  server: Server;
  origin: string;
  close(): Promise<void>;
}

export async function launch(): Promise<Env> {
  const server: Server = await startDemoServer(0);
  const { port } = server.address() as AddressInfo;
  const browser = await puppeteer.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    pipe: true,
    enableExtensions: true,
    args: ['--window-size=1280,900', '--lang=ko-KR'],
  });
  const extensionId = await browser.installExtension(EXT_PATH);
  const extension = (await browser.extensions()).get(extensionId)!;
  // service worker가 리스너를 등록하기 전에 아이콘을 누르면 클릭이 사라진다.
  for (let i = 0; i < 100 && (await extension.workers()).length === 0; i += 1) await sleep(50);
  const worker = (await extension.workers())[0];
  await worker?.evaluate(() => chrome.action.onClicked.hasListeners());
  return {
    browser,
    extension,
    extensionId,
    server,
    origin: `http://localhost:${port}`,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

export async function openDemo(env: Env, path = '/', viewport = { width: 1000, height: 820 }): Promise<Page> {
  const page = await env.browser.newPage();
  await page.setViewport(viewport);
  await page.goto(`${env.origin}${path}`);
  await page.bringToFront();
  return page;
}

/** 아이콘 클릭으로 사이드 패널을 연다(이미 열려 있으면 그 패널). 클릭한 탭에 activeTab이 생긴다. */
export async function openPanel(env: Env, page: Page): Promise<Page> {
  const url = `chrome-extension://${env.extensionId}/sidepanel.html`;
  const existing = env.browser.targets().find((t) => t.url().startsWith(url));
  if (existing) {
    await env.extension.triggerAction(page);
    return (await existing.asPage())!;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const waiting = env.browser.waitForTarget((t) => t.url().startsWith(url), { timeout: 4000 }).catch(() => null);
    await env.extension.triggerAction(page);
    const target = await waiting;
    if (target) {
      const panel = (await target.asPage())!;
      await panel.waitForSelector('.app:not(.app-loading)', { timeout: 8000 });
      return panel;
    }
  }
  throw new Error('side panel did not open');
}

/** service worker에서 sidePanel.close()로 패널을 닫는다(Chrome 141+) */
export async function closePanel(env: Env, page: Page) {
  const worker = (await env.extension.workers())[0]!;
  const url = `chrome-extension://${env.extensionId}/sidepanel.html`;
  const closed = new Promise<void>((resolve) => {
    const onDestroyed = (target: { url(): string }) => {
      if (target.url().startsWith(url)) {
        env.browser.off('targetdestroyed', onDestroyed);
        resolve();
      }
    };
    env.browser.on('targetdestroyed', onDestroyed);
  });
  const tabUrl = page.url();
  const windowId = await worker.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === u)?.windowId ?? (await chrome.windows.getLastFocused()).id;
  }, tabUrl);
  await worker.evaluate((id) => chrome.sidePanel.close({ windowId: id! }), windowId);
  await Promise.race([closed, sleep(3000)]);
}

export async function acceptConsent(panel: Page) {
  const button = await panel.$('.consent-accept');
  if (button) {
    await button.click();
    await panel.waitForSelector('.composer', { timeout: 5000 });
  }
}

export async function text(panel: Page, selector: string): Promise<string> {
  return panel.$eval(selector, (el) => (el as HTMLElement).innerText);
}

export async function center(page: Page, selector: string) {
  return page.$eval(selector, (el) => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

export async function startPicking(panel: Page) {
  await panel.click('.composer-row .btn-secondary');
  await panel.waitForSelector('.picking-banner', { timeout: 5000 });
  await panel.waitForFunction(() => document.querySelector('.picking-banner')?.textContent?.includes('클릭하세요'), { timeout: 5000 });
}

/** 선택 모드를 켜고 페이지의 selector 요소를 클릭해 고른다 */
export async function pick(panel: Page, page: Page, selector: string) {
  await startPicking(panel);
  const point = await center(page, selector);
  await page.mouse.move(point.x, point.y);
  await sleep(80);
  await page.mouse.click(point.x, point.y);
  await panel.waitForFunction(() => !document.querySelector('.picking-banner'), { timeout: 5000 });
  await panel.waitForSelector('.attach-card', { timeout: 5000 });
}

export async function chooseModel(panel: Page, label: string) {
  await panel.click('.model-button');
  await panel.waitForSelector('.model-menu');
  const items = await panel.$$('.menu-item');
  for (const item of items) {
    const itemText = await item.evaluate((el) => el.textContent ?? '');
    if (itemText.includes(label)) {
      await item.click();
      await panel.waitForFunction(() => !document.querySelector('.model-menu'));
      return;
    }
  }
  throw new Error(`model ${label} not found`);
}

export async function ask(panel: Page, question: string) {
  await panel.click('.composer-input');
  await panel.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('.composer-input')!;
    input.select();
  });
  await panel.keyboard.type(question);
  await panel.keyboard.press('Enter');
}

/** 마지막 답변의 상태 클래스가 status가 될 때까지 기다린다 */
export async function waitForAnswer(panel: Page, status: string, timeout = 15000) {
  await panel.waitForFunction(
    (s) => {
      const all = document.querySelectorAll('.msg-assistant');
      const last = all[all.length - 1];
      return Boolean(last?.classList.contains(`status-${s}`));
    },
    { timeout },
    status,
  );
}

export async function lastAnswer(panel: Page) {
  return panel.evaluate(() => {
    const all = document.querySelectorAll<HTMLElement>('.msg-assistant');
    const last = all[all.length - 1];
    return {
      text: last?.querySelector('.markdown')?.textContent ?? '',
      status: [...(last?.classList ?? [])].find((c) => c.startsWith('status-')) ?? '',
      notice: last?.querySelector('.msg-notice')?.textContent ?? '',
      foot: last?.querySelector('.msg-foot')?.textContent ?? '',
    };
  });
}

/** 패널에서 확장 프로그램 IndexedDB 내용을 읽는다 */
export async function readDb(panel: Page) {
  return panel.evaluate(async () => {
    const open = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('noodlelens');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const db = await open();
    const all = (store: string) =>
      new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction(store).objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const [conversations, messages, snapshots] = await Promise.all([all('conversations'), all('messages'), all('snapshots')]);
    db.close();
    return { conversations, messages, snapshots } as {
      conversations: Array<Record<string, unknown>>;
      messages: Array<Record<string, unknown>>;
      snapshots: Array<Record<string, unknown>>;
    };
  });
}

export async function overlayPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(document.querySelector('noodlelens-overlay')));
}

/** 질문을 보내고 새 답변이 생겨 생성이 시작될 때까지 기다린다 */
export async function askAndWaitStart(panel: Page, question: string, minChars = 0) {
  const before = await panel.$$eval('.msg-assistant', (els) => els.length);
  await ask(panel, question);
  await panel.waitForFunction(
    (count, min) => {
      const all = document.querySelectorAll('.msg-assistant');
      if (all.length <= count) return false;
      const last = all[all.length - 1]!;
      const busy = last.classList.contains('status-pending') || last.classList.contains('status-streaming');
      return busy && (last.querySelector('.markdown')?.textContent?.length ?? 0) >= min;
    },
    { timeout: 15000 },
    before,
    minChars,
  );
}
