import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { PublicCase } from '@sia/case-schema';
import { DiveApiError, inviteText, shareCardData, type FinalReveal } from '@sia/dive-engine';
import { DiveFlow, ShareCard, testIds, type DiveProgressStore, type DiveServices } from '@sia/dive-ui';
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
      micro_poll: { statement: 'The first fact matters.' },
    },
    {
      id: 'two',
      order: 2,
      headline: 'The second headline.',
      body: 'The second body.',
      depth: [],
      source_ids: ['src-1'],
      confidence: 'disputed',
      micro_poll: { statement: 'The second fact matters.' },
    },
  ],
  sides: [
    { id: 'yes', label: 'It matters', steelman: 'The case for yes.' },
    { id: 'no', label: 'It does not', steelman: 'The case for no.' },
  ],
  timeline: [],
  takes: [],
  open_questions: ['What is still unknown?'],
  sources: [SOURCE],
};

function makeServices(): DiveServices & { share: jest.Mock; openUrl: jest.Mock; copy: jest.Mock } {
  return {
    openUrl: jest.fn(),
    share: jest.fn(async () => ({ status: 'shared' as const })),
    copy: jest.fn(async () => true),
  };
}

async function renderFlow(
  api: FakeApi,
  services: DiveServices = makeServices(),
  d: PublicCase = doc,
  shareBaseUrl: string | null = 'https://dive.test',
) {
  await render(
    <DiveFlow
      api={api}
      slug={d.slug}
      deviceId="device-0123456789abcdef"
      shareBaseUrl={shareBaseUrl}
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

    // 2. Starting facts (the heading claims nothing the record's confidence labels might contradict)
    await screen.findByTestId(testIds.startingFacts);
    expect(calls(api, 'startSession')).toHaveLength(1);
    expect(screen.getByText('Where things stand')).toBeOnTheScreen();
    expect(screen.getByText('The baseline fact.')).toBeOnTheScreen();
    expect(screen.getByText('Confirmed')).toBeOnTheScreen();
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
    expect(screen.getByText('The first fact matters.')).toBeOnTheScreen();
    expect(screen.queryByTestId(testIds.slider)).toBeNull(); // a fact gets a vote, not the slider
    expect(screen.getByTestId(testIds.pollCommit)).toBeDisabled(); // nothing picked yet
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

    await press('vote-agree');
    await press('vote-disagree'); // can change the pick until it is locked in
    expect(calls(api, 'submit')).toHaveLength(1); // only the Before answer so far
    await press(testIds.pollCommit);
    const reveal = await screen.findByTestId(testIds.reveal);
    expect(within(reveal).getByText('You disagreed, like 37% of readers.')).toBeOnTheScreen();
    expect(within(reveal).getByTestId(testIds.crowdChart)).toBeOnTheScreen();
    expect(within(reveal).getByTestId(testIds.seededNote)).toBeOnTheScreen();
    expect(calls(api, 'submit')[1]!.args).toEqual(['session-1', 'one', 0]);
    await press(testIds.next);

    // Second step: hidden again until commit
    await screen.findByText('The second headline.');
    expect(screen.queryByTestId(testIds.reveal)).toBeNull();
    expect(screen.queryByTestId(testIds.goDeeper)).toBeNull(); // no depth layers
    expect(screen.getByTestId(testIds.flagLink)).toBeOnTheScreen();
    await press('vote-unsure');
    await press(testIds.pollCommit);
    expect(await screen.findByText("You weren't sure, like 22% of readers.")).toBeOnTheScreen();

    // Going back shows the committed step with its reveal, and the answer stays locked
    await press(testIds.back);
    await screen.findByText('The first headline.');
    expect(screen.getByText('You disagreed, like 37% of readers.')).toBeOnTheScreen();
    expect(screen.getByTestId('vote-agree')).toBeDisabled();
    expect(screen.queryByTestId(testIds.pollCommit)).toBeNull();
    await press(testIds.next);
    await screen.findByText('The second headline.');
    await press(testIds.next);

    // 6. After
    expect(screen.getByTestId(testIds.afterScreen)).toBeOnTheScreen();
    expect(sliderValue()).toBe(90); // starts where Before ended: the fact votes do not move it
    await nudge('decrement', 4);
    await press(testIds.pollCommit);
    await screen.findByTestId(testIds.lockedNote);
    await press(testIds.next);

    // 7. Final reveal
    const final = await screen.findByTestId(testIds.finalReveal);
    expect(within(final).getByText('You moved from 90 to 70.')).toBeOnTheScreen();
    expect(within(final).getByTestId(testIds.finalChart)).toBeOnTheScreen();
    // the fake crowd split most on the last fact; the reader disagreed on the first, where 80% agreed
    expect(within(screen.getByTestId(testIds.mostSplit)).getByText('The second headline.')).toBeOnTheScreen();
    expect(within(screen.getByTestId(testIds.standApart)).getByText('The first headline.')).toBeOnTheScreen();
    expect(within(screen.getByTestId(testIds.standApart)).getByText('You said disagree. 80% of the crowd said agree.')).toBeOnTheScreen();
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
    expect(within(card).getByText('https://dive.test/s/tiny-case?b=90&a=70')).toBeOnTheScreen();
    await press(testIds.shareButton);
    expect(await screen.findByText('Shared.')).toBeOnTheScreen();
    expect(services.share).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'I started at 90. I ended at 70. Find where you break. https://dive.test/s/tiny-case?b=90&a=70',
        card: expect.objectContaining({ before: 90, after: 70, url: 'https://dive.test/s/tiny-case?b=90&a=70' }),
      }),
    );

    // Reveals only ever came back from commits; every answer went in order, once
    expect(calls(api, 'getReveal')).toHaveLength(0);
    expect(calls(api, 'submit').map((c) => [c.args[1], c.args[2]])).toEqual([
      ['before', 90],
      ['one', 0],
      ['two', 50],
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
    await api.submit(first.session_id, 'one', 100);
    api.calls.length = 0;

    await renderFlow(api);
    await press(testIds.next);
    await screen.findByText('The second headline.');
    expect(screen.getByTestId(testIds.notice)).toBeOnTheScreen();
    expect(screen.getByTestId(testIds.pollCommit)).toBeDisabled(); // a fresh vote: nothing picked
    expect(screen.queryByTestId(testIds.reveal)).toBeNull();
    expect(calls(api, 'getReveal')).toHaveLength(0);
  });

  it('takes a device that already finished straight to its final reveal', async () => {
    const api = createFakeApi([doc]);
    const first = await api.startSession(doc.id, doc.version, 'device-0123456789abcdef');
    for (const [slot, value] of [
      ['before', 40],
      ['one', 0],
      ['two', 100],
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
    await press('vote-agree');
    await press(testIds.pollCommit);
    const note = await screen.findByTestId(testIds.versionNote);
    expect(note).toHaveTextContent('Updated Oct 12; 3,104 people saw the earlier version.');
  });

  it('greets a shared link with where the sharer started and ended', async () => {
    await render(
      <DiveFlow
        api={createFakeApi([doc])}
        slug={doc.slug}
        deviceId="device-0123456789abcdef"
        shareBaseUrl="https://dive.test"
        services={makeServices()}
        invite={{ before: 80, after: 30 }}
      />,
    );
    const invite = await screen.findByTestId(testIds.invite);
    const { left_label: left, right_label: right } = doc.question.scale;
    expect(within(invite).getByText(inviteText({ before: 80, after: 30 }, left, right))).toBeOnTheScreen();
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

/** Memory-backed progress store, as the app keeps in SecureStore / localStorage. */
function memoryStore(): DiveProgressStore & { data: Map<string, number> } {
  const data = new Map<string, number>();
  return {
    data,
    async get(slug) {
      return data.get(slug) ?? null;
    },
    async set(slug, version) {
      if (version === null) data.delete(slug);
      else data.set(slug, version);
    },
  };
}

/** Begins, locks Before at 50, lands on the first step and picks Agree (not yet locked in). */
async function startDive(api: FakeApi, services: DiveServices = makeServices()) {
  await renderFlow(api, services);
  await press(testIds.next);
  await screen.findByTestId(testIds.startingFacts);
  await press(testIds.next);
  await press(testIds.pollCommit);
  await screen.findByTestId(testIds.lockedNote);
  await press(testIds.next);
  await screen.findByText('The first headline.');
  await press('vote-agree');
}

describe('DiveFlow when a commit fails', () => {
  it.each([
    ['rate_limited', 'Too many answers from this network. Wait a minute and try again.'],
    ['network', "Couldn't reach the server. Check your connection and try again."],
  ] as const)('keeps the answer open and the crowd hidden after a %s error', async (code, message) => {
    const api = createFakeApi([doc]);
    await startDive(api);
    api.failNext('submit', new DiveApiError(code, 'refused'));
    await press(testIds.pollCommit);
    expect(await screen.findByTestId(testIds.error)).toHaveTextContent(message);
    expect(screen.queryByTestId(testIds.reveal)).toBeNull();
    expect(screen.queryByTestId(testIds.lockedNote)).toBeNull();
    expect(screen.queryByTestId(testIds.next)).toBeNull();
    expect(screen.queryByTestId(testIds.reload)).toBeNull();
    expect(screen.getByTestId(testIds.pollCommit)).toBeEnabled();
    expect(screen.getByTestId('vote-disagree')).toBeEnabled();

    // Trying again commits, and only now shows the crowd.
    await press(testIds.pollCommit);
    await screen.findByTestId(testIds.reveal);
    expect(calls(api, 'submit').map((c) => c.args[1])).toEqual(['before', 'one', 'one']);
  });

  it.each(['out_of_order', 'not_found'] as const)(
    'replaces Lock in with a reload after a %s error, which resyncs the session',
    async (code) => {
      const api = createFakeApi([doc]);
      await startDive(api);
      api.failNext('submit', new DiveApiError(code, 'refused'));
      await press(testIds.pollCommit);
      await screen.findByTestId(testIds.reload);
      expect(screen.queryByTestId(testIds.pollCommit)).toBeNull();
      expect(screen.queryByTestId(testIds.reveal)).toBeNull();
      expect(screen.getByTestId('vote-agree')).toBeDisabled();

      api.calls.length = 0;
      await press(testIds.reload);
      // Same version: the dive reloads and picks the session up at this step, without another Begin.
      await screen.findByText('The first headline.');
      expect(screen.getByTestId(testIds.notice)).toHaveTextContent(/Welcome back/);
      expect(calls(api, 'getCase')).toHaveLength(1);
      expect(calls(api, 'startSession')).toHaveLength(1);
      await press('vote-agree');
      expect(screen.getByTestId(testIds.pollCommit)).toBeEnabled();
      expect(screen.queryByTestId(testIds.reveal)).toBeNull();
    },
  );

  it('sends one answer when Lock in is pressed twice in a row', async () => {
    const api = createFakeApi([doc]);
    await startDive(api);
    // Two presses in the same tick, before React can re-render the button as disabled.
    const button = screen.getByTestId(testIds.pollCommit);
    const tap = () => button.props.onClick({ nativeEvent: {}, target: 1, currentTarget: 1, stopPropagation() {} });
    await act(async () => {
      tap();
      tap();
    });
    await screen.findByTestId(testIds.reveal);
    expect(calls(api, 'submit').map((c) => c.args[1])).toEqual(['before', 'one']);
  });
});

describe('DiveFlow across a revision', () => {
  it('finishes the version in progress when a revision is published mid-dive', async () => {
    const docs = [doc];
    const api = createFakeApi(docs);
    const services = { ...makeServices(), progress: memoryStore() };
    await startDive(api, services);
    expect(services.progress.data.get(doc.slug)).toBe(1);
    await screen.unmount();

    docs.push({ ...doc, version: 2 }); // v1 stays published
    await renderFlow(api, services);
    expect(screen.getByTestId(testIds.notice)).toHaveTextContent(
      'A newer version of this dive is out. You are finishing the version you started.',
    );
    await press(testIds.next);
    await screen.findByText('The first headline.');
    expect(screen.getByTestId(testIds.notice)).toHaveTextContent(/Welcome back/);
    expect(calls(api, 'startSession').at(-1)!.args[1]).toBe(1);
    expect(screen.queryByTestId(testIds.beforeScreen)).toBeNull();
  });

  it('says why it starts over when the version in progress was taken down', async () => {
    const docs = [doc];
    const api = createFakeApi(docs);
    const services = { ...makeServices(), progress: memoryStore() };
    await startDive(api, services);
    await screen.unmount();

    docs.splice(0, 1, { ...doc, version: 2 });
    await renderFlow(api, services);
    expect(screen.getByTestId(testIds.notice)).toHaveTextContent(/updated after you started it/);
    await press(testIds.next);
    await screen.findByTestId(testIds.startingFacts);
    expect(calls(api, 'startSession').at(-1)!.args[1]).toBe(2);
  });

  it('reloads onto the live version, with the same explanation, when a commit finds its version gone', async () => {
    const docs = [doc];
    const api = createFakeApi(docs);
    await startDive(api);
    docs.splice(0, 1, { ...doc, version: 2 });
    await press(testIds.pollCommit);
    expect(await screen.findByTestId(testIds.error)).toHaveTextContent('This version of the dive is no longer available.');
    await press(testIds.reload);
    await screen.findByTestId(testIds.caseCard);
    expect(screen.getByTestId(testIds.notice)).toHaveTextContent(/updated after you started it/);
    expect(calls(api, 'getCase').map((c) => c.args[1])).toEqual([undefined, 1, undefined]);
  });

  it('forgets the version once the dive is finished', async () => {
    const api = createFakeApi([doc]);
    const services = { ...makeServices(), progress: memoryStore() };
    await startDive(api, services);
    for (let i = 0; i < 2; i++) {
      if (i > 0) await press('vote-agree');
      await press(testIds.pollCommit);
      await screen.findByTestId(testIds.reveal);
      await press(testIds.next);
    }
    await screen.findByTestId(testIds.afterScreen);
    expect(services.progress.data.get(doc.slug)).toBe(1);
    await press(testIds.pollCommit);
    await screen.findByTestId(testIds.lockedNote);
    expect(services.progress.data.has(doc.slug)).toBe(false);
  });
});

describe('DiveFlow re-fetching reveals', () => {
  async function resumeAtStepTwo(api: FakeApi) {
    const first = await api.startSession(doc.id, doc.version, 'device-0123456789abcdef');
    await api.submit(first.session_id, 'before', 80);
    await api.submit(first.session_id, 'one', 100);
    api.calls.length = 0;
    await renderFlow(api);
    await press(testIds.next);
    await screen.findByText('The second headline.');
  }

  it('fetches the reveal of an answered step when the reader goes back to it', async () => {
    const api = createFakeApi([doc]);
    await resumeAtStepTwo(api);
    expect(calls(api, 'getReveal')).toHaveLength(0);
    await press(testIds.back);
    expect(await screen.findByText('You agreed, like 41% of readers.')).toBeOnTheScreen();
    expect(calls(api, 'getReveal').map((c) => c.args[1])).toEqual(['one']);
  });

  it('retries network failures with a growing pause, then offers Try again', async () => {
    jest.useFakeTimers();
    try {
      const api = createFakeApi([doc]);
      await resumeAtStepTwo(api);
      const down = () => new DiveApiError('network', 'offline');
      api.failNext('getReveal', down(), down(), down());
      await press(testIds.back);
      expect(screen.getByText('Loading what others said…')).toBeOnTheScreen();
      await screen.findByTestId(testIds.retry, {}, { timeout: 20000 });
      expect(calls(api, 'getReveal')).toHaveLength(3);
      expect(screen.getByTestId(testIds.error)).toHaveTextContent(/^Couldn't reach the server\./);
      await press(testIds.retry);
      expect(await screen.findByText('You agreed, like 41% of readers.')).toBeOnTheScreen();
      expect(calls(api, 'getReveal')).toHaveLength(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry an error that will not clear by itself', async () => {
    const api = createFakeApi([doc]);
    await resumeAtStepTwo(api);
    api.failNext('getReveal', new DiveApiError('gone', 'this case version is no longer published'));
    await press(testIds.back);
    await screen.findByTestId(testIds.reload);
    expect(calls(api, 'getReveal')).toHaveLength(1);
    expect(screen.getByTestId(testIds.error)).toHaveTextContent('This version of the dive is no longer available.');
  });
});

describe('ShareScreen', () => {
  async function playToShare(api: FakeApi, services: DiveServices, shareBaseUrl: string | null = 'https://dive.test') {
    await renderFlow(api, services, doc, shareBaseUrl);
    await press(testIds.next);
    await screen.findByTestId(testIds.startingFacts);
    await press(testIds.next);
    for (const screenId of [testIds.beforeScreen, testIds.stepScreen, testIds.stepScreen, testIds.afterScreen]) {
      await screen.findByTestId(screenId);
      if (screenId === testIds.stepScreen) await press('vote-unsure');
      await press(testIds.pollCommit);
      await screen.findByTestId(screenId === testIds.stepScreen ? testIds.reveal : testIds.lockedNote);
      await press(testIds.next);
    }
    await screen.findByTestId(testIds.finalReveal);
    await press(testIds.next);
    await screen.findByTestId(testIds.shareCard);
  }

  it('says nothing when the platform cannot tell a share from a cancel, and offers the image separately', async () => {
    const services = {
      ...makeServices(),
      share: jest.fn(async () => ({ status: 'opened' as const })),
      shareImage: jest.fn(async () => undefined),
    };
    await playToShare(createFakeApi([doc]), services);
    await press(testIds.shareButton);
    expect(services.share).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(testIds.shareStatus)).toBeNull();
    await press(testIds.shareImage);
    expect(services.shareImage).toHaveBeenCalledWith(expect.objectContaining({ card: expect.anything() }));
    expect(screen.queryByTestId(testIds.shareStatus)).toBeNull();
  });

  it('shows the link to copy by hand when the clipboard refuses', async () => {
    const services = { ...makeServices(), copy: jest.fn(async () => false) };
    await playToShare(createFakeApi([doc]), services);
    await press(testIds.copyLink);
    expect(await screen.findByTestId(testIds.shareStatus)).toHaveTextContent(/^Couldn't copy the link\./);
    expect(screen.getByTestId(testIds.shareUrl)).toHaveTextContent('https://dive.test/s/tiny-case?b=50&a=50');
    expect(screen.queryByText('Link copied.')).toBeNull();
  });

  it('leaves the link off when there is no public web origin', async () => {
    const services = makeServices();
    await playToShare(createFakeApi([doc]), services, null);
    const card = screen.getByTestId(testIds.shareCard);
    expect(within(card).queryByText(/dive:\/\/|https?:\/\//)).toBeNull();
    expect(screen.queryByTestId(testIds.copyLink)).toBeNull();
    await press(testIds.shareButton);
    expect(services.share).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'I started at 50. I ended at 50. Find where you break.' }),
    );
  });
});

describe('ShareCard', () => {
  it('draws no crowd chart when no completion is counted yet', async () => {
    const api = createFakeApi([doc]);
    const s = await api.startSession(doc.id, doc.version, 'device-share-card');
    let last;
    for (const slot of ['before', 'one', 'two', 'after']) last = await api.submit(s.session_id, slot, 50);
    const final = last as FinalReveal;
    const empty: FinalReveal = {
      ...final,
      crowd: { ...final.crowd, n_real: 0, n_seed: 0, mean_before: null, mean_after: null, after_histogram: Array(10).fill(0) },
    };
    await render(<ShareCard card={shareCardData(doc, empty, 'https://dive.test/case/tiny-case')} />);
    expect(screen.queryByText('Where everyone ended up')).toBeNull();
    expect(screen.getByText('https://dive.test/case/tiny-case')).toBeOnTheScreen();

    await render(<ShareCard card={shareCardData(doc, final, 'https://dive.test/case/tiny-case')} />);
    expect(screen.getByText('Where everyone ended up')).toBeOnTheScreen();
  });
});
