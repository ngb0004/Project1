import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { JsonElement, JsonNode } from 'test-renderer';
import type { Case } from '@sia/case-schema';
import { buildScreens, mirrorText, shareHeadline, type ScreenKind } from '@sia/dive-engine';
import { LocalDiveApi } from '@sia/dive-engine/local';
import { DiveFlow, depthLayerId, steelmanId, testIds } from '@sia/dive-ui';
import { loadFixtures } from './playThrough';

/**
 * Phase 2 acceptance on the native renderer: both fixture files play through
 * the same DiveFlow against LocalDiveApi with a seeded crowd. Nothing below
 * knows which case it is playing; every expectation is read from the record.
 */

const fixtures = loadFixtures();

/** A seed profile built from the step ids alone, so every step has a seeded crowd. */
const seedProfile = (doc: Case) => ({
  sessions: 150,
  before_bins: [1, 1, 2, 3, 5, 6, 7, 5, 3, 2],
  steps: Object.fromEntries(
    doc.steps.map((s, i) => [s.id, { move_share: 0.5, mean_shift: i % 2 ? -10 : 8, spread: 5 }]),
  ),
  after: { move_share: 0.3, mean_shift: -3, spread: 4 },
  rng_seed: 11,
});

/** Generic reveal copy (dive-ui and dive-engine): none of it may show before a commit. */
const CROWD_TEXT =
  /Everyone who reached|(readers|crowd) moved|held steady|seeded|No readers yet|\d+ readers?\b|You moved from|didn't move you|did not move|Everyone, (before|after)|moved everyone most|went from|stayed at|Your answers, from first/;

/** Every string a reader (or a screen reader) can get from the current tree. */
function renderedStrings(): string[] {
  const out: string[] = [];
  const walk = (node: JsonNode) => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    for (const key of ['accessibilityLabel', 'accessibilityHint', 'aria-label', 'placeholder']) {
      const v = node.props[key];
      if (typeof v === 'string') out.push(v);
    }
    node.children?.forEach(walk);
  };
  const json = screen.toJSON() as JsonElement | JsonElement[] | null;
  if (json) (Array.isArray(json) ? json : [json]).forEach(walk);
  return out;
}

/**
 * Strings that exist only in the admin-only fields of the record (favors,
 * impact, evidence). A value that also appears somewhere in the public
 * projection (a side id that is also a word in a label, say) is still checked
 * as a whole text node, which is how a leaked field would render.
 */
function adminOnlyStrings(doc: Case) {
  const values = new Set<string>();
  for (const s of doc.steps) {
    if (s.favors) values.add(s.favors);
    if (s.impact) values.add(s.impact);
    for (const e of s.evidence ?? []) values.add(e.quote);
  }
  for (const f of doc.starting_facts) for (const e of f.evidence ?? []) values.add(e.quote);
  return [...values];
}

function assertNoAdminText(doc: Case, publicJson: string, seen: string[]) {
  for (const value of adminOnlyStrings(doc)) {
    for (const text of seen) {
      expect(text.trim()).not.toBe(value);
      if (!publicJson.includes(value)) expect(text).not.toContain(value);
    }
  }
}

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
const nudge = (action: 'increment' | 'decrement') =>
  fireEvent(screen.getByTestId(testIds.slider), 'accessibilityAction', { nativeEvent: { actionName: action } });
const sliderValue = () => Number(screen.getByTestId(testIds.sliderValue).props.children);

function expectNoCrowd() {
  expect(screen.queryByTestId(testIds.reveal)).toBeNull();
  expect(screen.queryByTestId(testIds.crowdChart)).toBeNull();
  expect(screen.queryByTestId(testIds.crowdSummary)).toBeNull();
  expect(screen.queryByTestId(testIds.mirror)).toBeNull();
  expect(screen.queryByTestId(testIds.finalReveal)).toBeNull();
  expect(screen.queryByTestId(testIds.finalChart)).toBeNull();
  expect(renderedStrings().filter((t) => CROWD_TEXT.test(t))).toEqual([]);
}

const SCREEN_TEST_ID: Record<ScreenKind, string> = {
  case_card: testIds.caseCard,
  starting_facts: testIds.startingFacts,
  before: testIds.beforeScreen,
  step: testIds.stepScreen,
  after: testIds.afterScreen,
  final: testIds.finalScreen,
  share: testIds.shareScreen,
};

/** Which screen of the fixed sequence is showing. */
function currentKind(): ScreenKind {
  const kinds = (Object.keys(SCREEN_TEST_ID) as ScreenKind[]).filter(
    (k) => screen.queryByTestId(SCREEN_TEST_ID[k]) !== null,
  );
  expect(kinds).toHaveLength(1);
  return kinds[0]!;
}

