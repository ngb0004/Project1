import { useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { AFTER, BEFORE, type PublicCase, type PublicStep } from '@sia/case-schema';
import {
  estimateMinutes,
  formatDate,
  isCommitted,
  isFinalReveal,
  isStepReveal,
  pollDefault,
  shareText,
  type DiveState,
  type FairnessValue,
  type ShareCardData,
  type SlotKey,
  visibleReveal,
} from '@sia/dive-engine';
import { DepthLayers } from './DepthLayers';
import { FinalRevealView, StepRevealView } from './reveals';
import type { DiveServices, ShareOutcome } from './services';
import { ShareCard } from './ShareCard';
import { Slider } from './Slider';
import { Citations, ConfidenceLabel } from './Sources';
import { errorMessage } from './copy';
import { fairnessRatingId, fairnessSideId, steelmanId, testIds } from './testIds';
import { colors, fonts, space, type } from './theme';
import { Body, Button, Choice, Display, Headline, Kicker, Rule, Small, TextLink, Title } from './ui';

// ---------------------------------------------------------------------------
// Case card
// ---------------------------------------------------------------------------

export function CaseCardScreen({
  doc,
  acknowledged,
  onAcknowledge,
  onBegin,
  starting,
  error,
  onOpenTransparency,
}: {
  doc: PublicCase;
  acknowledged: boolean;
  onAcknowledge: () => void;
  onBegin: () => void;
  starting: boolean;
  error: string | null;
  onOpenTransparency?: () => void;
}) {
  const needsAck = Boolean(doc.content_warning) && !acknowledged;
  return (
    <>
      <View style={styles.group} testID={testIds.caseCard}>
        <Kicker>Facts as of {formatDate(doc.as_of)}</Kicker>
        <Display>{doc.title}</Display>
        <Small>
          About {estimateMinutes(doc)} min · {doc.steps.length} facts · {doc.sides.length} sides
        </Small>
      </View>
      <View style={styles.group}>
        <Kicker>The question</Kicker>
        <Title>{doc.question.prompt}</Title>
      </View>
      <Body style={styles.muted}>
        Record your first answer. Walk through the facts one at a time and answer again after each. Then see how you
        moved, and how everyone else did.
      </Body>
      {doc.content_warning ? (
        <View style={styles.warning} testID={testIds.contentWarning}>
          <Kicker style={styles.inkKicker}>Content warning</Kicker>
          <Body>{doc.content_warning}</Body>
          <Choice
            kind="checkbox"
            label="I understand and want to continue"
            selected={acknowledged}
            onPress={onAcknowledge}
            testID={testIds.contentWarningAck}
          />
        </View>
      ) : null}
      {error ? <ErrorText message={error} /> : null}
      <Button
        label={starting ? 'Starting…' : 'Begin'}
        onPress={onBegin}
        disabled={needsAck || starting}
        testID={testIds.next}
        accessibilityHint={needsAck ? 'Acknowledge the content warning first' : undefined}
      />
      {onOpenTransparency ? (
        <TextLink
          label="How this dive was made"
          onPress={onOpenTransparency}
          testID={testIds.transparencyLink}
          accessibilityRole="link"
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Starting facts
// ---------------------------------------------------------------------------

export function StartingFactsScreen({
  doc,
  openUrl,
  onNext,
}: {
  doc: PublicCase;
  openUrl: (url: string) => void;
  onNext: () => void;
}) {
  return (
    <>
      <View style={styles.group} testID={testIds.startingFacts}>
        <Kicker>Starting facts</Kicker>
        <Headline>What is not in dispute</Headline>
      </View>
      {doc.starting_facts.map((fact) => (
        <View key={fact.id} style={styles.fact}>
          <ConfidenceLabel confidence={fact.confidence} />
          <Text style={styles.factText}>{fact.text}</Text>
          <Citations doc={doc} ids={fact.source_ids} openUrl={openUrl} />
        </View>
      ))}
      <Button label="Next" onPress={onNext} testID={testIds.next} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Polls (Before, each step, After)
// ---------------------------------------------------------------------------

function ErrorText({ message }: { message: string }) {
  return (
    <Text style={[type.small, styles.error]} testID={testIds.error} accessibilityLiveRegion="assertive">
      {message}
    </Text>
  );
}

function PollControls({
  state,
  doc,
  slot,
  label,
  onDraft,
  onCommit,
}: {
  state: DiveState;
  doc: PublicCase;
  slot: SlotKey;
  label: string;
  onDraft: (value: number) => void;
  onCommit: () => void;
}) {
  const committed = isCommitted(state, slot);
  const value = committed ? state.answers[slot]! : (state.draft ?? pollDefault(state, slot));
  return (
    <View style={styles.poll}>
      <Slider
        value={value}
        onChange={onDraft}
        disabled={committed || state.pending}
        leftLabel={doc.question.scale.left_label}
        rightLabel={doc.question.scale.right_label}
        accessibilityLabel={label}
      />
      {committed ? (
        <Small testID={testIds.lockedNote}>Locked at {value}. Answers can't be changed once they are in.</Small>
      ) : (
        <Button
          label={state.pending ? 'Locking in…' : 'Lock in'}
          onPress={onCommit}
          disabled={state.pending}
          testID={testIds.pollCommit}
        />
      )}
      {state.error ? <ErrorText message={state.error} /> : null}
    </View>
  );
}

export function QuestionScreen({
  which,
  state,
  doc,
  onDraft,
  onCommit,
  onNext,
}: {
  which: 'before' | 'after';
  state: DiveState;
  doc: PublicCase;
  onDraft: (value: number) => void;
  onCommit: () => void;
  onNext: () => void;
}) {
  const slot = which === 'before' ? BEFORE : AFTER;
  const committed = isCommitted(state, slot);
  return (
    <>
      <View style={styles.group} testID={which === 'before' ? testIds.beforeScreen : testIds.afterScreen}>
        <Kicker>{which === 'before' ? 'Your first answer' : 'Your answer now'}</Kicker>
        <Headline>{doc.question.prompt}</Headline>
        <Small>
          {which === 'before'
            ? 'Go with your gut. This answer locks when you tap Lock in, and you will not be able to change it.'
            : 'Same question as at the start, now that you have seen the facts. This answer locks too.'}
        </Small>
      </View>
      <PollControls
        state={state}
        doc={doc}
        slot={slot}
        label={doc.question.prompt}
        onDraft={onDraft}
        onCommit={onCommit}
      />
      {committed ? (
        <Button
          label={which === 'before' ? 'Start the facts' : 'See where you landed'}
          onPress={onNext}
          testID={testIds.next}
        />
      ) : null}
    </>
  );
}

export function StepScreen({
  state,
  doc,
  step,
  index,
  openUrl,
  onToggleDepth,
  onFlag,
  onDraft,
  onCommit,
  onNext,
  onRevealLayout,
}: {
  state: DiveState;
  doc: PublicCase;
  step: PublicStep;
  index: number;
  openUrl: (url: string) => void;
  onToggleDepth: () => void;
  onFlag: () => void;
  onDraft: (value: number) => void;
  onCommit: () => void;
  onNext: () => void;
  onRevealLayout: (y: number) => void;
}) {
  const committed = isCommitted(state, step.id);
  const expanded = Boolean(state.expanded[step.id]);
  const reveal = visibleReveal(state, step.id);
  const last = index === doc.steps.length - 1;
  return (
    <>
      <View style={styles.group} testID={testIds.stepScreen}>
        <Kicker>
          Fact {index + 1} of {doc.steps.length}
        </Kicker>
        <ConfidenceLabel confidence={step.confidence} showHint />
      </View>
      <View style={styles.group}>
        <Headline>{step.headline}</Headline>
        <Body>{step.body}</Body>
        <Citations doc={doc} ids={step.source_ids} openUrl={openUrl} />
      </View>
      {step.depth.length > 0 ? (
        <View>
          <TextLink
            label={expanded ? 'Show less' : 'Go deeper'}
            onPress={onToggleDepth}
            expanded={expanded}
            testID={testIds.goDeeper}
          />
          {expanded ? <DepthLayers doc={doc} layers={step.depth} openUrl={openUrl} /> : null}
        </View>
      ) : null}
      <TextLink label="Flag this fact" onPress={onFlag} testID={testIds.flagLink} />
      <Rule />
      <View style={styles.group}>
        <Title>{step.micro_poll.prompt}</Title>
        <Small>{doc.question.prompt}</Small>
      </View>
      <PollControls
        state={state}
        doc={doc}
        slot={step.id}
        label={step.micro_poll.prompt}
        onDraft={onDraft}
        onCommit={onCommit}
      />
      {reveal && isStepReveal(reveal) ? (
        <View onLayout={(e: LayoutChangeEvent) => onRevealLayout(e.nativeEvent.layout.y)}>
          <StepRevealView reveal={reveal} doc={doc} />
        </View>
      ) : committed ? (
        <Small>Loading how everyone moved…</Small>
      ) : null}
      {committed ? (
        <Button label={last ? 'On to the final question' : 'Next fact'} onPress={onNext} testID={testIds.next} />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Final reveal
// ---------------------------------------------------------------------------

const RATINGS: { value: FairnessValue; label: string }[] = [
  { value: 'fair', label: 'Fair' },
  { value: 'somewhat_fair', label: 'Somewhat fair' },
  { value: 'unfair', label: 'Unfair' },
];

function FairnessQuestion({
  doc,
  onRate,
}: {
  doc: PublicCase;
  onRate: (sideId: string, rating: FairnessValue) => Promise<void>;
}) {
  const [side, setSide] = useState<string | null>(null);
  const [rating, setRating] = useState<FairnessValue | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!side || !rating || status === 'sending') return;
    setStatus('sending');
    setError(null);
    try {
      await onRate(side, rating);
      setStatus('sent');
    } catch (e) {
      setError(errorMessage(e));
      setStatus('idle');
    }
  };

  return (
    <View style={styles.group} testID={testIds.fairness}>
      <Kicker>Optional</Kicker>
      <Title>Was this fair to your side?</Title>
      {status === 'sent' ? (
        <Body testID={testIds.fairnessThanks}>Thank you. The editor sees these answers for each side.</Body>
      ) : (
        <>
          <Small>Which side is closest to yours?</Small>
          <View accessibilityRole="radiogroup">
            {doc.sides.map((s) => (
              <Choice
                key={s.id}
                label={s.label}
                selected={side === s.id}
                onPress={() => setSide(s.id)}
                testID={fairnessSideId(s.id)}
              />
            ))}
          </View>
          {side ? (
            <View accessibilityRole="radiogroup">
              {RATINGS.map((r) => (
                <Choice
                  key={r.value}
                  label={r.label}
                  selected={rating === r.value}
                  onPress={() => setRating(r.value)}
                  testID={fairnessRatingId(r.value)}
                />
              ))}
            </View>
          ) : null}
          {error ? <ErrorText message={error} /> : null}
          <Button
            label={status === 'sending' ? 'Sending…' : 'Send'}
            variant="secondary"
            onPress={send}
            disabled={!side || !rating || status === 'sending'}
            testID={testIds.fairnessSubmit}
          />
        </>
      )}
    </View>
  );
}

export function FinalScreen({
  state,
  doc,
  onRate,
  onNext,
  onOpenTransparency,
}: {
  state: DiveState;
  doc: PublicCase;
  onRate: (sideId: string, rating: FairnessValue) => Promise<void>;
  onNext: () => void;
  onOpenTransparency?: () => void;
}) {
  const reveal = visibleReveal(state, AFTER);
  return (
    <>
      <View style={styles.group} testID={testIds.finalScreen}>
        <Kicker>Where you landed</Kicker>
        <Headline>{doc.question.prompt}</Headline>
      </View>
      {reveal && isFinalReveal(reveal) ? (
        <FinalRevealView reveal={reveal} doc={doc} />
      ) : (
        <Small>Loading your result…</Small>
      )}
      <Rule />
      {doc.open_questions.length > 0 ? (
        <View style={styles.group} testID={testIds.openQuestions}>
          <Kicker>Still unknown</Kicker>
          {doc.open_questions.map((q, i) => (
            <View key={i} style={styles.bullet}>
              <Text style={styles.bulletMark}>—</Text>
              <Text style={[type.body, styles.bulletText]}>{q}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.group} testID={testIds.steelmen}>
        <Kicker>The strongest case for each side</Kicker>
        {doc.sides.map((s) => (
          <View key={s.id} style={styles.steelman} testID={steelmanId(s.id)}>
            <Title>{s.label}</Title>
            <Body>{s.steelman}</Body>
          </View>
        ))}
      </View>
      <Rule />
      <FairnessQuestion doc={doc} onRate={onRate} />
      <Rule />
      <Button label="Make your share card" onPress={onNext} disabled={!reveal} testID={testIds.next} />
      {onOpenTransparency ? (
        <TextLink
          label="How this dive was made"
          onPress={onOpenTransparency}
          testID={testIds.transparencyLink}
          accessibilityRole="link"
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Share card
// ---------------------------------------------------------------------------

export function ShareScreen({
  card,
  services,
  onDone,
}: {
  card: ShareCardData | null;
  services: DiveServices;
  onDone?: () => void;
}) {
  const cardRef = useRef<View>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);

  if (!card) {
    return <Small>Loading your card…</Small>;
  }
  const text = shareText(card.before, card.after, card.url);

  const share = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await services.share({ card, text, view: cardRef.current });
      setOutcome(result ?? { status: 'shared' });
    } catch (e) {
      setOutcome({ status: 'failed', message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!services.copy) return;
    try {
      await services.copy(text);
      setOutcome({ status: 'copied' });
    } catch (e) {
      setOutcome({ status: 'failed', message: errorMessage(e) });
    }
  };

  const statusText =
    outcome?.status === 'shared'
      ? 'Shared.'
      : outcome?.status === 'copied'
        ? 'Link copied.'
        : outcome?.status === 'failed'
          ? outcome.message
          : null;

  return (
    <>
      <View style={styles.group} testID={testIds.shareScreen}>
        <Kicker>Your share card</Kicker>
        <Headline>Share where you landed</Headline>
      </View>
      <ShareCard card={card} ref={cardRef} />
      <Button label={busy ? 'Preparing…' : 'Share'} onPress={share} disabled={busy} testID={testIds.shareButton} />
      {services.copy ? <Button label="Copy link" variant="secondary" onPress={copy} testID={testIds.copyLink} /> : null}
      {statusText ? <Small testID={testIds.shareStatus}>{statusText}</Small> : null}
      {outcome?.status === 'copied' && outcome.download ? (
        <TextLink label="Download the image" onPress={outcome.download} testID={testIds.shareDownload} />
      ) : null}
      {onDone ? <TextLink label="Done" onPress={onDone} testID={testIds.done} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  group: { gap: space.sm },
  muted: { color: colors.muted },
  inkKicker: { color: colors.ink },
  warning: {
    gap: space.sm,
    padding: space.md,
    borderWidth: 1,
    borderColor: colors.ink,
  },
  fact: {
    gap: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.rule,
  },
  factText: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 28, color: colors.ink },
  poll: { gap: space.md },
  error: { color: colors.ink, fontWeight: '600' },
  bullet: { flexDirection: 'row', gap: space.sm },
  bulletMark: { ...type.body, color: colors.muted },
  bulletText: { flex: 1 },
  steelman: { gap: space.xs, marginBottom: space.sm },
});
