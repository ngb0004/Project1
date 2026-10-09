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
  type SlotKey,
} from '@sia/dive-engine';
import { prepareAnnouncer } from './a11y';
import { FlagSheet } from './FlagSheet';
import { errorMessage, isTransient, needsReload } from './copy';
import {
  CaseCardScreen,
  FinalScreen,
  QuestionScreen,
  ShareScreen,
  StartingFactsScreen,
  StepScreen,
  TakesScreen,
  TimelineScreen,
  type PollEvents,
  type RevealFailure,
} from './screens';
import type { DiveProgressStore, DiveServices } from './services';
import { testIds } from './testIds';
import { MAX_WIDTH, colors, space, type } from './theme';
import { Body, Button, Headline, Page } from './ui';

export interface DiveFlowProps {
  api: DiveApi;
  slug: string;
  /** Stable per-device id (one session per device per case version). */
  deviceId: string;
  /** A specific published version; otherwise the version this device is part-way through, or the live one. */
  version?: number;
  /**
   * Public web origin for the share card's deep link, e.g. https://dive.example.
   * Null when there is none (a native build without a web app): the card and
   * its share text then carry no link rather than one recipients cannot open.
   */
  shareBaseUrl: string | null;
  services: DiveServices;
  onExit?: () => void;
  /** Shows "How this dive was made" links when the host can open the transparency page. */
  onOpenTransparency?: () => void;
  /**
   * True while the reader is past the case card with the dive unfinished, so
   * the host can keep platform back gestures (iOS swipe, browser Back) from
   * dropping them out of it.
   */
  onInProgressChange?: (inProgress: boolean) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; loaded: LoadedCase; notice: string | null }
  | { status: 'missing' }
  | { status: 'error'; message: string };

const UPDATED_NOTICE =
  'This dive was updated after you started it. Your earlier answers stay with the version you saw, so this version starts fresh.';
const OLDER_VERSION_NOTICE = 'A newer version of this dive is out. You are finishing the version you started.';

/**
 * Which version to open: the one asked for; otherwise the version this device
 * is part-way through, while it is still published; otherwise the live one.
 */
async function openCase(
  api: DiveApi,
  slug: string,
  version: number | undefined,
  store: DiveProgressStore | undefined,
  reloadedVersion: number | null,
): Promise<LoadState> {
  if (version !== undefined) {
    const loaded = await api.getCase(slug, version);
    return loaded ? { status: 'ready', loaded, notice: null } : { status: 'missing' };
  }
  const started = (store ? await store.get(slug).catch(() => null) : null) ?? reloadedVersion;
  if (started !== null) {
    const earlier = await api.getCase(slug, started);
    if (earlier) return { status: 'ready', loaded: earlier, notice: earlier.is_live ? null : OLDER_VERSION_NOTICE };
  }
  const loaded = await api.getCase(slug);
  if (!loaded) return { status: 'missing' };
  return { status: 'ready', loaded, notice: started !== null && started !== loaded.version ? UPDATED_NOTICE : null };
}

/**
 * Plays any published case through the fixed dive sequence:
 * case card, starting facts, before, each step, after, final reveal, share card.
 */
