import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { PublicCase } from '@sia/case-schema';
import { DiveFlow, testIds, type DiveServices } from '@sia/dive-ui';
import { createFakeApi, type FakeApi } from './fakeApi';

const SOURCE = {
  id: 'src-1',
  title: 'Test record',
  publisher: 'Test publisher',
  url: 'https://example.org/test-record',
  date: '2026-09-01',
  type: 'official' as const,
  accessed_at: '2026-09-30T12:00:00Z',
};

const doc: PublicCase = {
  schema_version: 1,
  id: 'case-1',
  slug: 'tiny-case',
  title: 'A tiny test case',
  version: 1,
  as_of: '2026-09-30',
  question: {
    prompt: 'How much does the test question matter?',
    scale: { type: 'slider', min: 0, max: 100, left_label: 'Not at all', right_label: 'Completely' },
  },
  starting_facts: [{ id: 'f1', text: 'The baseline fact.', source_ids: ['src-1'], confidence: 'established' }],
  steps: [
    {
      id: 'one',
      order: 1,
      headline: 'The first headline.',
      body: 'The first body.',
      depth: [{ kind: 'context', id: 'ctx', title: 'Some context', body: 'Context body.', source_ids: ['src-1'] }],
      source_ids: ['src-1'],
      confidence: 'reported',
      micro_poll: { prompt: 'Does the first fact change your answer?', re_ask_slider: true },
    },
    {
      id: 'two',
      order: 2,
      headline: 'The second headline.',
      body: 'The second body.',
      depth: [],
      source_ids: ['src-1'],
      confidence: 'disputed',
      micro_poll: { prompt: 'And this one?', re_ask_slider: true },
    },
  ],
  sides: [
    { id: 'yes', label: 'It matters', steelman: 'The case for yes.' },
    { id: 'no', label: 'It does not', steelman: 'The case for no.' },
  ],
  open_questions: ['What is still unknown?'],
  sources: [SOURCE],
};

function makeServices(): DiveServices & { share: jest.Mock; openUrl: jest.Mock; copy: jest.Mock } {
  return {
    openUrl: jest.fn(),
    share: jest.fn(async () => ({ status: 'shared' as const })),
    copy: jest.fn(async () => undefined),
  };
}

async function renderFlow(api: FakeApi, services = makeServices(), d: PublicCase = doc) {
  await render(
    <DiveFlow
      api={api}
      slug={d.slug}
      deviceId="device-0123456789abcdef"
      shareBaseUrl="https://dive.test"
      services={services}
    />,
  );
  await screen.findByTestId(testIds.caseCard);
  return services;
}

const press = (id: string) => fireEvent.press(screen.getByTestId(id));

async function nudge(action: 'increment' | 'decrement', times: number) {
  for (let i = 0; i < times; i++) {
    await fireEvent(screen.getByTestId(testIds.slider), 'accessibilityAction', { nativeEvent: { actionName: action } });
  }
}

const sliderValue = () => screen.getByTestId(testIds.sliderValue).props.children;
const calls = (api: FakeApi, method: string) => api.calls.filter((c) => c.method === method);

