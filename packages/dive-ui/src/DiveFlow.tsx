import { useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AFTER } from '@sia/case-schema';
import {
  caseUrl,
  currentScreen,
  currentSlot,
  diveReducer,
  initDive,
  isCommitted,
  isFinalReveal,
  pollDefault,
  progress,
  resumeCursor,
  shareCardData,
  slotOf,
  stepById,
  type DiveApi,
  type FairnessValue,
  type FlagReason,
  type LoadedCase,
} from '@sia/dive-engine';
import { FlagSheet } from './FlagSheet';
import { errorMessage } from './copy';
import { CaseCardScreen, FinalScreen, QuestionScreen, ShareScreen, StartingFactsScreen, StepScreen } from './screens';
import type { DiveServices } from './services';
import { testIds } from './testIds';
import { MAX_WIDTH, colors, space, type } from './theme';
import { Body, Button, Headline, Page } from './ui';

export interface DiveFlowProps {
  api: DiveApi;
  slug: string;
  /** Stable per-device id (one session per device per case version). */
  deviceId: string;
  /** A specific published version; the live version when omitted. */
  version?: number;
  /** Base URL for the share card's deep link, e.g. https://dive.example */
  shareBaseUrl: string;
  services: DiveServices;
  onExit?: () => void;
  /** Shows "How this dive was made" links when the host can open the transparency page. */
  onOpenTransparency?: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; loaded: LoadedCase }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/**
 * Plays any published case through the fixed dive sequence:
 * case card, starting facts, before, each step, after, final reveal, share card.
 */
