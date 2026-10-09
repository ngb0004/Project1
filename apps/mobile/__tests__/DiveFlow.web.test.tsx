import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { assertValidCase, toPublicCase, type PublicCase } from '@sia/case-schema';
import { DiveFlow, testIds, voteOptionId } from '@sia/dive-ui';
import { createFakeApi } from './fakeApi';

/**
 * The dive through react-native-web: the Expo web build and the admin console
 * preview render these same components to the DOM, where testID becomes
 * data-testid, Pressables respond to click and the slider to the keyboard.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dir = join(__dirname, '../../../cases/fixtures');
const fixtures: PublicCase[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => toPublicCase(assertValidCase(JSON.parse(readFileSync(join(dir, f), 'utf8')))));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const query = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function find(id: string, timeout = 2000): Promise<HTMLElement> {
  const start = Date.now();
  for (;;) {
    const el = query(id);
    if (el) return el;
    if (Date.now() - start > timeout) throw new Error(`No element with data-testid="${id}"`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function click(id: string) {
  const el = await find(id);
  await act(async () => {
    el.click();
  });
}

async function key(id: string, k: string) {
  const el = await find(id);
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

describe.each(fixtures.map((d) => [d.slug, d] as const))('%s on react-native-web', (_slug, doc) => {
  it('plays the full flow in the DOM', async () => {
    const api = createFakeApi([doc]);
    const share = jest.fn(async () => ({ status: 'copied' as const, download: jest.fn() }));
    await act(async () => {
      root.render(
        <DiveFlow
          api={api}
          slug={doc.slug}
          deviceId="device-web-0123456789"
          shareBaseUrl="https://dive.test"
          services={{ openUrl: jest.fn(), share }}
        />,
      );
    });

    await find(testIds.caseCard);
    expect(container.textContent).toContain(doc.title);
    if (doc.content_warning) {
      expect((await find(testIds.next)).getAttribute('aria-disabled')).toBe('true');
      const ack = await find(testIds.contentWarningAck);
      expect(ack.getAttribute('role')).toBe('checkbox');
      expect(ack.getAttribute('aria-checked')).toBe('false');
      await click(testIds.contentWarningAck);
      expect((await find(testIds.contentWarningAck)).getAttribute('aria-checked')).toBe('true');
    }
    await click(testIds.next);
    await find(testIds.startingFacts);
    await click(testIds.next);

    // The slider is an ARIA slider driven by the keyboard.
    const slider = await find(testIds.slider);
    expect(slider.getAttribute('role')).toBe('slider');
    expect(slider.getAttribute('tabindex')).toBe('0');
    expect(slider.getAttribute('aria-valuenow')).toBe('50');
    await key(testIds.slider, 'ArrowRight');
    await key(testIds.slider, 'PageUp');
    expect((await find(testIds.slider)).getAttribute('aria-valuenow')).toBe('61');
    expect(slider.getAttribute('aria-disabled')).toBeNull();
    await click(testIds.pollCommit);
    const locked = await find(testIds.lockedNote);
    // The Lock in button is gone; focus lands on the locked note rather than the page body.
    expect(locked.parentElement!.contains(document.activeElement)).toBe(true);
    const lockedSlider = await find(testIds.slider);
    expect(lockedSlider.getAttribute('aria-disabled')).toBe('true');
    expect(lockedSlider.getAttribute('aria-valuetext')).toMatch(/locked$/);
    await click(testIds.next);

    for (const step of doc.steps) {
      await find(testIds.stepScreen);
      expect(container.textContent).toContain(step.headline);
      expect(query(testIds.reveal)).toBeNull();
      expect(container.textContent).not.toContain('What everyone else said');
      if (step.depth.length > 0) {
        expect((await find(testIds.goDeeper)).getAttribute('aria-expanded')).toBe('false');
        await click(testIds.goDeeper);
        expect((await find(testIds.goDeeper)).getAttribute('aria-expanded')).toBe('true');
      }
      // The three answers are an ARIA radio group; nothing is checked until the reader picks.
      const agree = await find(voteOptionId('agree'));
      expect(agree.getAttribute('role')).toBe('radio');
      expect(agree.getAttribute('aria-checked')).toBe('false');
      expect((await find(testIds.pollCommit)).getAttribute('aria-disabled')).toBe('true');
      await click(voteOptionId('agree'));
      expect((await find(voteOptionId('agree'))).getAttribute('aria-checked')).toBe('true');
      await click(testIds.pollCommit);
      const reveal = await find(testIds.reveal);
      expect(query(testIds.crowdChart)).not.toBeNull();
      expect(container.textContent).toContain('What everyone else said');
      // Focus moves to the start of the reveal: the reader's own vote.
      expect(reveal.contains(document.activeElement)).toBe(true);
      expect(document.activeElement!.textContent).toMatch(/^You agreed/);
      await click(testIds.next);
    }

    if (doc.takes.length > 0) {
      await find(testIds.takesScreen);
      await click(testIds.next);
    }

    await find(testIds.afterScreen);
    await click(testIds.pollCommit);
    await find(testIds.lockedNote);
    await click(testIds.next);

    const chart = await find(testIds.finalChart);
    expect(chart.querySelector('svg')).not.toBeNull();
    expect(chart.getAttribute('role')).toBe('img');
    expect(chart.getAttribute('aria-label')).toBe('Your answer went from 61 to 61. On average, the crowd went from 62 to 51.');
    await click(testIds.next);

    const card = await find(testIds.shareCard);
    expect(card.textContent).toContain('I started at 61.');
    expect(card.textContent).toContain(`https://dive.test/case/${doc.slug}`);
    await click(testIds.shareButton);
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ view: card }));
    await find(testIds.shareDownload);
  });
});

describe('flag sheet on react-native-web', () => {
  const doc = fixtures[0]!;

  it('is a modal dialog: focus moves in, stays in, and returns on Escape', async () => {
    const api = createFakeApi([doc]);
    await act(async () => {
      root.render(
        <DiveFlow
          api={api}
          slug={doc.slug}
          deviceId="device-web-0123456789"
          shareBaseUrl="https://dive.test"
          services={{ openUrl: jest.fn(), share: jest.fn() }}
        />,
      );
    });
    if (doc.content_warning) await click(testIds.contentWarningAck);
    await click(testIds.next);
    await click(testIds.next);
    await click(testIds.pollCommit);
    await click(testIds.next);
    await find(testIds.stepScreen);

    const link = await find(testIds.flagLink);
    await act(async () => link.focus());
    await click(testIds.flagLink);
    const sheet = await find(testIds.flagSheet);
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(sheet);
    // Everything behind the sheet is inert and hidden from screen readers.
    const behind = query(testIds.pollCommit)!.closest('[aria-hidden="true"]') as HTMLElement & { inert?: boolean };
    expect(behind).not.toBeNull();
    expect(behind.inert).toBe(true);

    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last.
    const focusable = Array.from(sheet.querySelectorAll<HTMLElement>('[tabindex="0"], textarea'));
    await act(async () => focusable.at(-1)!.focus());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(focusable[0]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(focusable.at(-1));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(query(testIds.flagSheet)).toBeNull();
    expect(document.activeElement).toBe(query(testIds.flagLink));
    expect((query(testIds.pollCommit)!.closest('[aria-hidden="true"]') as HTMLElement | null)?.inert ?? false).toBe(false);
  });
});
