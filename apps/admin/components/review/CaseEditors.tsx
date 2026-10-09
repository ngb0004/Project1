'use client';

import { memo, useMemo } from 'react';
import { CHECK_VERDICTS, CONFIDENCE_LEVELS, SOURCE_TYPES, TAKE_LENSES, type Fact, type Side, type Source, type Take } from '@sia/case-schema';
import { safeHref } from '@/lib/format';
import type { FactCheckFlag } from '@/lib/step-flags';
import {
  citationsBySource,
  fieldDomId,
  insertAt,
  moveAt,
  newFact,
  newCheck,
  newEvent,
  newSide,
  newSource,
  newTake,
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
const LENS_OPTIONS = TAKE_LENSES.map((l) => ({ value: l, label: l }));
const VERDICT_OPTIONS = CHECK_VERDICTS.map((v) => ({ value: v, label: v.replace('_', ' ') }));
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
        <TextField
          path={['question', 'prompt']}
          label="The question"
          max={240}
          hint="One plain statement about what people are arguing over, rated from Disagree to Agree."
        />
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

export const TimelineEditor = memo(function TimelineEditor() {
  const { update } = useEditor();
  const readOnly = useReadOnly();
  const events = useDoc((d) => d.timeline ?? EMPTY);
  const ids = useIds(events);
  return (
    <details className="card" open id={fieldDomId('timeline')}>
      <CardHeader path="timeline" title={`What happened, in order (${events.length})`} />
      <div className="card-body">
        <p className="small muted">A dated recap shown after the facts, oldest first. One short, plain sentence each, with a source.</p>
        {events.map((e, i) => (
          <div key={i} className="sub-item" id={fieldDomId(`timeline.${i}`)} tabIndex={-1}>
            <div className="sub-item-head">
              <span className="small faint">Event {i + 1}</span>
              <span className="spacer" />
              <ItemTools
                index={i}
                count={events.length}
                noun="event"
                onMove={(to) => update((d) => moveAt(d, ['timeline'], i, to))}
                onRemove={() => update((d) => removeAt(d, ['timeline'], i))}
              />
            </div>
            <div className="fields-3">
              <TextField path={['timeline', i, 'date']} label="Date" placeholder="YYYY, YYYY-MM or YYYY-MM-DD" />
              <IdField
                path={['timeline', i, 'id']}
                label="Event id"
                taken={ids}
                rename={(_from, to) => update((d) => ({ ...d, timeline: (d.timeline ?? []).map((x, j) => (j === i ? { ...x, id: to } : x)) }))}
              />
            </div>
            <TextField path={['timeline', i, 'text']} label="What happened" multiline max={240} />
            <SourceIdsField path={['timeline', i, 'source_ids']} />
            <EvidenceEditor path={['timeline', i, 'evidence']} citedIds={e.source_ids ?? EMPTY} />
          </div>
        ))}
        {readOnly ? null : (
          <button type="button" className="btn btn-small" onClick={() => update((d) => insertAt(d, ['timeline'], events.length, newEvent(d)))}>
            + Add event
          </button>
        )}
      </div>
    </details>
  );
});

const TakeItem = memo(function TakeItem({ take, index, count, ids }: { take: Take; index: number; count: number; ids: string[] }) {
  const { update } = useEditor();
  const readOnly = useReadOnly();
  const checks = take.checks ?? EMPTY;
  return (
    <div className="sub-item" id={fieldDomId(`takes.${index}`)} tabIndex={-1}>
      <div className="sub-item-head">
        <span className="small faint">
          Take {index + 1} · {take.lens}
        </span>
        <span className="spacer" />
        <ItemTools
          index={index}
          count={count}
          noun="take"
          onMove={(to) => update((d) => moveAt(d, ['takes'], index, to))}
          onRemove={() => update((d) => removeAt(d, ['takes'], index))}
        />
      </div>
      <div className="fields-3">
        <SelectField path={['takes', index, 'lens']} label="Lens" options={LENS_OPTIONS} />
        <TextField path={['takes', index, 'label']} label="Label" max={80} />
        <IdField
          path={['takes', index, 'id']}
          label="Take id"
          taken={ids}
          rename={(_from, to) => update((d) => ({ ...d, takes: (d.takes ?? []).map((t, i) => (i === index ? { ...t, id: to } : t)) }))}
        />
      </div>
      <TextField path={['takes', index, 'summary']} label="The take, in its own voice" multiline max={600} />
      <TextField path={['takes', index, 'seen_on']} label="Seen on" optional max={160} hint="Where readers run into it, e.g. TikTok, Instagram, Fox News." />
      <SourceIdsField path={['takes', index, 'source_ids']} />
      <div className="subsection">
        <h4>Checks</h4>
        {checks.map((c, j) => (
          <div key={j} className="sub-item" id={fieldDomId(`takes.${index}.checks.${j}`)} tabIndex={-1}>
            <div className="sub-item-head">
              <span className="small faint">Check {j + 1}</span>
              <span className="spacer" />
              <ItemTools
                index={j}
                count={checks.length}
                noun="check"
                onMove={(to) => update((d) => moveAt(d, ['takes', index, 'checks'], j, to))}
                onRemove={() => update((d) => removeAt(d, ['takes', index, 'checks'], j))}
              />
            </div>
            <TextField path={['takes', index, 'checks', j, 'claim']} label="Claim" multiline max={300} />
            <SelectField path={['takes', index, 'checks', j, 'verdict']} label="Verdict" options={VERDICT_OPTIONS} />
            <TextField path={['takes', index, 'checks', j, 'note']} label="Why" multiline max={400} />
            <SourceIdsField path={['takes', index, 'checks', j, 'source_ids']} />
            <EvidenceEditor path={['takes', index, 'checks', j, 'evidence']} citedIds={c.source_ids ?? EMPTY} />
          </div>
        ))}
        {readOnly || checks.length >= 6 ? null : (
          <button type="button" className="btn btn-small" onClick={() => update((d) => insertAt(d, ['takes', index, 'checks'], checks.length, newCheck()))}>
            + Add check
          </button>
        )}
      </div>
    </div>
  );
});

export const TakesEditor = memo(function TakesEditor() {
  const { update } = useEditor();
  const readOnly = useReadOnly();
  const takes = useDoc((d) => d.takes ?? EMPTY);
  const ids = useIds(takes);
  return (
    <details className="card" open id={fieldDomId('takes')}>
      <CardHeader path="takes" title={`How it is told online (${takes.length})`} />
      <div className="card-body">
        <p className="small muted">
          The story as the left, the center and the right tell it on social media, each in its own voice, then each claim checked.
          Public posts may show what is being said, but a verdict needs reporting or records behind it.
        </p>
        {takes.map((t, i) => (
          <TakeItem key={i} take={t} index={i} count={takes.length} ids={ids} />
        ))}
        {readOnly ? null : (
          <button type="button" className="btn btn-small" onClick={() => update((d) => insertAt(d, ['takes'], takes.length, newTake(d)))}>
            + Add take
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
