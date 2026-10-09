'use client';

import { memo, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import type { PublicCase, SeedProfileInput } from '@sia/case-schema';
import type { CaseHistory, DiveApi, Reveal, SlotKey, VersionNote } from '@sia/dive-engine';
import { LocalDiveApi } from '@sia/dive-engine/local';
import { DiveFlow, TransparencyPage, type DiveServices } from '@sia/dive-ui';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The preview never shares or stores anything; links open in a new tab. */
const previewServices: DiveServices = {
  openUrl: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  copy: copyText,
  async share({ text }) {
    return (await copyText(text)) ? { status: 'copied' } : { status: 'manual' };
  },
};

/** Published versions before this one, as readers will see them in the version note and the transparency page. */
export interface PreviewHistory {
  earlier: { version: number; title: string; as_of: string; published_at: string | null; parent_version: number | null; completions: number }[];
}

/**
 * The in-memory API plays only the version under review, so it knows nothing
 * of the versions before it. This wrapper adds what readers will see about
 * them once this version is live: the "Updated …; N people saw the earlier
 * version" note in the reveals (with the real completion counts) and the
 * version history on the transparency page.
 */
class PreviewApi implements DiveApi {
  constructor(
    private readonly inner: LocalDiveApi,
    private readonly history: PreviewHistory | null,
  ) {}

  private note(n: VersionNote): VersionNote {
    if (!this.history?.earlier.length) return n;
    return {
      ...n,
      earlier_versions: this.history.earlier.map((e) => ({ version: e.version, published_at: e.published_at, completions: e.completions })),
    };
  }

  private withNote(r: Reveal): Reveal {
    return 'version_note' in r && r.version_note ? ({ ...r, version_note: this.note(r.version_note) } as Reveal) : r;
  }

  listLiveCases: DiveApi['listLiveCases'] = () => this.inner.listLiveCases();
  getCase: DiveApi['getCase'] = (slug, version) => this.inner.getCase(slug, version);
  startSession: DiveApi['startSession'] = (caseId, version, deviceId) => this.inner.startSession(caseId, version, deviceId);
  submit = async (sessionId: string, slot: SlotKey, value: number) => this.withNote(await this.inner.submit(sessionId, slot, value));
  getReveal = async (sessionId: string, slot: SlotKey) => this.withNote(await this.inner.getReveal(sessionId, slot));
  flagFact: DiveApi['flagFact'] = (sessionId, stepId, reason, note) => this.inner.flagFact(sessionId, stepId, reason, note);
  rateFairness: DiveApi['rateFairness'] = (sessionId, sideId, rating) => this.inner.rateFairness(sessionId, sideId, rating);

  async getHistory(slug: string): Promise<CaseHistory | null> {
    const h = await this.inner.getHistory(slug);
    if (!h || !this.history?.earlier.length) return h;
    const earlier = [...this.history.earlier]
      .sort((a, b) => b.version - a.version)
      .map((e) => ({ version: e.version, title: e.title, as_of: e.as_of, status: 'published', published_at: e.published_at, parent_version: e.parent_version, completions: e.completions }));
    return { ...h, versions: [...h.versions, ...earlier] };
  }
}

export interface PreviewPlayerProps {
  doc: PublicCase;
  seedProfile: SeedProfileInput | null;
  shareBaseUrl: string | null;
  history: PreviewHistory | null;
  runKey: number;
  onExit: () => void;
  onSeedProblem: (message: string | null) => void;
}

/**
 * Plays the dive exactly as the app does: the shared DiveFlow screens from
 * @sia/dive-ui, rendered through react-native-web, against an in-memory
 * LocalDiveApi seeded with the case's seed profile (so reveals show the
 * seeded crowd), plus the "How this dive was made" transparency page.
 * Nothing here touches the database.
 */
function PreviewPlayer({ doc, seedProfile, shareBaseUrl, history, runKey, onExit, onSeedProblem }: PreviewPlayerProps) {
  const { api, problem } = useMemo(() => {
    const make = (profile: SeedProfileInput | null) => new PreviewApi(new LocalDiveApi({ cases: [{ doc, seedProfile: profile }] }), history);
    try {
      return { api: make(seedProfile), problem: null };
    } catch (e) {
      // A stored profile that no longer parses must not block the preview.
      return {
        api: make(null),
        problem: `The seed profile could not be used (${(e as Error).message}); the preview runs without a seeded crowd.`,
      };
    }
    // runKey restarts the dive with a fresh in-memory crowd.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, seedProfile, history, runKey]);
  useEffect(() => onSeedProblem(problem), [problem, onSeedProblem]);
  const deviceId = useMemo(() => `preview-${runKey}-${Math.random().toString(36).slice(2)}`, [runKey]);
  const [aboutOpen, setAboutOpen] = useState(false);
  useEffect(() => setAboutOpen(false), [runKey]);
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      {/* The dive stays mounted while the transparency page is open, so Back returns to the same screen. */}
      <View style={{ flex: 1, minHeight: 0, display: aboutOpen ? 'none' : 'flex' }}>
        <DiveFlow
          key={runKey}
          api={api}
          slug={doc.slug}
          deviceId={deviceId}
          shareBaseUrl={shareBaseUrl}
          services={previewServices}
          onExit={onExit}
          onOpenTransparency={() => setAboutOpen(true)}
        />
      </View>
      {aboutOpen ? (
        <View style={{ flex: 1, minHeight: 0 }}>
          <TransparencyPage api={api} slug={doc.slug} openUrl={previewServices.openUrl} onBack={() => setAboutOpen(false)} />
        </View>
      ) : null}
    </View>
  );
}

/** Memoized: typing in the editor re-renders the review screen, never the running dive. */
export default memo(PreviewPlayer);
