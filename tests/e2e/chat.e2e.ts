/**
 * 채팅 상태 처리 E2E (개발용 모의 제공자 사용 — 실제 모델 연결 검증이 아님).
 */
import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptConsent,
  ask,
  askAndWaitStart,
  chooseModel,
  closePanel,
  lastAnswer,
  launch,
  openDemo,
  openPanel,
  pick,
  readDb,
  sleep,
  text,
  waitForAnswer,
  type Env,
} from './harness';

let env: Env;
let page: Page;
let panel: Page;

beforeAll(async () => {
  env = await launch();
  page = await openDemo(env);
  panel = await openPanel(env, page);
  await acceptConsent(panel);
  await chooseModel(panel, '모의 응답');
});

afterAll(async () => {
  await env?.close();
});

describe('채팅 (모의 제공자)', () => {
  it('질문을 보내면 스트리밍으로 답이 오고 완료 후 근거 칩·확인 결과가 보인다', async () => {
    await pick(panel, page, '.seller-name');
    await ask(panel, '이 텍스트가 왜 말줄임되지 않을까?');
    await panel.waitForSelector('.msg-assistant.status-streaming, .msg-assistant.status-pending', { timeout: 5000 });
    await waitForAnswer(panel, 'complete');
    const answer = await lastAnswer(panel);
    expect(answer.text).toContain('모의 응답입니다');
    expect(await panel.$eval('.msg-assistant .badge-warn', (el) => el.textContent)).toContain('실제 모델 아님');
    // 수집 자료에 있는 식별자는 버튼, 없는 식별자는 경고 표시
    expect(await panel.$$eval('.msg-assistant button.cite', (els) => els.length)).toBeGreaterThan(0);
    expect(await panel.$eval('.msg-assistant .cite.is-unknown', (el) => el.textContent)).toBe('E999?');
    expect(answer.foot).toContain('수집 자료에 없는 식별자 1개(E999)');
    // 보낸 뒤에는 첨부 카드가 비고 대상 카드는 '이 대화의 대상'이 된다
    expect(await panel.$('.attach-card')).toBeNull();
    expect(await text(panel, '.target-card')).toContain('이 대화의 대상');
  });

  it('답변의 근거 칩을 누르면 페이지에서 요소를 강조한다', async () => {
    await panel.click('.msg-assistant button.cite');
    await page.waitForFunction(() => Boolean(document.querySelector('noodlelens-overlay')), { timeout: 3000 });
  });

  it('긴 코드 블록이 있어도 패널에 가로 스크롤이 생기지 않는다(320px)', async () => {
    await panel.setViewport({ width: 320, height: 700 });
    await sleep(200);
    const overflow = await panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  it('생성 중 중단하면 받은 부분을 남기고 중단됨으로 표시한다', async () => {
    await askAndWaitStart(panel, '천천히 답해 줘 #mock:slow', 21);
    await panel.click('.send-btn.is-stop');
    await waitForAnswer(panel, 'cancelled');
    const answer = await lastAnswer(panel);
    expect(answer.text.length).toBeGreaterThan(20);
    expect(answer.notice).toContain('중단');
    const db = await readDb(panel);
    const saved = db.messages.find((m) => m.status === 'cancelled');
    expect(String(saved?.text ?? '').length).toBeGreaterThan(20);
  });

  it('위쪽을 읽는 동안에는 새 내용이 와도 강제로 내리지 않고 최신 답변 버튼을 보여 준다', async () => {
    await panel.setViewport({ width: 360, height: 520 });
    await askAndWaitStart(panel, '스크롤 시험 #mock:slow', 5);
    await panel.evaluate(() => document.querySelector('.messages')!.scrollTo(0, 0));
    await sleep(150);
    await panel.waitForFunction(
      () => {
        const all = document.querySelectorAll('.msg-assistant');
        return (all[all.length - 1]?.querySelector('.markdown')?.textContent?.length ?? 0) > 120;
      },
      { timeout: 15000 },
    );
    expect(await panel.$eval('.messages', (el) => el.scrollTop)).toBe(0);
    expect(await panel.$('.jump-latest')).not.toBeNull();
    await panel.click('.jump-latest');
    await sleep(100);
    const atBottom = await panel.$eval('.messages', (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    expect(atBottom).toBe(true);
    await waitForAnswer(panel, 'complete', 30000);
  });

  it('보내는 중 Enter를 연달아 눌러도 질문은 한 번만 저장된다', async () => {
    const before = (await readDb(panel)).messages.filter((m) => m.role === 'user').length;
    await panel.click('.composer-input');
    await panel.keyboard.type('중복 확인');
    await panel.keyboard.press('Enter');
    await panel.keyboard.press('Enter');
    await panel.keyboard.press('Enter');
    await waitForAnswer(panel, 'complete');
    const after = (await readDb(panel)).messages.filter((m) => m.role === 'user').length;
    expect(after - before).toBe(1);
  });

  it('생성 중 다른 대화로 옮겨도 응답은 원래 대화에만 붙는다', async () => {
    await panel.click('.header-actions .icon-btn:nth-child(1)');
    await panel.waitForSelector('.empty-guide', { timeout: 3000 });
    await askAndWaitStart(panel, '대화 A 질문 #mock:slow');
    // 새 분석(B)으로 옮겨 질문
    await panel.click('.header-actions .icon-btn:nth-child(1)');
    await panel.waitForSelector('.empty-guide', { timeout: 3000 });
    await ask(panel, '대화 B 질문');
    await waitForAnswer(panel, 'complete', 20000);
    const db = await readDb(panel);
    const conversationA = db.conversations.find((c) => String(c.title).startsWith('대화 A'));
    const conversationB = db.conversations.find((c) => String(c.title).startsWith('대화 B'));
    expect(conversationA && conversationB).toBeTruthy();
    // A의 답이 끝날 때까지 기다린 뒤 각 대화의 메시지를 비교
    await panel.waitForFunction(
      async (id) => {
        const req = indexedDB.open('noodlelens');
        const database: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
        const all: Array<{ conversationId: string; role: string; status?: string }> = await new Promise((r) => {
          const g = database.transaction('messages').objectStore('messages').getAll();
          g.onsuccess = () => r(g.result);
        });
        database.close();
        return all.some((m) => m.conversationId === id && m.role === 'assistant' && m.status === 'complete');
      },
      { timeout: 20000, polling: 300 },
      conversationA!.id,
    );
    const final = await readDb(panel);
    const byTime = (a: Record<string, unknown>, b: Record<string, unknown>) => Number(a.createdAt) - Number(b.createdAt);
    const aMessages = final.messages.filter((m) => m.conversationId === conversationA!.id).sort(byTime);
    const bMessages = final.messages.filter((m) => m.conversationId === conversationB!.id).sort(byTime);
    expect(aMessages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(bMessages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(String(aMessages[1]?.text)).toContain('모의 응답입니다');
    // 화면은 B에 머문다
    expect(await panel.$eval('.bubble', (el) => el.textContent)).toBe('대화 B 질문');
  });

  it('패널을 닫았다 열어도 기록에서 대화와 상태를 다시 볼 수 있다', async () => {
    await closePanel(env, page);
    panel = await openPanel(env, page);
    await panel.click('.header-actions .icon-btn:nth-child(2)');
    await panel.waitForSelector('.history-list');
    const titles = await panel.$$eval('.history-title', (els) => els.map((e) => e.textContent));
    expect(titles.some((t) => t?.startsWith('대화 A'))).toBe(true);
    expect(titles.some((t) => t?.startsWith('이 텍스트가 왜'))).toBe(true);
    // 첫 대화를 열면 중단된 답변이 그대로 보인다
    const items = await panel.$$('.history-item');
    for (const item of items) {
      if ((await item.evaluate((el) => el.textContent ?? '')).includes('이 텍스트가 왜')) {
        await item.click();
        break;
      }
    }
    await panel.waitForSelector('.msg-assistant.status-cancelled', { timeout: 5000 });
    expect(await text(panel, '.target-card')).toContain('div.seller-name');
  });

  it('생성 중 패널을 닫으면 다시 열 때 연결 끊김(패널 닫힘)으로 정리된다', async () => {
    await chooseModel(panel, '모의 응답');
    await askAndWaitStart(panel, '패널 닫기 시험 #mock:slow', 11);
    await sleep(700); // 주기 저장(500ms)이 한 번 이상 일어나도록
    await closePanel(env, page);
    panel = await openPanel(env, page);
    const db = await readDb(panel);
    const target = db.messages.find((m) => m.role === 'assistant' && db.messages.some((u) => u.id === m.replyTo && String(u.text).startsWith('패널 닫기 시험')));
    expect(target?.status).toBe('interrupted');
    expect(target?.interruptReason).toBe('panel-closed');
    expect(String(target?.text ?? '').length).toBeGreaterThan(5);
  });

  it('실패한 마지막 답변은 다시 시도할 수 있고 이전 시도는 기록으로 남는다', async () => {
    await chooseModel(panel, '모의 응답');
    await askAndWaitStart(panel, '혼잡 오류 재현 #mock:overloaded-mid');
    await waitForAnswer(panel, 'error');
    expect((await lastAnswer(panel)).notice).toContain('혼잡');
    // 같은 질문 재시도(이번에는 지시어 때문에 다시 오류가 나지만 새 시도로 추가되는지 본다)
    await panel.click('.msg-assistant:last-of-type .msg-notice-actions .chip-btn');
    await panel.waitForFunction(() => document.querySelectorAll('.msg-assistant').length >= 2, { timeout: 5000 });
    await waitForAnswer(panel, 'error');
    expect(await panel.$('.superseded-toggle')).not.toBeNull();
  });

  it('대화를 지우면 메시지와 스냅샷도 함께 지운다', async () => {
    const before = await readDb(panel);
    const conversation = before.conversations.find((c) => String(c.title).startsWith('이 텍스트가 왜'))!;
    expect(before.snapshots.some((s) => s.conversationId === conversation.id)).toBe(true);
    await panel.click('.header-actions .icon-btn:nth-child(2)');
    await panel.waitForSelector('.history-list');
    panel.once('dialog', (dialog) => void dialog.accept());
    const rows = await panel.$$('.history-list li');
    for (const row of rows) {
      if ((await row.evaluate((el) => el.textContent ?? '')).includes('이 텍스트가 왜')) {
        await (await row.$('.history-delete'))!.click();
        break;
      }
    }
    await sleep(300);
    const after = await readDb(panel);
    expect(after.conversations.some((c) => c.id === conversation.id)).toBe(false);
    expect(after.messages.some((m) => m.conversationId === conversation.id)).toBe(false);
    expect(after.snapshots.some((s) => s.conversationId === conversation.id)).toBe(false);
  });
});
