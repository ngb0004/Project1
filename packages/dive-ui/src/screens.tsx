import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
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
import { announce, useFocusOnMount } from './a11y';
import { DepthLayers } from './DepthLayers';
import { FinalRevealView, StepRevealView } from './reveals';
import type { DiveServices, ShareOutcome, ShareRequest } from './services';
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
        <Headline>Where things stand</Headline>
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

/** An error line. Screen readers hear it when it appears (a live region alone is not read on iOS or the web). */
function ErrorText({ message }: { message: string }) {
  useEffect(() => announce(message), [message]);
  return (
    <Text style={[type.small, styles.error]} testID={testIds.error}>
      {message}
    </Text>
  );
}

/** Replaces Lock in when only a fresh copy of the dive can clear the error; it takes focus from the button it replaces. */
function ReloadButton({ onReload }: { onReload: () => void }) {
  const ref = useFocusOnMount(true);
  return <Button ref={ref} label="Reload the dive" onPress={onReload} testID={testIds.reload} />;
}

function LockedNote({ value, focusOnMount }: { value: number; focusOnMount: boolean }) {
  const ref = useFocusOnMount(focusOnMount);
  return (
    <View ref={ref} tabIndex={-1} accessible style={styles.focusTarget}>
      <Small testID={testIds.lockedNote}>Locked at {value}. Answers can't be changed once they are in.</Small>
    </View>
  );
}

/** How a poll screen reacts to its answer going in, or failing to. */
export interface PollEvents {
  /** The answer on this screen was committed just now (not on an earlier visit). */
  justCommitted: boolean;
  /** Set when the last commit failed in a way only a reload can clear. */
  onReload?: () => void;
}

