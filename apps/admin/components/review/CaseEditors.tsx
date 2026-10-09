'use client';

import { memo, useMemo } from 'react';
import { CONFIDENCE_LEVELS, SOURCE_TYPES, type Fact, type Side, type Source } from '@sia/case-schema';
import { safeHref } from '@/lib/format';
import type { FactCheckFlag } from '@/lib/step-flags';
import {
  citationsBySource,
  fieldDomId,
  insertAt,
  moveAt,
  newFact,
  newSide,
  newSource,
  removeAt,
  renameFactId,
  renameSideId,
  renameSourceId,
  sideReviewReferences,
} from '@/lib/working-copy';
import { useDoc, useEditor, useIssuesAt, useIssuesUnder, useReadOnly } from './editor-context';
import { IdField, IssueList, ItemTools, SelectField, SourceIdsField, TextField } from './fields';
import { FactCheckItem } from './FlagsPanel';
import { EvidenceEditor } from './StepCard';

const CONFIDENCE_OPTIONS = CONFIDENCE_LEVELS.map((c) => ({ value: c, label: c }));
const SOURCE_TYPE_OPTIONS = SOURCE_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }));
const EMPTY: never[] = [];

/** The items' ids as an array that keeps its identity until an id changes (so memoized items skip re-rendering). */
function useIds(items: readonly { id: string }[]): string[] {
  const key = JSON.stringify(items.map((x) => x.id));
  return useMemo(() => JSON.parse(key) as string[], [key]);
}

function CardHeader({ path, title, children }: { path: string; title: string; children?: React.ReactNode }) {
  const { errors, warnings } = useIssuesUnder(path);
  return (
    <summary>
      <span className="card-title">{title}</span>
      <span className="row small">
        {children}
        {errors.length ? <span className="badge badge-error">{errors.length} error{errors.length === 1 ? '' : 's'}</span> : null}
        {warnings.length ? <span className="badge badge-warn">{warnings.length} warning{warnings.length === 1 ? '' : 's'}</span> : null}
      </span>
    </summary>
  );
}

/** Title, as-of date, content warning and the one question everyone answers. */
export const CaseCardEditor = memo(function CaseCardEditor() {
  return (
    <details className="card" open id={fieldDomId('question')}>
      <CardHeader path="question" title="Case card and question" />
      <div className="card-body">
        <TextField path={['title']} label="Title" max={160} className="input-title" />
        <div className="fields-2">
          <TextField path={['as_of']} label="Facts current as of" type="date" />
          <TextField path={['content_warning']} label="Content warning" optional max={400} hint="Shown before the dive starts." />
        </div>
        <TextField path={['question', 'prompt']} label="The question" max={240} />
        <div className="fields-2">
          <TextField path={['question', 'scale', 'left_label']} label="Slider left label (0)" max={80} />
          <TextField path={['question', 'scale', 'right_label']} label="Slider right label (100)" max={80} />
        </div>
      </div>
    </details>
  );
});

