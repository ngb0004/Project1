import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { assertValidCase, toPublicCase, type PublicCase } from '@sia/case-schema';
import { DiveFlow, testIds } from '@sia/dive-ui';
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
      await click(testIds.contentWarningAck);
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
    await click(testIds.pollCommit);
    await find(testIds.lockedNote);
    await click(testIds.next);

    for (const step of doc.steps) {
      await find(testIds.stepScreen);
      expect(container.textContent).toContain(step.headline);
      expect(query(testIds.reveal)).toBeNull();
      expect(container.textContent).not.toContain('of readers moved here');
      await key(testIds.slider, 'ArrowLeft');
      await click(testIds.pollCommit);
      await find(testIds.reveal);
      expect(query(testIds.crowdChart)).not.toBeNull();
      expect(container.textContent).toContain('of readers moved here');
      await click(testIds.next);
    }

    await find(testIds.afterScreen);
    await click(testIds.pollCommit);
    await find(testIds.lockedNote);
    await click(testIds.next);

    const chart = await find(testIds.finalChart);
    expect(chart.querySelector('svg')).not.toBeNull();
    await click(testIds.next);

    const card = await find(testIds.shareCard);
    expect(card.textContent).toContain('I started at 61.');
    expect(card.textContent).toContain(`https://dive.test/case/${doc.slug}`);
    await click(testIds.shareButton);
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ view: card }));
    await find(testIds.shareDownload);
  });
});
