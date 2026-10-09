'use client';

import { memo } from 'react';
import { CONFIDENCE_LEVELS, IMPACT_LEVELS, NEUTRAL, type Layer, type LayerKind, type Side, type Step } from '@sia/case-schema';
import type { StepFlags } from '@/lib/step-flags';
import {
  addStep,
  fieldDomId,
  getAt,
  insertAt,
  moveAt,
  moveStep,
  newLayer,
  removeAt,
  removeStep,
  renameLayerId,
  renameStepId,
  setAt,
  type Doc,
  type Path,
} from '@/lib/working-copy';
import { useDocAt, useEditor, useIssuesUnder, useReadOnly } from './editor-context';
import { IdField, ItemTools, SelectField, SourceIdField, SourceIdsField, TextField } from './fields';
import { FlagsPanel } from './FlagsPanel';

const CONFIDENCE_OPTIONS = CONFIDENCE_LEVELS.map((c) => ({ value: c, label: c }));
const IMPACT_OPTIONS = IMPACT_LEVELS.map((c) => ({ value: c, label: c }));
const LAYER_KINDS: { value: LayerKind; label: string }[] = [
  { value: 'document', label: 'Document' },
  { value: 'quote', label: 'Quote' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'context', label: 'Context' },
];

/** Evidence quotes (admin-only) for a step or a starting fact. */
export function EvidenceEditor({ path, citedIds }: { path: Path; citedIds: string[] }) {
  const { update } = useEditor();
  const readOnly = useReadOnly();
  const list = (useDocAt(path) as { source_id: string; quote: string }[] | undefined) ?? [];
  const setList = (fn: (d: Doc) => Doc) => update(fn);
  return (
    <div className="subsection" id={fieldDomId([...path].join('.'))} tabIndex={-1}>
      <h4>
        Evidence quotes <span className="faint small">admin-only · {list.length}</span>
      </h4>
      {list.length === 0 ? <p className="empty small">No supporting quotes recorded.</p> : null}
      {list.map((e, j) => (
        <div key={j} className="sub-item">
          <div className="sub-item-head">
            <span className="small faint">Quote {j + 1}</span>
            <span className="spacer" />
            <ItemTools index={j} count={list.length} noun="evidence quote" onRemove={() => setList((d) => withoutEmptyList(removeAt(d, path, j), path))} />
          </div>
          <SourceIdField path={[...path, j, 'source_id']} restrictTo={citedIds.length ? citedIds : undefined} />
          <TextField path={[...path, j, 'quote']} label="Quote (verbatim)" multiline max={1500} />
        </div>
      ))}
      {readOnly ? null : (
        <button type="button" className="btn btn-small" onClick={() => setList((d) => insertAt(d, path, list.length, { source_id: citedIds[0] ?? '', quote: '' }))}>
          + Add evidence quote
        </button>
      )}
    </div>
  );
}

/** Evidence is optional: an emptied list is removed rather than stored as []. */
function withoutEmptyList(d: Doc, path: Path): Doc {
  const v = getAt(d, path);
  return Array.isArray(v) && v.length === 0 ? setAt(d, path, undefined) : d;
}

