import { render, screen, within } from '@testing-library/react-native';
import { toPublicCase } from '@sia/case-schema';
import { isFinalReveal, slotsOf, type FinalReveal } from '@sia/dive-engine';
import { LocalDiveApi, computeFinalCrowd } from '@sia/dive-engine/local';
import { FinalRevealView, testIds } from '@sia/dive-ui';
import { loadFixtures } from './playThrough';

/**
 * Edge cases of the crowd in the final reveal, built with the real aggregates:
 * a crowd that agrees on everything, and a crowd with no completions (all-zero
 * histograms, no vote splits).
 */
const doc = toPublicCase(loadFixtures()[0]!);

/** One reader: Before 40, agrees with every fact, After 40. */
async function agreeingReveal(): Promise<FinalReveal> {
  const api = new LocalDiveApi({ cases: [{ doc }] });
  const session = await api.startSession(doc.id, doc.version, 'device-final-reveal-0001');
  let reveal;
  for (const slot of slotsOf(doc)) reveal = await api.submit(session.session_id, slot, slot === 'before' || slot === 'after' ? 40 : 100);
  if (!reveal || !isFinalReveal(reveal)) throw new Error('expected the final reveal');
  return reveal;
}

it('names the first fact as most split on a tie, and says the reader stood with the crowd', async () => {
  const reveal = await agreeingReveal();
  expect(reveal.crowd.most_split_step_id).toBe(doc.steps[0]!.id);
  await render(<FinalRevealView reveal={reveal} doc={doc} />);
  expect(within(screen.getByTestId(testIds.mostSplit)).getByText(doc.steps[0]!.headline)).toBeOnTheScreen();
  expect(within(screen.getByTestId(testIds.mostSplit)).getByText('100% agree · 0% not sure · 0% disagree')).toBeOnTheScreen();
  expect(within(screen.getByTestId(testIds.standApart)).getByText('You said agree. So did 100% of readers.')).toBeOnTheScreen();
  expect(screen.getByText('You ended where you started.')).toBeOnTheScreen();
  expect(screen.queryByTestId(testIds.crowdEmpty)).toBeNull();
});

it('says the crowd is not there yet when nobody has finished', async () => {
  const reveal = await agreeingReveal();
  const empty = computeFinalCrowd([], doc.steps.map((s) => s.id), 1);
  expect(empty.before_histogram).toBeNull();
  await render(<FinalRevealView reveal={{ ...reveal, crowd: empty }} doc={doc} />);
  expect(screen.getByTestId(testIds.crowdEmpty)).toBeOnTheScreen();
  expect(within(screen.getByTestId(testIds.mostSplit)).getByText('Not enough readers yet to say.')).toBeOnTheScreen();
  expect(within(screen.getByTestId(testIds.standApart)).getByText('Not enough readers yet to say.')).toBeOnTheScreen();
});
