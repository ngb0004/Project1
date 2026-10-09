import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { assertValidCase, type Case, type PublicCase } from '@sia/case-schema';
import type { DiveApi } from '@sia/dive-engine';
import { DiveFlow, depthLayerId, steelmanId, takeId, testIds, voteOptionId } from '@sia/dive-ui';

/** The full case documents in /cases/fixtures (with admin-only fields). */
export function loadFixtures(): Case[] {
  const dir = join(__dirname, '../../../cases/fixtures');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => assertValidCase(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
const nudge = (action: 'increment' | 'decrement') =>
  fireEvent(screen.getByTestId(testIds.slider), 'accessibilityAction', { nativeEvent: { actionName: action } });

/**
 * Plays a whole dive through the UI using only what the case record says, and
 * checks every screen along the way. Nothing here knows which case it plays.
 */
export async function playThrough(api: DiveApi, doc: PublicCase, deviceId = 'device-fixture-0123456789') {
  const share = jest.fn(async () => ({ status: 'shared' as const }));
  await render(
    <DiveFlow
      api={api}
      slug={doc.slug}
      deviceId={deviceId}
      shareBaseUrl="https://dive.test"
      services={{ openUrl: jest.fn(), share }}
    />,
  );

  await screen.findByTestId(testIds.caseCard);
  expect(screen.getByText(doc.title)).toBeOnTheScreen();
  if (doc.content_warning) {
    expect(screen.getByText(doc.content_warning)).toBeOnTheScreen();
    expect(screen.getByTestId(testIds.next)).toBeDisabled();
    await press(testIds.contentWarningAck);
  } else {
    expect(screen.queryByTestId(testIds.contentWarning)).toBeNull();
  }
  await press(testIds.next);

  await screen.findByTestId(testIds.startingFacts);
  for (const fact of doc.starting_facts) expect(screen.getByText(fact.text)).toBeOnTheScreen();
  await press(testIds.next);

  expect(screen.getByText(doc.question.prompt)).toBeOnTheScreen();
  expect(screen.getByText(doc.question.scale.left_label)).toBeOnTheScreen();
  expect(screen.getByText(doc.question.scale.right_label)).toBeOnTheScreen();
  await nudge('increment');
  await press(testIds.pollCommit);
  await screen.findByTestId(testIds.lockedNote);
  await press(testIds.next);

  const reveals = [];
  for (const [i, step] of doc.steps.entries()) {
    await screen.findByText(step.headline);
    expect(screen.getByText(step.body)).toBeOnTheScreen();
    expect(screen.getByText(step.micro_poll.statement)).toBeOnTheScreen();
    expect(screen.getByTestId(testIds.flagLink)).toBeOnTheScreen();
    expect(screen.queryByTestId(testIds.reveal)).toBeNull();
    expect(screen.queryByTestId(testIds.crowdChart)).toBeNull();
    if (step.depth.length > 0) {
      await press(testIds.goDeeper);
      for (const layer of step.depth) expect(screen.getByTestId(depthLayerId(layer.id))).toBeOnTheScreen();
    } else {
      expect(screen.queryByTestId(testIds.goDeeper)).toBeNull();
    }
    // Nothing is picked yet, so there is nothing to lock in.
    expect(screen.getByTestId(testIds.pollCommit)).toBeDisabled();
    await press(voteOptionId(['agree', 'unsure', 'disagree'][i % 3]!));
    await press(testIds.pollCommit);
    const reveal = await screen.findByTestId(testIds.reveal);
    expect(within(reveal).getByTestId(testIds.mirror)).toBeOnTheScreen();
    reveals.push(reveal);
    await press(testIds.next);
  }

  if (doc.timeline.length > 0) {
    await screen.findByTestId(testIds.timelineScreen);
    for (const e of doc.timeline) expect(screen.getByText(e.text)).toBeOnTheScreen();
    await press(testIds.next);
  }

  if (doc.takes.length > 0) {
    await screen.findByTestId(testIds.takesScreen);
    for (const t of doc.takes) {
      const take = screen.getByTestId(takeId(t.id));
      expect(within(take).getByText(t.summary)).toBeOnTheScreen();
      for (const c of t.checks) expect(within(take).getByText(c.claim)).toBeOnTheScreen();
    }
    await press(testIds.next);
  }

  await screen.findByTestId(testIds.afterScreen);
  await press(testIds.pollCommit);
  await screen.findByTestId(testIds.lockedNote);
  await press(testIds.next);

  await screen.findByTestId(testIds.finalReveal);
  for (const side of doc.sides) {
    const card = screen.getByTestId(steelmanId(side.id));
    expect(within(card).getByText(side.label)).toBeOnTheScreen();
    expect(within(card).getByText(side.steelman)).toBeOnTheScreen();
  }
  for (const q of doc.open_questions) expect(screen.getByText(q)).toBeOnTheScreen();
  await press(testIds.next);

  const card = await screen.findByTestId(testIds.shareCard);
  expect(within(card).getByText(`https://dive.test/case/${doc.slug}`)).toBeOnTheScreen();
  return { card, share };
}