export function DiveFlow(props: DiveFlowProps) {
  const { api, slug, version, onExit } = props;
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoad({ status: 'loading' });
    api.getCase(slug, version).then(
      (loaded) => alive && setLoad(loaded ? { status: 'ready', loaded } : { status: 'missing' }),
      (e: unknown) => alive && setLoad({ status: 'error', message: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, [api, slug, version, attempt]);

  if (load.status === 'ready') {
    return <DivePlayer key={`${load.loaded.case_id}:${load.loaded.version}`} loaded={load.loaded} {...props} />;
  }
  return (
    <View style={styles.root} testID={testIds.flow}>
      <View style={styles.centered}>
        {load.status === 'loading' ? (
          <ActivityIndicator color={colors.ink} testID={testIds.loading} accessibilityLabel="Loading" />
        ) : load.status === 'missing' ? (
          <View style={styles.message} testID={testIds.notFound}>
            <Headline>This dive isn't available.</Headline>
            <Body>It may have been replaced by a newer version or taken down.</Body>
            {onExit ? <Button label="Back" variant="secondary" onPress={onExit} testID={testIds.close} /> : null}
          </View>
        ) : (
          <View style={styles.message} testID={testIds.loadError}>
            <Headline>Couldn't load this dive.</Headline>
            <Body>{load.message}</Body>
            <Button label="Try again" onPress={() => setAttempt((n) => n + 1)} testID={testIds.next} />
          </View>
        )}
      </View>
    </View>
  );
}

function DivePlayer({
  loaded,
  api,
  deviceId,
  shareBaseUrl,
  services,
  onExit,
  onOpenTransparency,
}: DiveFlowProps & { loaded: LoadedCase }) {
  const [state, dispatch] = useReducer(diveReducer, loaded, (l) => initDive(l.doc, l.case_id, l.version));
  const [acknowledged, setAcknowledged] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [flagStepId, setFlagStepId] = useState<string | null>(null);
  const [scrollToReveal, setScrollToReveal] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const inFlight = useRef(false);

  const { doc, sessionId, cursor } = state;
  const screen = currentScreen(state);

  // Reveals for slots answered earlier (resume, or coming back to a step) are
  // fetched again. Only committed slots are ever requested.
  const revealSlot = screen.kind === 'final' || screen.kind === 'share' ? AFTER : slotOf(screen);
  const needsReveal =
    sessionId !== null &&
    revealSlot !== null &&
    revealSlot !== 'before' &&
    isCommitted(state, revealSlot) &&
    state.reveals[revealSlot] === undefined;
  const [revealAttempt, setRevealAttempt] = useState(0);
  useEffect(() => {
    if (!needsReveal || sessionId === null || revealSlot === null) return;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    api.getReveal(sessionId, revealSlot).then(
      (reveal) => alive && dispatch({ type: 'reveal_loaded', reveal }),
      // The screen keeps its loading line and tries again shortly.
      () => {
        if (alive) retry = setTimeout(() => setRevealAttempt((n) => n + 1), 3000);
      },
    );
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
  }, [api, needsReveal, sessionId, revealSlot, revealAttempt]);

  const go = (action: { type: 'next' } | { type: 'back' }) => {
    setNotice(null);
    setScrollToReveal(false);
    dispatch(action);
  };

  // Android's back button closes the flag sheet, then steps back through the dive.
  const pending = state.pending;
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (flagStepId !== null) {
        setFlagStepId(null);
        return true;
      }
      if (pending) return true;
      if (cursor === 0) return false;
      setNotice(null);
      setScrollToReveal(false);
      dispatch({ type: 'back' });
      return true;
    });
    return () => sub.remove();
  }, [cursor, pending, flagStepId]);

  const begin = async () => {
    if (starting) return;
    if (sessionId !== null) {
      go({ type: 'next' });
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const session = await api.startSession(state.caseId, state.version, deviceId);
      const started = diveReducer(state, { type: 'session_started', session });
      dispatch({ type: 'session_started', session });
      const target = resumeCursor(started);
      dispatch({ type: 'go_to', cursor: target > 0 ? target : 1 });
      if (session.answers.length > 0) {
        setNotice(
          session.completed
            ? 'You have finished this dive on this device. Here is where you landed.'
            : 'Welcome back. You are picking up where you left off; earlier answers stay locked.',
        );
      }
    } catch (e) {
      setStartError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const commit = async () => {
    const slot = currentSlot(state);
    if (slot === null || sessionId === null || state.pending || isCommitted(state, slot) || inFlight.current) return;
    const value = state.draft ?? pollDefault(state, slot);
    inFlight.current = true;
    dispatch({ type: 'commit_start' });
    try {
      const reveal = await api.submit(sessionId, slot, value);
      dispatch({ type: 'commit_success', reveal });
      setScrollToReveal(true);
    } catch (e) {
      dispatch({ type: 'commit_error', message: errorMessage(e) });
    } finally {
      inFlight.current = false;
    }
  };

  const flag = async (reason: FlagReason, note?: string) => {
    if (sessionId === null || flagStepId === null) return;
    await api.flagFact(sessionId, flagStepId, reason, note);
  };

  const rate = async (sideId: string, rating: FairnessValue) => {
    if (sessionId === null) return;
    await api.rateFairness(sessionId, sideId, rating);
  };

  const openUrl = (url: string) => {
    void services.openUrl(url);
  };

  const onRevealLayout = (y: number) => {
    if (!scrollToReveal) return;
    setScrollToReveal(false);
    scrollRef.current?.scrollTo({ y: Math.max(0, y - space.xl), animated: true });
  };

  const draft = (value: number) => dispatch({ type: 'set_draft', value });

  let body;
  switch (screen.kind) {
    case 'case_card':
      body = (
        <CaseCardScreen
          doc={doc}
          acknowledged={acknowledged}
          onAcknowledge={() => setAcknowledged((a) => !a)}
          onBegin={begin}
          starting={starting}
          error={startError}
          onOpenTransparency={onOpenTransparency}
        />
      );
      break;
    case 'starting_facts':
      body = <StartingFactsScreen doc={doc} openUrl={openUrl} onNext={() => go({ type: 'next' })} />;
      break;
    case 'before':
    case 'after':
      body = (
        <QuestionScreen
          which={screen.kind}
          state={state}
          doc={doc}
          onDraft={draft}
          onCommit={commit}
          onNext={() => go({ type: 'next' })}
        />
      );
      break;
    case 'step': {
      const step = stepById(doc, screen.stepId)!;
      body = (
        <StepScreen
          state={state}
          doc={doc}
          step={step}
          index={screen.index}
          openUrl={openUrl}
          onToggleDepth={() => dispatch({ type: 'toggle_depth', stepId: step.id })}
          onFlag={() => setFlagStepId(step.id)}
          onDraft={draft}
          onCommit={commit}
          onNext={() => go({ type: 'next' })}
          onRevealLayout={onRevealLayout}
        />
      );
      break;
    }
    case 'final':
      body = (
        <FinalScreen
          state={state}
          doc={doc}
          onRate={rate}
          onNext={() => go({ type: 'next' })}
          onOpenTransparency={onOpenTransparency}
        />
      );
      break;
    case 'share': {
      const final = state.reveals[AFTER];
      const card = final && isFinalReveal(final) ? shareCardData(doc, final, caseUrl(shareBaseUrl, loaded.slug)) : null;
      body = <ShareScreen card={card} services={services} onDone={onExit} />;
      break;
    }
  }

  const flagStep = flagStepId ? stepById(doc, flagStepId) : undefined;

  return (
    <View style={styles.root} testID={testIds.flow}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          {cursor > 0 ? (
            <HeaderAction
              label="Back"
              onPress={() => go({ type: 'back' })}
              disabled={state.pending}
              testID={testIds.back}
            />
          ) : (
            <View />
          )}
          {onExit ? <HeaderAction label="Close" onPress={onExit} testID={testIds.close} /> : null}
        </View>
        <View
          style={styles.progressTrack}
          testID={testIds.progress}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(progress(state) * 100) }}
        >
          <View style={[styles.progressFill, { width: `${progress(state) * 100}%` }]} />
        </View>
      </View>
      <Page key={cursor} scrollRef={scrollRef}>
        {notice ? (
          <Text style={[type.small, styles.notice]} testID={testIds.notice}>
            {notice}
          </Text>
        ) : null}
        {body}
      </Page>
      {flagStep ? (
        <FlagSheet key={flagStep.id} headline={flagStep.headline} onSubmit={flag} onClose={() => setFlagStepId(null)} />
      ) : null}
    </View>
  );
}

function HeaderAction({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" hitSlop={12} testID={testID}>
      <Text style={[type.small, styles.headerAction, disabled && styles.headerActionDisabled]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  message: { maxWidth: MAX_WIDTH, gap: space.md },
  header: {
    width: '100%',
    maxWidth: MAX_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 28 },
  headerAction: { color: colors.ink },
  headerActionDisabled: { opacity: 0.35 },
  progressTrack: { height: 2, backgroundColor: colors.faint, marginTop: space.sm },
  progressFill: { height: 2, backgroundColor: colors.ink },
  notice: {
    color: colors.ink,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.rule,
  },
});
