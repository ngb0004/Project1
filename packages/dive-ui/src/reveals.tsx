import type { ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import type { PublicCase } from '@sia/case-schema';
import {
  crowdCountText,
  mirrorText,
  seededNoteText,
  stepById,
  versionNoteText,
  type FinalReveal,
  type StepReveal,
  type VersionNote,
} from '@sia/dive-engine';
import { useFocusOnMount } from './a11y';
import { JourneyChart, ShiftChart, bucketOf } from './charts';
import { crowdStepDeltaText, finalCrowdSummary, journeyLabel, stepCrowdSummary, yourStepDeltaText } from './copy';
import { useEntrance } from './motion';
import { testIds } from './testIds';
import { colors, fonts, space, type } from './theme';
import { Kicker } from './ui';

/** The reveal frame: an accent rule, and a short rise into place the first time it appears. */
function RevealFrame({ children, testID }: { children: ReactNode; testID: string }) {
  const progress = useEntrance();
  return (
    <Animated.View
      testID={testID}
      style={[
        styles.frame,
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

function CrowdNotes({
  seededShare,
  nReal,
  versionNote,
}: {
  seededShare: number;
  nReal: number;
  versionNote: VersionNote;
}) {
  const seeded = seededNoteText(seededShare);
  const version = versionNoteText(versionNote);
  return (
    <View style={styles.notes}>
      <Text style={type.small}>{crowdCountText(nReal)}</Text>
      {seeded ? (
        <Text style={[type.small, styles.seeded]} testID={testIds.seededNote}>
          {seeded}
        </Text>
      ) : null}
      {version ? (
        <Text style={type.small} testID={testIds.versionNote}>
          {version}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The personal mirror, the first line of every reveal. After a commit it takes
 * focus, so screen readers (and keyboard users) land on the news, not on the
 * page body where the Lock in button was.
 */
function Mirror({ text, focusOnMount }: { text: string; focusOnMount: boolean }) {
  const ref = useFocusOnMount(focusOnMount);
  return (
    <View ref={ref} tabIndex={-1} accessible style={styles.focusTarget}>
      <Text style={styles.mirror} testID={testIds.mirror}>
        {text}
      </Text>
    </View>
  );
}

/** After a step's poll is committed: the personal mirror and how the crowd moved at this step. */
export function StepRevealView({
  reveal,
  doc,
  focusOnMount = false,
}: {
  reveal: StepReveal;
  doc: PublicCase;
  focusOnMount?: boolean;
}) {
  const { left_label: left, right_label: right } = doc.question.scale;
  const { crowd } = reveal;
  const summary = stepCrowdSummary(crowd, left, right);
  return (
    <RevealFrame testID={testIds.reveal}>
      <Mirror text={mirrorText(reveal.previous_value, reveal.value)} focusOnMount={focusOnMount} />
      <Kicker style={styles.kicker}>Everyone who reached this fact</Kicker>
      {crowd.shift ? (
        <>
          <ShiftChart
            shift={crowd.shift}
            you={bucketOf(reveal.previous_value, reveal.value)}
            leftLabel={left}
            rightLabel={right}
          />
          {summary ? (
            <Text style={type.body} testID={testIds.crowdSummary}>
              {summary}
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={type.body} testID={testIds.crowdEmpty}>
          Not enough readers have reached this fact yet to show how the crowd moved.
        </Text>
      )}
      <CrowdNotes seededShare={crowd.seeded_share} nReal={crowd.n_real} versionNote={reveal.version_note} />
    </RevealFrame>
  );
}

/** The final reveal: the reader's path over the crowd, and the steps that moved each most. */
export function FinalRevealView({
  reveal,
  doc,
  focusOnMount = false,
}: {
  reveal: FinalReveal;
  doc: PublicCase;
  focusOnMount?: boolean;
}) {
  const { crowd, you } = reveal;
  const path = you.answers.map((a) => a.value);
  const before = you.answers.find((a) => a.step_id === 'before')?.value ?? path[0] ?? reveal.previous_value;
  const crowdSummary = finalCrowdSummary(crowd);
  // With no completions the histograms come back as ten zeros rather than null.
  const hasCrowd = crowd.mean_before !== null;

  const yourTop = you.top_step_id ? stepById(doc, you.top_step_id) : undefined;
  const yourTopIndex = you.answers.findIndex((a) => a.step_id === you.top_step_id);
  const yourTopDelta =
    yourTopIndex > 0 ? yourStepDeltaText(you.answers[yourTopIndex - 1]!.value, you.answers[yourTopIndex]!.value) : null;

  // The API still names a top step (the first one) when the crowd did not move at all.
  const crowdTopStat = crowd.steps.find((s) => s.step_id === crowd.top_step_id);
  const crowdMoved = (crowdTopStat?.mean_abs_delta ?? 0) > 0;
  const crowdTop = crowdMoved && crowd.top_step_id ? stepById(doc, crowd.top_step_id) : undefined;
  const crowdTopDelta = crowdStepDeltaText(crowdTopStat?.mean_abs_delta ?? null, crowd.seeded_share);

  return (
    <RevealFrame testID={testIds.finalReveal}>
      <Mirror text={mirrorText(before, reveal.value)} focusOnMount={focusOnMount} />
      <JourneyChart
        accessibilityLabel={journeyLabel(path, crowd)}
        path={path}
        beforeHistogram={hasCrowd ? crowd.before_histogram : null}
        afterHistogram={hasCrowd ? crowd.after_histogram : null}
        leftLabel={doc.question.scale.left_label}
        rightLabel={doc.question.scale.right_label}
      />
      {crowdSummary ? <Text style={type.body}>{crowdSummary}</Text> : null}
      {!hasCrowd ? (
        <Text style={type.body} testID={testIds.crowdEmpty}>
          Not enough readers have finished yet to show the crowd.
        </Text>
      ) : null}
      <CrowdNotes seededShare={crowd.seeded_share} nReal={crowd.n_real} versionNote={reveal.version_note} />

      <View style={styles.topStep} testID={testIds.topStepYou}>
        <Kicker>The fact that moved you most</Kicker>
        {yourTop ? (
          <>
            <Text style={styles.topHeadline}>{yourTop.headline}</Text>
            {yourTopDelta ? <Text style={type.small}>{yourTopDelta}</Text> : null}
          </>
        ) : (
          <Text style={type.body}>None of the facts moved you.</Text>
        )}
      </View>
      <View style={styles.topStep} testID={testIds.topStepCrowd}>
        <Kicker>The fact that moved everyone most</Kicker>
        {crowdTop ? (
          <>
            <Text style={styles.topHeadline}>{crowdTop.headline}</Text>
            {crowdTopDelta ? <Text style={type.small}>{crowdTopDelta}</Text> : null}
          </>
        ) : (
          <Text style={type.body}>
            {crowdTopStat?.mean_abs_delta === 0 ? 'None of the facts moved the crowd.' : 'Not enough readers yet to say.'}
          </Text>
        )}
      </View>
    </RevealFrame>
  );
}

const styles = StyleSheet.create({
  frame: {
    gap: space.md,
    paddingLeft: space.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  mirror: { fontFamily: fonts.serif, fontSize: 24, lineHeight: 31, color: colors.accent },
  // Focused by script only; the reveal's own accent rule already marks it.
  focusTarget: { outlineWidth: 0 },
  kicker: { marginTop: space.sm },
  notes: { gap: 2 },
  seeded: { color: colors.ink },
  topStep: { gap: space.xs, marginTop: space.sm },
  topHeadline: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 26, color: colors.ink },
});
