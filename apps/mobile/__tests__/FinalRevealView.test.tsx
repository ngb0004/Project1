import { render, screen, within } from '@testing-library/react-native';
import { toPublicCase } from '@sia/case-schema';
import { isFinalReveal, slotsOf, type FinalReveal } from '@sia/dive-engine';
import { LocalDiveApi, computeFinalCrowd } from '@sia/dive-engine/local';
import { FinalRevealView, testIds } from '@sia/dive-ui';
import { loadFixtures } from './playThrough';

/**
 * Edge cases of the crowd in the final reveal, built with the real aggregates:
 * a crowd that never moved still gets a top step from the API (the first one),
 * and a crowd with no completions comes back as all-zero histograms.
 */
const doc = toPublicCase(loadFixtures()[0]!);

/** One reader who answers 40 everywhere, so nobody moves at any step. */
async function stillReveal(): Promise<FinalReveal> {
  const api = new LocalDiveApi({ cases: [{ doc }] });
  const session = await api.startSession(doc.id, doc.version, 'device-final-reveal-0001');
  let reveal;
  for (const slot of slotsOf(doc)) reveal = await api.submit(session.session_id, slot, 40);
  if (!reveal || !isFinalReveal(reveal)) throw new Error('expected the final reveal');
  return reveal;
}

it('does not name a step that moved the crowd when nobody moved', async () => {
  const reveal = await stillReveal();
  expect(reveal.crowd.top_step_id).toBe(doc.steps[0]!.id);
  await render(<FinalRevealView reveal={reveal} doc={doc} />);
  const crowdTop = screen.getByTestId(testIds.topStepCrowd);
  expect(within(crowdTop).getByText('None of the facts moved the crowd.')).toBeOnTheScreen();
  expect(within(crowdTop).queryByText(doc.steps[0]!.headline)).toBeNull();
  expect(within(screen.getByTestId(testIds.topStepYou)).getByText('None of the facts moved you.')).toBeOnTheScreen();
  expect(screen.queryByTestId(testIds.crowdEmpty)).toBeNull();
});

it('says the crowd is not there yet when nobody has finished', async () => {
  const reveal = await stillReveal();
  const empty = computeFinalCrowd([], doc.steps.map((s) => s.id), 1);
  expect(empty.before_histogram).toEqual(Array(10).fill(0));
  await render(<FinalRevealView reveal={{ ...reveal, crowd: empty }} doc={doc} />);
  expect(screen.getByTestId(testIds.crowdEmpty)).toBeOnTheScreen();
  expect(within(screen.getByTestId(testIds.topStepCrowd)).getByText('Not enough readers yet to say.')).toBeOnTheScreen();
});