export function DiveFlow(props: DiveFlowProps) {
  const { api, slug, version, onExit, services } = props;
  const store = services.progress;
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Set by "Reload the dive": the version that was open, to pick it up again (or explain why not).
  const [reloadedFrom, setReloadedFrom] = useState<{ caseId: string; version: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoad({ status: 'loading' });
    openCase(api, slug, version, store, reloadedFrom?.version ?? null).then(
      (next) => alive && setLoad(next),
      (e: unknown) => alive && setLoad({ status: 'error', message: errorMessage(e, 'load') }),
    );
    return () => {
      alive = false;
    };
  }, [api, slug, version, attempt, store, reloadedFrom]);

  if (load.status === 'ready') {
    const { loaded } = load;
    const reload = () => {
      // Unmount the player now, not after the effect: a render in between would mount it for the old load.
      setLoad({ status: 'loading' });
      setReloadedFrom({ caseId: loaded.case_id, version: loaded.version });
      setAttempt((n) => n + 1);
    };
    return (
      <DivePlayer
        {...props}
        key={`${loaded.case_id}:${loaded.version}:${attempt}`}
        loaded={loaded}
        initialNotice={load.notice}
        resume={reloadedFrom?.caseId === loaded.case_id && reloadedFrom.version === loaded.version}
        onReload={reload}
      />
    );
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

/** Waits before each automatic retry of a reveal that failed to load; after the last, the reader decides. */
const REVEAL_RETRY_MS = [3000, 6000];

function DivePlayer({
  loaded,
  initialNotice,
  resume,
  onReload,
  api,
  deviceId,
  shareBaseUrl,
  services,
  onExit,
  onOpenTransparency,
  onInProgressChange,
}: DiveFlowProps & {
  loaded: LoadedCase;
  initialNotice: string | null;
  /** Begin straight away: the reader reloaded this same version mid-dive. */
  resume: boolean;
  onReload: () => void;
}) {
  const [state, dispatch] = useReducer(diveReducer, loaded, (l) => initDive(l.doc, l.case_id, l.version));
  const [acknowledged, setAcknowledged] = useState(resume);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [flagStepId, setFlagStepId] = useState<string | null>(null);
  const [scrollToReveal, setScrollToReveal] = useState(false);
  const [justCommitted, setJustCommitted] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const background = useRef<View>(null);
  const inFlight = useRef(false);

  const { doc, sessionId, cursor } = state;
  const screen = currentScreen(state);
  const remember = (version: number | null) => void services.progress?.set(loaded.slug, version).catch(() => undefined);

  useEffect(() => prepareAnnouncer(), []);

  const inProgress = cursor > 0 && !isCommitted(state, AFTER);
  useEffect(() => {
    onInProgressChange?.(inProgress);
  }, [inProgress, onInProgressChange]);
  useEffect(() => () => onInProgressChange?.(false), [onInProgressChange]);

  // Reveals for slots answered earlier (resume, or coming back to a step) are
  // fetched again. Only committed slots are ever requested. Network trouble is
  // retried a couple of times with a growing pause; then the reader gets the
  // message and a button.
  const revealSlot = screen.kind === 'final' || screen.kind === 'share' ? AFTER : slotOf(screen);
  const needsReveal =
    sessionId !== null &&
    revealSlot !== null &&
    revealSlot !== 'before' &&
    isCommitted(state, revealSlot) &&
    state.reveals[revealSlot] === undefined;
  const [revealTry, setRevealTry] = useState<{ slot: SlotKey | null; attempt: number; failures: number }>({
    slot: null,
    attempt: 0,
    failures: 0,
  });
  const [revealError, setRevealError] = useState<{ slot: SlotKey; message: string; reload: boolean } | null>(null);
  useEffect(() => {
    if (!needsReveal || sessionId === null || revealSlot === null || revealError?.slot === revealSlot) return;
    const failures = revealTry.slot === revealSlot ? revealTry.failures : 0;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    api.getReveal(sessionId, revealSlot).then(
      (reveal) => alive && dispatch({ type: 'reveal_loaded', reveal }),
      (e: unknown) => {
        if (!alive) return;
        const wait = isTransient(e) ? REVEAL_RETRY_MS[failures] : undefined;
        if (wait !== undefined) {
          retry = setTimeout(
            () => setRevealTry((t) => ({ slot: revealSlot, attempt: t.attempt + 1, failures: failures + 1 })),
            wait,
          );
        } else {
          setRevealError({ slot: revealSlot, message: errorMessage(e, 'reveal'), reload: needsReload(e) });
        }
      },
    );
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
  }, [api, needsReveal, sessionId, revealSlot, revealTry, revealError]);

  const revealFailure: RevealFailure | null =
    revealError && revealError.slot === revealSlot
      ? {
          message: revealError.message,
          retry: () => {
            setRevealError(null);
            setRevealTry((t) => ({ slot: revealError.slot, attempt: t.attempt + 1, failures: 0 }));
          },
          reload: revealError.reload ? onReload : undefined,
        }
      : null;

  const go = (action: { type: 'next' } | { type: 'back' }) => {
    setNotice(null);
    setScrollToReveal(false);
    setJustCommitted(false);
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
      setJustCommitted(false);
      dispatch({ type: 'back' });
      return true;
    });
    return () => sub.remove();
  }, [cursor, pending, flagStepId]);

  // While the flag sheet is open, everything behind it is out of reach: hidden
  // from screen readers, and on the web inert to the keyboard as well.
  const sheetOpen = flagStepId !== null;
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = background.current as unknown as HTMLElement | null;
    if (node) node.inert = sheetOpen;
  }, [sheetOpen]);

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
        remember(session.completed ? null : state.version);
        setNotice(
          session.completed
            ? 'You have finished this dive on this device. Here is where you landed.'
            : 'Welcome back. You are picking up where you left off; earlier answers stay locked.',
        );
      } else {
        setNotice(null);
      }
    } catch (e) {
      setStartError(errorMessage(e, 'start'));
    } finally {
      setStarting(false);
    }
  };

  // After a reload of the same version, pick the session up again without another tap on Begin.
  const resumeOnMount = useRef(resume);
  useEffect(() => {
    // Runs once: `begin` reads the state this player mounted with.
    if (!resumeOnMount.current) return;
    resumeOnMount.current = false;
    void begin();
  }, []);

  const commit = async () => {
    const slot = currentSlot(state);
    if (slot === null || sessionId === null || state.pending || isCommitted(state, slot) || inFlight.current) return;
    const value = state.draft ?? pollDefault(state, slot);
    // A fact vote has no default: nothing is sent until the reader picks one.
    if (value === null) return;
    inFlight.current = true;
    setJustCommitted(false);
    dispatch({ type: 'commit_start' });
    try {
      const reveal = await api.submit(sessionId, slot, value);
      dispatch({ type: 'commit_success', reveal });
      setJustCommitted(true);
      setScrollToReveal(true);
      // Remember the version once an answer is locked in it; forget it once the dive is done.
      remember(slot === AFTER ? null : state.version);
    } catch (e) {
      dispatch({ type: 'commit_error', message: errorMessage(e, 'answer') });
      if (needsReload(e)) setReloadNeeded(true);
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
  const events: PollEvents = { justCommitted, onReload: reloadNeeded ? onReload : undefined };

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
          events={events}
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
          events={events}
          revealFailure={revealFailure}
        />
      );
      break;
    }
    case 'timeline':
      body = <TimelineScreen doc={doc} openUrl={openUrl} onNext={() => go({ type: 'next' })} />;
      break;
    case 'takes':
      body = <TakesScreen doc={doc} openUrl={openUrl} onNext={() => go({ type: 'next' })} />;
      break;
    case 'final':
      body = (
        <FinalScreen
          state={state}
          doc={doc}
          onRate={rate}
          onNext={() => go({ type: 'next' })}
          onOpenTransparency={onOpenTransparency}
          revealFailure={revealFailure}
        />
      );
      break;
    case 'share': {
      const final = state.reveals[AFTER];
      const url = shareBaseUrl ? caseUrl(shareBaseUrl, loaded.slug) : '';
      const card = final && isFinalReveal(final) ? shareCardData(doc, final, url) : null;
      body = <ShareScreen card={card} services={services} onDone={onExit} />;
      break;
    }
  }

  const flagStep = flagStepId ? stepById(doc, flagStepId) : undefined;

  return (
    <View style={styles.root} testID={testIds.flow}>
      <View ref={background} style={styles.root} aria-hidden={sheetOpen}>
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
      </View>
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