function PollControls({
  state,
  doc,
  slot,
  label,
  onDraft,
  onCommit,
  events,
}: {
  state: DiveState;
  doc: PublicCase;
  slot: SlotKey;
  label: string;
  onDraft: (value: number) => void;
  onCommit: () => void;
  events: PollEvents;
}) {
  const committed = isCommitted(state, slot);
  const value = committed ? state.answers[slot]! : (state.draft ?? pollDefault(state, slot));
  return (
    <View style={styles.poll}>
      <Slider
        value={value}
        onChange={onDraft}
        locked={committed}
        disabled={state.pending || Boolean(events.onReload)}
        leftLabel={doc.question.scale.left_label}
        rightLabel={doc.question.scale.right_label}
        accessibilityLabel={label}
      />
      {committed ? (
        <LockedNote value={value} focusOnMount={events.justCommitted} />
      ) : events.onReload ? (
        <ReloadButton onReload={events.onReload} />
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

/** A reveal that could not be loaded, with the one action that can help. */
function RevealError({ error }: { error: RevealFailure }) {
  return (
    <View style={styles.poll}>
      <ErrorText message={error.message} />
      {error.reload ? (
        <Button label="Reload the dive" variant="secondary" onPress={error.reload} testID={testIds.reload} />
      ) : (
        <Button label="Try again" variant="secondary" onPress={error.retry} testID={testIds.retry} />
      )}
    </View>
  );
}

/** Why a reveal for an answered slot is not on screen, and how to get it. */
export interface RevealFailure {
  message: string;
  retry: () => void;
  /** Set instead of a useful retry when only reloading the dive can help. */
  reload?: () => void;
}

export function QuestionScreen({
  which,
  state,
  doc,
  onDraft,
  onCommit,
  onNext,
  events,
}: {
  which: 'before' | 'after';
  state: DiveState;
  doc: PublicCase;
  onDraft: (value: number) => void;
  onCommit: () => void;
  onNext: () => void;
  events: PollEvents;
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
        events={events}
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
  events,
  revealFailure,
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
  events: PollEvents;
  revealFailure: RevealFailure | null;
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
        events={events}
      />
      {reveal && isStepReveal(reveal) ? (
        <View onLayout={(e: LayoutChangeEvent) => onRevealLayout(e.nativeEvent.layout.y)}>
          <StepRevealView reveal={reveal} doc={doc} focusOnMount={events.justCommitted} />
        </View>
      ) : committed && revealFailure ? (
        <RevealError error={revealFailure} />
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
      setError(errorMessage(e, 'rating'));
      setStatus('idle');
    }
  };

  return (
    <View style={styles.group} testID={testIds.fairness}>
      <Kicker>Optional</Kicker>
      <Title>Was this fair to your side?</Title>
      {status === 'sent' ? (
        <FairnessThanks />
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

/** Replaces the form, and the focused Send button with it, so it takes focus. */
function FairnessThanks() {
  const ref = useFocusOnMount(true);
  return (
    <View ref={ref} tabIndex={-1} accessible style={styles.focusTarget}>
      <Body testID={testIds.fairnessThanks}>Thank you. The editor sees these answers for each side.</Body>
    </View>
  );
}

export function FinalScreen({
  state,
  doc,
  onRate,
  onNext,
  onOpenTransparency,
  revealFailure,
}: {
  state: DiveState;
  doc: PublicCase;
  onRate: (sideId: string, rating: FairnessValue) => Promise<void>;
  onNext: () => void;
  onOpenTransparency?: () => void;
  revealFailure: RevealFailure | null;
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
      ) : revealFailure ? (
        <RevealError error={revealFailure} />
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

const SHARE_STATUS: Partial<Record<ShareOutcome['status'], string>> = {
  shared: 'Shared.',
  copied: 'Link copied.',
  manual: "Couldn't copy the link. Select it below to copy it.",
};

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
  const text = shareText(card.before, card.after, card.url).trim();

  const run = async (action: (request: ShareRequest) => Promise<ShareOutcome | void>) => {
    if (busy) return;
    setBusy(true);
    try {
      // No outcome: the platform could not say what happened, so say nothing.
      setOutcome((await action({ card, text, view: cardRef.current })) ?? { status: 'opened' });
    } catch (e) {
      setOutcome({ status: 'failed', message: errorMessage(e, 'share') });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!services.copy) return;
    try {
      setOutcome((await services.copy(text)) ? { status: 'copied' } : { status: 'manual' });
    } catch {
      setOutcome({ status: 'manual' });
    }
  };

  const statusText = outcome?.status === 'failed' ? outcome.message : outcome ? SHARE_STATUS[outcome.status] : null;
  const download = outcome?.status === 'copied' || outcome?.status === 'manual' ? outcome.download : undefined;

  return (
    <>
      <View style={styles.group} testID={testIds.shareScreen}>
        <Kicker>Your share card</Kicker>
        <Headline>Share where you landed</Headline>
      </View>
      <ShareCard card={card} ref={cardRef} />
      <Button
        label={busy ? 'Preparing…' : 'Share'}
        onPress={() => void run(services.share)}
        disabled={busy}
        testID={testIds.shareButton}
      />
      {services.shareImage ? (
        <Button
          label="Share the image"
          variant="secondary"
          onPress={() => void run(services.shareImage!)}
          disabled={busy}
          testID={testIds.shareImage}
        />
      ) : null}
      {services.copy && card.url ? (
        <Button label="Copy link" variant="secondary" onPress={copy} testID={testIds.copyLink} />
      ) : null}
      {statusText ? <Small testID={testIds.shareStatus}>{statusText}</Small> : null}
      {outcome?.status === 'manual' && card.url ? (
        <Text selectable style={[type.body, styles.shareUrl]} testID={testIds.shareUrl}>
          {card.url}
        </Text>
      ) : null}
      {download ? <TextLink label="Download the image" onPress={download} testID={testIds.shareDownload} /> : null}
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
  focusTarget: { outlineWidth: 0 },
  shareUrl: {
    padding: space.sm,
    borderWidth: 1,
    borderColor: colors.rule,
    ...(Platform.OS === 'web' ? ({ wordBreak: 'break-all', userSelect: 'all' } as object) : null),
  },
});