const stepScreensRendered: Record<string, number> = {};

it('has two fixture files that differ in shape', () => {
  expect(fixtures).toHaveLength(2);
  const [a, b] = fixtures as [Case, Case];
  expect(a.steps.length).not.toBe(b.steps.length);
  expect(a.sides.length).not.toBe(b.sides.length);
  expect(Boolean(a.content_warning)).not.toBe(Boolean(b.content_warning));
});

describe.each(fixtures.map((d) => [d.slug, d] as const))('%s', (_slug, doc) => {
  it('plays the full flow with a seeded crowd, hiding each crowd result until commit', async () => {
    // Like the database, the API holds the full record and serves only its public projection.
    const api = new LocalDiveApi({ cases: [{ doc, seedProfile: seedProfile(doc) }] });
    const getReveal = jest.spyOn(api, 'getReveal');
    const share = jest.fn(async () => ({ status: 'shared' as const }));
    const deviceId = `device-acceptance-${doc.slug}`;
    const loaded = await api.getCase(doc.slug);
    const publicJson = JSON.stringify(loaded!.doc);
    expect(publicJson).not.toMatch(/"(favors|impact|evidence|review)"/);

    await render(
      <DiveFlow
        api={api}
        slug={doc.slug}
        deviceId={deviceId}
        shareBaseUrl="https://dive.test"
        services={{ openUrl: jest.fn(), share }}
      />,
    );

    const seen: string[] = [];
    const visited: ScreenKind[] = [];
    const arrive = async (testID: string) => {
      await screen.findByTestId(testID);
      visited.push(currentKind());
      seen.push(...renderedStrings());
    };

    // Case card: title and question from the record; the content warning gates Begin.
    await arrive(testIds.caseCard);
    expect(screen.getByText(doc.title)).toBeOnTheScreen();
    expect(screen.getByText(doc.question.prompt)).toBeOnTheScreen();
    if (doc.content_warning) {
      expect(screen.getByText(doc.content_warning)).toBeOnTheScreen();
      expect(screen.getByTestId(testIds.next)).toBeDisabled();
      await press(testIds.contentWarningAck);
    } else {
      expect(screen.queryByTestId(testIds.contentWarning)).toBeNull();
    }
    expectNoCrowd();
    await press(testIds.next);

    // Starting facts.
    await arrive(testIds.startingFacts);
    for (const fact of doc.starting_facts) expect(screen.getByText(fact.text)).toBeOnTheScreen();
    expectNoCrowd();
    await press(testIds.next);

    // Before: commit locks it for good.
    await arrive(testIds.beforeScreen);
    expectNoCrowd();
    for (let i = 0; i < 4; i++) await nudge('increment');
    const before = sliderValue();
    expect(before).toBe(70);
    await press(testIds.pollCommit);
    await screen.findByTestId(testIds.lockedNote);
    expect(screen.queryByTestId(testIds.pollCommit)).toBeNull();
    expect(screen.getByTestId(testIds.slider)).toBeDisabled();
    await nudge('decrement');
    expect(sliderValue()).toBe(before);
    expectNoCrowd(); // Before has no crowd reveal of its own.
    await press(testIds.next);

    let previous = before;
    for (const [i, step] of doc.steps.entries()) {
      await arrive(testIds.stepScreen);
      expect(screen.getByText(step.headline)).toBeOnTheScreen();
      expect(screen.getByText(step.body)).toBeOnTheScreen();
      expect(screen.getByText(step.micro_poll.prompt)).toBeOnTheScreen();
      expect(screen.getByText(`Fact ${i + 1} of ${doc.steps.length}`)).toBeOnTheScreen();
      expect(sliderValue()).toBe(previous); // pre-filled at the last answer
      expect(screen.queryByTestId(testIds.next)).toBeNull(); // no skipping an unanswered poll

      if (step.depth.length > 0) {
        await press(testIds.goDeeper);
        for (const layer of step.depth) expect(screen.getByTestId(depthLayerId(layer.id))).toBeOnTheScreen();
        seen.push(...renderedStrings());
      }
      await press(testIds.flagLink);
      expect(within(screen.getByTestId(testIds.flagSheet)).getByText(step.headline)).toBeOnTheScreen();
      seen.push(...renderedStrings());
      await press(testIds.flagCancel);

      if (i === 0) {
        // Going back shows the Before answer still locked.
        await press(testIds.back);
        await screen.findByTestId(testIds.beforeScreen);
        expect(sliderValue()).toBe(before);
        expect(screen.getByTestId(testIds.slider)).toBeDisabled();
        expect(screen.queryByTestId(testIds.pollCommit)).toBeNull();
        await nudge('increment');
        expect(sliderValue()).toBe(before);
        await press(testIds.next);
        await screen.findByText(step.headline);
      }

      // Before commit: no crowd result of any kind.
      expectNoCrowd();
      await nudge(i % 2 ? 'decrement' : 'increment');
      const value = sliderValue();
      expectNoCrowd();
      await press(testIds.pollCommit);

      // After commit: the personal mirror and the crowd's shift chart.
      const reveal = await screen.findByTestId(testIds.reveal);
      expect(within(reveal).getByTestId(testIds.mirror)).toHaveTextContent(mirrorText(previous, value));
      expect(within(reveal).getByTestId(testIds.crowdChart)).toBeOnTheScreen();
      expect(within(reveal).getByTestId(testIds.crowdSummary)).toBeOnTheScreen();
      expect(within(reveal).getByTestId(testIds.seededNote)).toBeOnTheScreen();
      expect(within(reveal).getByText('Everyone who reached this fact')).toBeOnTheScreen();
      expect(screen.getByTestId(testIds.slider)).toBeDisabled();
      expect(renderedStrings().filter((t) => CROWD_TEXT.test(t)).length).toBeGreaterThan(3);
      seen.push(...renderedStrings());
      previous = value;
      await press(testIds.next);
    }

    // After: same question; nothing about the crowd until it is locked.
    await arrive(testIds.afterScreen);
    expect(screen.getByText(doc.question.prompt)).toBeOnTheScreen();
    expect(sliderValue()).toBe(previous);
    expectNoCrowd();
    for (let i = 0; i < 3; i++) await nudge('decrement');
    const after = sliderValue();
    await press(testIds.pollCommit);
    await screen.findByTestId(testIds.lockedNote);
    await press(testIds.next);

    // Final reveal: the path over the crowd, top steps, open questions and steelmen.
    await arrive(testIds.finalScreen);
    const final = await screen.findByTestId(testIds.finalReveal);
    expect(within(final).getByTestId(testIds.mirror)).toHaveTextContent(mirrorText(before, after));
    expect(within(final).getByTestId(testIds.finalChart)).toBeOnTheScreen();
    expect(within(final).getByTestId(testIds.seededNote)).toBeOnTheScreen();
    const stepHeadlines = doc.steps.map((s) => s.headline);
    for (const id of [testIds.topStepYou, testIds.topStepCrowd]) {
      const top = within(screen.getByTestId(id));
      expect(stepHeadlines.some((h) => top.queryByText(h) !== null)).toBe(true);
    }
    for (const q of doc.open_questions) expect(screen.getByText(q)).toBeOnTheScreen();
    for (const side of doc.sides) {
      expect(within(screen.getByTestId(steelmanId(side.id))).getByText(side.steelman)).toBeOnTheScreen();
    }
    seen.push(...renderedStrings());
    await press(testIds.next);

    // Share card: the personal shift, a small crowd distribution and the deep link.
    await arrive(testIds.shareScreen);
    const card = screen.getByTestId(testIds.shareCard);
    expect(within(card).getByText(shareHeadline(before, after).replace('. ', '.\n'))).toBeOnTheScreen();
    expect(within(card).getByText(`https://dive.test/case/${doc.slug}`)).toBeOnTheScreen();
    expect(within(card).getByText('Crowd includes seeded estimates.')).toBeOnTheScreen();
    await press(testIds.shareButton);
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]).toEqual([
      expect.objectContaining({ card: expect.objectContaining({ before, after }), view: expect.anything() }),
    ]);
    seen.push(...renderedStrings());

    // The fixed sequence, driven by the record alone.
    expect(visited).toEqual(buildScreens(doc).map((s) => s.kind));
    stepScreensRendered[doc.slug] = visited.filter((k) => k === 'step').length;
    expect(stepScreensRendered[doc.slug]).toBe(doc.steps.length);

    // No reveal was ever fetched for a slot that had not been answered.
    expect(getReveal).not.toHaveBeenCalled();

    // Every answer is locked server-side too: a second submit returns the stored value.
    const session = await api.startSession(loaded!.case_id, loaded!.version, deviceId);
    expect(session.completed).toBe(true);
    expect(session.answers[0]).toEqual({ step_id: 'before', value: before });
    const again = await api.submit(session.session_id, 'before', before === 0 ? 100 : 0);
    expect(again).toMatchObject({ step_id: 'before', value: before, locked: true });

    // Admin-only fields (favors, impact, evidence) never reach the screen.
    assertNoAdminText(doc, publicJson, seen);
  });
});

it('rendered a different number of step screens for each case with the same code', () => {
  const counts = fixtures.map((d) => stepScreensRendered[d.slug]);
  expect(counts).toEqual(fixtures.map((d) => d.steps.length));
  expect(new Set(counts).size).toBe(fixtures.length);
});