function LayerEditor({ stepIndex, layerIndex, layer, count, takenIds }: { stepIndex: number; layerIndex: number; layer: Layer; count: number; takenIds: string[] }) {
  const { update } = useEditor();
  const readOnly = useReadOnly();
  const base: Path = ['steps', stepIndex, 'depth', layerIndex];
  return (
    <div className="sub-item" id={fieldDomId(base.join('.'))} tabIndex={-1}>
      <div className="sub-item-head">
        <span className="badge">{layer.kind}</span>
        <span className="spacer" />
        <ItemTools
          index={layerIndex}
          count={count}
          noun="depth layer"
          onMove={(to) => update((d) => moveAt(d, ['steps', stepIndex, 'depth'], layerIndex, to))}
          onRemove={() => update((d) => removeAt(d, ['steps', stepIndex, 'depth'], layerIndex))}
        />
      </div>
      <div className="fields-3">
        <IdField path={[...base, 'id']} label="Layer id" taken={takenIds} rename={(from, to) => update((d) => renameLayerId(d, stepIndex, from, to))} />
        {layer.kind === 'document' || layer.kind === 'quote' ? <SourceIdField path={[...base, 'source_id']} /> : null}
        {layer.kind === 'quote' ? <TextField path={[...base, 'speaker']} label="Speaker" max={200} /> : null}
      </div>
      {layer.kind === 'document' ? (
        <>
          <TextField path={[...base, 'title']} label="Title" max={200} />
          <TextField path={[...base, 'summary']} label="Summary" multiline max={1200} />
        </>
      ) : null}
      {layer.kind === 'quote' ? (
        <>
          <TextField path={[...base, 'text']} label="Quote" multiline max={1200} />
          <TextField path={[...base, 'context']} label="Context" optional multiline max={400} />
        </>
      ) : null}
      {layer.kind === 'context' ? (
        <>
          <TextField path={[...base, 'title']} label="Title" max={200} />
          <TextField path={[...base, 'body']} label="Body" multiline max={1500} />
          <SourceIdsField path={[...base, 'source_ids']} />
        </>
      ) : null}
      {layer.kind === 'timeline' ? (
        <>
          <TextField path={[...base, 'title']} label="Title" max={200} />
          {layer.entries.map((_, k) => (
            <div key={k} className="sub-item">
              <div className="sub-item-head">
                <span className="small faint">Entry {k + 1}</span>
                <span className="spacer" />
                <ItemTools index={k} count={layer.entries.length} noun="timeline entry" onRemove={() => update((d) => removeAt(d, [...base, 'entries'], k))} />
              </div>
              <div className="fields-2">
                <TextField path={[...base, 'entries', k, 'date']} label="Date" placeholder="YYYY, YYYY-MM or YYYY-MM-DD" />
                <SourceIdsField path={[...base, 'entries', k, 'source_ids']} />
              </div>
              <TextField path={[...base, 'entries', k, 'text']} label="Text" multiline max={400} />
            </div>
          ))}
          {readOnly ? null : (
            <button type="button" className="btn btn-small" onClick={() => update((d) => insertAt(d, [...base, 'entries'], layer.entries.length, { date: '', text: '', source_ids: [] }))}>
              + Add timeline entry
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}

/**
 * One step, editable inline. Memoized: typing in another step does not
 * re-render this one (its `step` object is unchanged by setAt).
 */
export const StepCard = memo(function StepCard({
  step,
  index,
  count,
  sides,
  flags,
  stepIds,
}: {
  step: Step;
  index: number;
  count: number;
  sides: Side[];
  flags: StepFlags | undefined;
  stepIds: string[];
}) {
  const { update } = useEditor();
  const readOnly = useReadOnly();
  const path = `steps.${index}`;
  const { errors, warnings } = useIssuesUnder(path);
  const favorsOptions = [...sides.map((s) => ({ value: s.id, label: s.label || s.id })), { value: NEUTRAL, label: 'Neutral' }];
  const layerIds = (step.depth ?? []).map((l) => l.id);
  const favorsLabel = step.favors === NEUTRAL ? 'neutral' : (sides.find((s) => s.id === step.favors)?.label ?? step.favors);
  return (
    <details className={`card step-card ${errors.length ? 'card-has-errors' : ''}`} id={fieldDomId(path)} open data-testid={`step-card-${step.id}`} data-step-id={step.id}>
      <summary>
        <span className="card-order">{step.order}</span>
        <span className="card-title">{step.headline || <span className="empty">Untitled step</span>}</span>
        <span className="row small">
          <span className="badge">{step.confidence}</span>
          {favorsLabel ? <span className="badge">favors {favorsLabel}</span> : <span className="badge badge-warn">no favors tag</span>}
          {step.impact ? <span className="badge">{step.impact} impact</span> : null}
          {flags?.attention ? <span className="badge badge-warn">{flags.attention} flag{flags.attention === 1 ? '' : 's'}</span> : null}
          {errors.length ? <span className="badge badge-error">{errors.length} error{errors.length === 1 ? '' : 's'}</span> : null}
          {warnings.length ? <span className="badge badge-warn">{warnings.length} warning{warnings.length === 1 ? '' : 's'}</span> : null}
        </span>
      </summary>
      <div className="card-body">
        <div className="row-between" style={{ marginBottom: 8 }}>
          <span className="small faint">
            Step {step.order} of {count} · id <span className="mono">{step.id}</span>
          </span>
          {readOnly ? null : (
            <span className="row">
              <button type="button" className="btn btn-small" onClick={() => update((d) => addStep(d, index).doc)}>
                + Insert step after
              </button>
              <ItemTools index={index} count={count} noun="step" onMove={(to) => update((d) => moveStep(d, index, to))} onRemove={() => update((d) => removeStep(d, index))} />
            </span>
          )}
        </div>
        <TextField path={['steps', index, 'headline']} label="Headline" max={160} className="input-headline" />
        <TextField path={['steps', index, 'body']} label="Body" multiline max={450} hint="1–3 short sentences in everyday words (about 8th-grade reading level). Detail goes in Go deeper." />
        <div className="fields-3">
          <SelectField path={['steps', index, 'confidence']} label="Confidence" options={CONFIDENCE_OPTIONS} />
          <SelectField path={['steps', index, 'favors']} label="Favors (admin-only)" options={favorsOptions} optional emptyLabel="Untagged" />
          <SelectField path={['steps', index, 'impact']} label="Impact (admin-only)" options={IMPACT_OPTIONS} optional emptyLabel="Not set (medium)" />
          <IdField path={['steps', index, 'id']} label="Step id" taken={stepIds} rename={(from, to) => update((d) => renameStepId(d, from, to))} />
        </div>
        <SourceIdsField path={['steps', index, 'source_ids']} />
        <TextField
          path={['steps', index, 'micro_poll', 'statement']}
          label="Fact vote statement"
          max={200}
          hint="One plain statement readers agree or disagree with, e.g. “The DA should have read her full interview.”"
        />

        <div className="subsection" id={fieldDomId(`${path}.depth`)} tabIndex={-1}>
          <h4>
            Go deeper <span className="faint small">{(step.depth ?? []).length} layer{(step.depth ?? []).length === 1 ? '' : 's'}</span>
          </h4>
          {(step.depth ?? []).map((layer, j) => (
            <LayerEditor key={`${j}:${layer.kind}`} stepIndex={index} layerIndex={j} layer={layer} count={step.depth.length} takenIds={layerIds} />
          ))}
          {readOnly ? null : (
            <select
              aria-label="Add a depth layer"
              value=""
              style={{ width: 'auto' }}
              onChange={(e) => {
                const kind = e.target.value as LayerKind;
                if (!kind) return;
                update((d) => insertAt(d, ['steps', index, 'depth'], (d.steps[index]?.depth ?? []).length, newLayer(kind, layerIds, step.source_ids[0] ?? '')));
              }}
            >
              <option value="">+ Add a depth layer…</option>
              {LAYER_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          )}
        </div>

        <EvidenceEditor path={['steps', index, 'evidence']} citedIds={step.source_ids ?? []} />
        <FlagsPanel flags={flags} sides={sides} stepId={step.id} />
      </div>
    </details>
  );
});