describe('DiveFlow', () => {
  it('plays the whole dive and keeps the crowd hidden until each answer is committed', async () => {
    const api = createFakeApi([doc]);
    const services = await renderFlow(api);

    // 1. Case card
    expect(screen.getByText('A tiny test case')).toBeOnTheScreen();
    expect(screen.getByText('How much does the test question matter?')).toBeOnTheScreen();
    await press(testIds.next);

    // 2. Starting facts
    await screen.findByTestId(testIds.startingFacts);
    expect(calls(api, 'startSession')).toHaveLength(1);
    expect(screen.getByText('The baseline fact.')).toBeOnTheScreen();
    expect(screen.getByText('Established')).toBeOnTheScreen();
    await press(testIds.next);

    // 3. Before: commit locks the answer
    expect(screen.getByTestId(testIds.beforeScreen)).toBeOnTheScreen();
    expect(sliderValue()).toBe(50);
    await nudge('increment', 8);
    expect(sliderValue()).toBe(90);
    await press(testIds.pollCommit);
    await screen.findByTestId(testIds.lockedNote);
    expect(screen.getByTestId(testIds.slider)).toBeDisabled();
    await nudge('decrement', 2);
    expect(sliderValue()).toBe(90);
    await press(testIds.next);

    // 4. First step: nothing about the crowd before commit
    await screen.findByTestId(testIds.stepScreen);
    expect(screen.getByText('The first headline.')).toBeOnTheScreen();
    expect(screen.getByText('Does the first fact change your answer?')).toBeOnTheScreen();
    expect(sliderValue()).toBe(90); // pre-filled at the last answer
    expect(screen.queryByTestId(testIds.reveal)).toBeNull();
    expect(screen.queryByTestId(testIds.crowdChart)).toBeNull();
    expect(screen.queryByTestId(testIds.next)).toBeNull();
    expect(calls(api, 'getReveal')).toHaveLength(0);

    await press(testIds.goDeeper);
    expect(screen.getByTestId('depth-layer-ctx')).toBeOnTheScreen();
    expect(screen.getByText('Context body.')).toBeOnTheScreen();

    // 5. Flag this fact
    await press(testIds.flagLink);
    await press('flag-reason-cherry_picked');
    await fireEvent.changeText(screen.getByTestId(testIds.flagNote), 'Leaves out the other study.');
    await press(testIds.flagSubmit);
    await screen.findByTestId(testIds.flagThanks);
    expect(calls(api, 'flagFact')[0]!.args).toEqual([
      'session-1',
      'one',
      'cherry_picked',
      'Leaves out the other study.',
    ]);
    await press(testIds.flagCancel);
    expect(screen.queryByTestId(testIds.flagSheet)).toBeNull();

    await nudge('decrement', 3);
    await press(testIds.pollCommit);
    const reveal = await screen.findByTestId(testIds.reveal);
    expect(within(reveal).getByText('You moved from 90 to 75.')).toBeOnTheScreen();
    expect(within(reveal).getByTestId(testIds.crowdChart)).toBeOnTheScreen();
    expect(within(reveal).getByTestId(testIds.seededNote)).toBeOnTheScreen();
    expect(within(reveal).getByText(/41% of readers moved here/)).toBeOnTheScreen();
    await press(testIds.next);

    // Second step: hidden again until commit; not moving is mirrored too
    await screen.findByText('The second headline.');
    expect(screen.queryByTestId(testIds.reveal)).toBeNull();
    expect(screen.queryByTestId(testIds.goDeeper)).toBeNull(); // no depth layers
    expect(screen.getByTestId(testIds.flagLink)).toBeOnTheScreen();
    await press(testIds.pollCommit);
    expect(await screen.findByText("This didn't move you.")).toBeOnTheScreen();

    // Going back shows the committed step with its reveal, and the answer stays locked
    await press(testIds.back);
    await screen.findByText('The first headline.');
    expect(screen.getByText('You moved from 90 to 75.')).toBeOnTheScreen();
    expect(screen.getByTestId(testIds.slider)).toBeDisabled();
    expect(screen.queryByTestId(testIds.pollCommit)).toBeNull();
    await press(testIds.next);
    await screen.findByText('The second headline.');
    await press(testIds.next);

    // 6. After
    expect(screen.getByTestId(testIds.afterScreen)).toBeOnTheScreen();
    expect(sliderValue()).toBe(75);
    await nudge('decrement', 1);
    await press(testIds.pollCommit);
    await screen.findByTestId(testIds.lockedNote);
    await press(testIds.next);

    // 7. Final reveal
    const final = await screen.findByTestId(testIds.finalReveal);
    expect(within(final).getByText('You moved from 90 to 70.')).toBeOnTheScreen();
    expect(within(final).getByTestId(testIds.finalChart)).toBeOnTheScreen();
    expect(within(screen.getByTestId(testIds.topStepYou)).getByText('The first headline.')).toBeOnTheScreen();
    expect(within(screen.getByTestId(testIds.topStepCrowd)).getByText('The second headline.')).toBeOnTheScreen();
    expect(screen.getByText('What is still unknown?')).toBeOnTheScreen();
    expect(screen.getByText('The case for yes.')).toBeOnTheScreen();
    expect(screen.getByText('The case for no.')).toBeOnTheScreen();

    await press('fairness-side-no');
    await press('fairness-rating-somewhat_fair');
    await press(testIds.fairnessSubmit);
    await screen.findByTestId(testIds.fairnessThanks);
    expect(calls(api, 'rateFairness')[0]!.args).toEqual(['session-1', 'no', 'somewhat_fair']);
    await press(testIds.next);

    // 8. Share card
    const card = await screen.findByTestId(testIds.shareCard);
    expect(within(card).getByText('I started at 90.\nI ended at 70.')).toBeOnTheScreen();
    expect(within(card).getByText('Find where you break.')).toBeOnTheScreen();
    expect(within(card).getByText('https://dive.test/case/tiny-case')).toBeOnTheScreen();
    await press(testIds.shareButton);
    expect(await screen.findByText('Shared.')).toBeOnTheScreen();
    expect(services.share).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'I started at 90. I ended at 70. Find where you break. https://dive.test/case/tiny-case',
        card: expect.objectContaining({ before: 90, after: 70, url: 'https://dive.test/case/tiny-case' }),
      }),
    );

    // Reveals only ever came back from commits; every answer went in order, once
    expect(calls(api, 'getReveal')).toHaveLength(0);
    expect(calls(api, 'submit').map((c) => [c.args[1], c.args[2]])).toEqual([
      ['before', 90],
      ['one', 75],
      ['two', 75],
      ['after', 70],
    ]);
  });

  it('requires the content warning to be acknowledged before starting', async () => {
    const warned = { ...doc, content_warning: 'This test case describes something upsetting.' };
    const api = createFakeApi([warned]);
    await renderFlow(api, makeServices(), warned);

    expect(screen.getByText('This test case describes something upsetting.')).toBeOnTheScreen();
    expect(screen.getByTestId(testIds.next)).toBeDisabled();
    await press(testIds.next);
    expect(calls(api, 'startSession')).toHaveLength(0);

    await press(testIds.contentWarningAck);
    expect(screen.getByTestId(testIds.next)).toBeEnabled();
    await press(testIds.next);
    await screen.findByTestId(testIds.startingFacts);
  });

  it('resumes a device session at the first unanswered question with answers locked', async () => {
    const api = createFakeApi([doc]);
    const first = await api.startSession(doc.id, doc.version, 'device-0123456789abcdef');
    await api.submit(first.session_id, 'before', 80);
    await api.submit(first.session_id, 'one', 60);
    api.calls.length = 0;

    await renderFlow(api);
    await press(testIds.next);
    await screen.findByText('The second headline.');
    expect(screen.getByTestId(testIds.notice)).toBeOnTheScreen();
    expect(sliderValue()).toBe(60);
    expect(screen.queryByTestId(testIds.reveal)).toBeNull();
    expect(calls(api, 'getReveal')).toHaveLength(0);
  });

  it('takes a device that already finished straight to its final reveal', async () => {
    const api = createFakeApi([doc]);
    const first = await api.startSession(doc.id, doc.version, 'device-0123456789abcdef');
    for (const [slot, value] of [
      ['before', 40],
      ['one', 45],
      ['two', 55],
      ['after', 60],
    ] as const) {
      await api.submit(first.session_id, slot, value);
    }
    api.calls.length = 0;

    await renderFlow(api);
    await press(testIds.next);
    const final = await screen.findByTestId(testIds.finalReveal);
    expect(within(final).getByText('You moved from 40 to 60.')).toBeOnTheScreen();
    expect(calls(api, 'getReveal').map((c) => c.args[1])).toEqual(['after']);
  });

  it('notes when a revision replaced an earlier version others saw', async () => {
    const api = createFakeApi([doc], {
      versionNote: {
        version: 2,
        published_at: '2026-10-12T09:00:00Z',
        parent_version: 1,
        earlier_versions: [{ version: 1, published_at: '2026-10-01T09:00:00Z', completions: 3104 }],
      },
    });
    await renderFlow(api);
    await press(testIds.next);
    await screen.findByTestId(testIds.startingFacts);
    await press(testIds.next);
    await press(testIds.pollCommit);
    await screen.findByTestId(testIds.lockedNote);
    await press(testIds.next);
    await screen.findByTestId(testIds.stepScreen);
    expect(screen.queryByTestId(testIds.versionNote)).toBeNull();
    await press(testIds.pollCommit);
    const note = await screen.findByTestId(testIds.versionNote);
    expect(note).toHaveTextContent('Updated Oct 12; 3,104 people saw the earlier version.');
  });

  it('shows a plain message for an unknown case', async () => {
    const api = createFakeApi([doc]);
    await render(
      <DiveFlow
        api={api}
        slug="no-such-case"
        deviceId="device-0123456789abcdef"
        shareBaseUrl="https://dive.test"
        services={makeServices()}
      />,
    );
    expect(await screen.findByTestId(testIds.notFound)).toBeOnTheScreen();
  });
});
