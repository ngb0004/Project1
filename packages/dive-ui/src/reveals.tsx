import type { ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import type { PublicCase } from '@sia/case-schema';
import {
  crowdCountText,
  mirrorText,
  seededNoteText,
  stepById,
  versionNoteText,
  voteKeyOf,
  voteSplitText,
  yourVoteText,
  type FinalReveal,
  type StepReveal,
  type VersionNote,
} from '@sia/dive-engine';
import { useFocusOnMount } from './a11y';
import { JourneyChart, VoteSplitBars } from './charts';
import { finalCrowdSummary, journeyLabel, standApart, standApartText } from './copy';
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

/** After a fact vote is committed: the reader's vote and how everyone else voted on this fact. */
export function StepRevealView({
  reveal,
  focusOnMount = false,
}: {
  reveal: StepReveal;
  doc?: PublicCase;
  focusOnMount?: boolean;
}) {
  const { crowd } = reveal;
  return (
    <RevealFrame testID={testIds.reveal}>
      <Mirror text={yourVoteText(reveal.value, crowd.votes)} focusOnMount={focusOnMount} />
      <Kicker style={styles.kicker}>What everyone else said</Kicker>
      {crowd.votes ? (
        <VoteSplitBars votes={crowd.votes} you={voteKeyOf(reveal.value)} />
      ) : (
        <Text style={type.body} testID={testIds.crowdEmpty}>
          You are one of the first to get here. Check back later to see how others voted.
        </Text>
      )}
      <CrowdNotes seededShare={crowd.seeded_share} nReal={crowd.n_real} versionNote={reveal.version_note} />
    </RevealFrame>
  );
}

/** The final reveal: the reader's Before and After over the crowd's, the most split fact, and where the reader stood apart. */
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
  const before = you.answers.find((a) => a.step_id === 'before')?.value ?? reveal.previous_value;
  const crowdSummary = finalCrowdSummary(crowd);
  // With no completions the histograms come back as ten zeros rather than null.
  const hasCrowd = crowd.mean_before !== null;
  const seeded = crowd.seeded_share > 0;

  const split = crowd.most_split_step_id ? stepById(doc, crowd.most_split_step_id) : undefined;
  const splitVotes = crowd.steps.find((s) => s.step_id === crowd.most_split_step_id)?.votes ?? null;
  const apart = standApart(you.answers, crowd);
  const apartStep = apart ? stepById(doc, apart.stepId) : undefined;

  return (
    <RevealFrame testID={testIds.finalReveal}>
      <Mirror text={mirrorText(before, reveal.value)} focusOnMount={focusOnMount} />
      <JourneyChart
        accessibilityLabel={journeyLabel(before, reveal.value, crowd)}
        path={[before, reveal.value]}
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

      <View style={styles.topStep} testID={testIds.mostSplit}>
        <Kicker>The fact people split on most</Kicker>
        {split && splitVotes ? (
          <>
            <Text style={styles.topHeadline}>{split.headline}</Text>
            <Text style={type.small}>{voteSplitText(splitVotes)}</Text>
          </>
        ) : (
          <Text style={type.body}>Not enough readers yet to say.</Text>
        )}
      </View>
      <View style={styles.topStep} testID={testIds.standApart}>
        <Kicker>Where you stood apart</Kicker>
        {apart && apartStep ? (
          <>
            <Text style={styles.topHeadline}>{apartStep.headline}</Text>
            <Text style={type.small}>{standApartText(apart, seeded)}</Text>
          </>
        ) : (
          <Text style={type.body}>Not enough readers yet to say.</Text>
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