const FactItem = memo(function FactItem({ fact, index, count, ids, flags }: { fact: Fact; index: number; count: number; ids: string[]; flags: FactCheckFlag[] | undefined }) {
  const { update } = useEditor();
  return (
    <div className="sub-item" id={fieldDomId(`starting_facts.${index}`)} tabIndex={-1}>
      <div className="sub-item-head">
        <span className="small faint">Fact {index + 1}</span>
        <span className="spacer" />
        <ItemTools
          index={index}
          count={count}
          noun="starting fact"
          onMove={(to) => update((d) => moveAt(d, ['starting_facts'], index, to))}
          onRemove={() => update((d) => removeAt(d, ['starting_facts'], index))}
        />
      </div>
      <TextField path={['starting_facts', index, 'text']} label="Text" multiline max={400} />
      <div className="fields-3">
        <SelectField path={['starting_facts', index, 'confidence']} label="Confidence" options={CONFIDENCE_OPTIONS} />
        <IdField path={['starting_facts', index, 'id']} label="Fact id" taken={ids} rename={(from, to) => update((d) => renameFactId(d, from, to))} />
      </div>
      <SourceIdsField path={['starting_facts', index, 'source_ids']} />
      <EvidenceEditor path={['starting_facts', index, 'evidence']} citedIds={fact.source_ids ?? EMPTY} />
      {flags?.length ? (
        <div className="flags">
          <div className="kicker">Fact-checker</div>
          <ul className="flag-list">
            {flags.map((ff) => (
              <FactCheckItem key={ff.index} f={ff} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
});

export const StartingFactsEditor = memo(function StartingFactsEditor({ factFlags }: { factFlags: Map<string, FactCheckFlag[]> }) {
  const { update } = useEditor();
  const readOnly = useReadOnly();
  const facts = useDoc((d) => d.starting_facts ?? EMPTY);
  const ids = useIds(facts);
  return (
    <details className="card" open id={fieldDomId('starting_facts')}>
      <CardHeader path="starting_facts" title={`Starting facts (${facts.length})`} />
      <div className="card-body">
        <p className="small muted">The agreed, no-spin baseline shown first, on one screen.</p>
        {facts.map((f, i) => (
          <FactItem key={i} fact={f} index={i} count={facts.length} ids={ids} flags={factFlags.get(f.id)} />
        ))}
        {readOnly ? null : (
          <button type="button" className="btn btn-small" onClick={() => update((d) => insertAt(d, ['starting_facts'], facts.length, newFact(d)))}>
            + Add starting fact
          </button>
        )}
      </div>
    </details>
  );
});

const SideItem = memo(function SideItem({ side, index, count, ids, favoredBy, reviewRefs }: { side: Side; index: number; count: number; ids: string[]; favoredBy: number; reviewRefs: string }) {
  const { update } = useEditor();
  return (
    <div className="sub-item" id={fieldDomId(`sides.${index}`)} tabIndex={-1}>
      <div className="sub-item-head">
        <span className="small faint">
          Side {index + 1} · {favoredBy} step{favoredBy === 1 ? '' : 's'} favor it
          {reviewRefs ? ` · named by ${reviewRefs} in the review record` : ''}
        </span>
        <span className="spacer" />
        <ItemTools
          index={index}
          count={count}
          noun="side"
          onMove={(to) => update((d) => moveAt(d, ['sides'], index, to))}
          onRemove={() => update((d) => removeAt(d, ['sides'], index))}
          removeBlockedBy={
            reviewRefs
              ? `This side is named by ${reviewRefs} in the pipeline's review record, so removing it would leave review entries pointing at nothing. Rename it instead, or send the case back with Request changes.`
              : null
          }
        />
      </div>
      <div className="fields-2">
        <TextField path={['sides', index, 'label']} label="Label" max={80} />
        <IdField path={['sides', index, 'id']} label="Side id" taken={ids} rename={(from, to) => update((d) => renameSideId(d, from, to))} />
      </div>
      <TextField path={['sides', index, 'steelman']} label="Steelman" multiline max={2000} />
    </div>
  );
});

export const SidesEditor = memo(function SidesEditor() {
  const { update } = useEditor();
  const readOnly = useReadOnly();
  const sides = useDoc((d) => d.sides ?? EMPTY);
  // Strings, so this editor re-renders only when the counts change (not on every keystroke in a step).
  const favoredKey = useDoc((d) => (d.sides ?? []).map((s) => (d.steps ?? []).filter((st) => st.favors === s.id).length).join(','));
  const refsKey = useDoc((d) => JSON.stringify((d.sides ?? []).map((s) => sideReviewReferences(d, s.id).join(', '))));
  const favored = favoredKey ? favoredKey.split(',').map(Number) : [];
  const refs = JSON.parse(refsKey) as string[];
  const ids = useIds(sides);
  return (
    <details className="card" open id={fieldDomId('sides')}>
      <CardHeader path="sides" title={`Sides and steelmen (${sides.length})`} />
      <div className="card-body">
        <p className="small muted">The strongest case for each side, in its own words.</p>
        {sides.map((s, i) => (
          <SideItem key={i} side={s} index={i} count={sides.length} ids={ids} favoredBy={favored[i] ?? 0} reviewRefs={refs[i] ?? ''} />
        ))}
        {readOnly ? null : (
          <button type="button" className="btn btn-small" onClick={() => update((d) => insertAt(d, ['sides'], sides.length, newSide(d)))}>
            + Add side
          </button>
        )}
      </div>
    </details>
  );
});

export const OpenQuestionsEditor = memo(function OpenQuestionsEditor() {
  const { update } = useEditor();
  const readOnly = useReadOnly();
  const qs = useDoc((d) => d.open_questions ?? EMPTY);
  const own = useIssuesAt('open_questions');
  return (
    <details className="card" open id={fieldDomId('open_questions')}>
      <CardHeader path="open_questions" title={`Open questions (${qs.length})`} />
      <div className="card-body">
        <p className="small muted">What is still unknown, shown at the end of the dive.</p>
        <IssueList errors={own.errors} warnings={own.warnings} />
        {qs.map((_, i) => (
          <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <TextField path={['open_questions', i]} label={`Question ${i + 1}`} multiline max={400} />
            </div>
            <ItemTools
              index={i}
              count={qs.length}
              noun="open question"
              onMove={(to) => update((d) => moveAt(d, ['open_questions'], i, to))}
              onRemove={() => update((d) => removeAt(d, ['open_questions'], i))}
            />
          </div>
        ))}
        {readOnly ? null : (
          <button type="button" className="btn btn-small" onClick={() => update((d) => insertAt(d, ['open_questions'], qs.length, ''))}>
            + Add open question
          </button>
        )}
      </div>
    </details>
  );
});

const SourceItem = memo(function SourceItem({ source, index, count, ids, citedBy }: { source: Source; index: number; count: number; ids: string[]; citedBy: string }) {
  const { update } = useEditor();
  const s = source;
  return (
    <div className="sub-item" id={fieldDomId(`sources.${index}`)} tabIndex={-1}>
      <div className="sub-item-head">
        <span className="mono small">{s.id}</span>
        <span className="small faint">· cited by {citedBy || 'nothing'}</span>
        <span className="spacer" />
        {s.url ? (
          <a href={safeHref(s.url) ?? undefined} target="_blank" rel="noreferrer noopener" className="small">
            Open ↗
          </a>
        ) : null}
        <ItemTools index={index} count={count} noun="source" onRemove={() => update((d) => removeAt(d, ['sources'], index))} />
      </div>
      <TextField path={['sources', index, 'title']} label="Title" max={300} />
      <div className="fields-3">
        <TextField path={['sources', index, 'publisher']} label="Publisher" max={200} />
        <SelectField path={['sources', index, 'type']} label="Type" options={SOURCE_TYPE_OPTIONS} />
        <TextField path={['sources', index, 'date']} label="Date" placeholder="YYYY, YYYY-MM or YYYY-MM-DD" />
        <IdField path={['sources', index, 'id']} label="Source id" taken={ids} rename={(from, to) => update((d) => renameSourceId(d, from, to))} />
      </div>
      <div className="fields-2">
        <TextField path={['sources', index, 'url']} label="URL" type="url" />
        <TextField path={['sources', index, 'accessed_at']} label="Accessed at" placeholder="2026-10-08T12:00:00Z" />
      </div>
      <TextField path={['sources', index, 'quote_excerpt']} label="Quote excerpt" optional multiline max={1200} />
    </div>
  );
});

export const SourcesEditor = memo(function SourcesEditor() {
  const { update } = useEditor();
  const readOnly = useReadOnly();
  const sources = useDoc((d) => d.sources ?? EMPTY);
  // A string, so typing in a step's text does not re-render all the sources.
  const citedKey = useDoc((d) => {
    const cited = citationsBySource(d);
    return JSON.stringify((d.sources ?? []).map((s) => cited.get(s.id)?.join(', ') ?? ''));
  });
  const cited = JSON.parse(citedKey) as string[];
  const ids = useIds(sources);
  return (
    <details className="card" open id={fieldDomId('sources')}>
      <CardHeader path="sources" title={`Sources (${sources.length})`} />
      <div className="card-body">
        {sources.map((s, i) => (
          <SourceItem key={i} source={s} index={i} count={sources.length} ids={ids} citedBy={cited[i] ?? ''} />
        ))}
        {readOnly ? null : (
          <button type="button" className="btn btn-small" onClick={() => update((d) => insertAt(d, ['sources'], sources.length, newSource(d)))}>
            + Add source
          </button>
        )}
      </div>
    </details>
  );
});
