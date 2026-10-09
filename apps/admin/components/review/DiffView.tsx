'use client';

import { Fragment, useMemo } from 'react';
import { diffCases, summarizeDiff, type CaseLike, type FieldChange, type ItemDiff, type TextOp } from '@sia/case-schema';

function BeforeText({ ops }: { ops: TextOp[] }) {
  return (
    <>
      {ops.map((o, i) =>
        o.op === 'insert' ? null : o.op === 'delete' ? (
          <del key={i} className="d-del">
            {o.text}
          </del>
        ) : (
          <span key={i}>{o.text}</span>
        ),
      )}
    </>
  );
}

function AfterText({ ops }: { ops: TextOp[] }) {
  return (
    <>
      {ops.map((o, i) =>
        o.op === 'delete' ? null : o.op === 'insert' ? (
          <ins key={i} className="d-ins">
            {o.text}
          </ins>
        ) : (
          <span key={i}>{o.text}</span>
        ),
      )}
    </>
  );
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '(none)';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isStringArray(v)) return v.join(', ');
  return JSON.stringify(v, null, 1);
}

function ListSide({ list, other, mark }: { list: string[]; other: string[]; mark: 'del' | 'ins' }) {
  if (list.length === 0) return <span className="empty">(none)</span>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {list.map((x, i) =>
        other.includes(x) ? (
          <li key={i}>{x}</li>
        ) : (
          <li key={i}>{mark === 'del' ? <del className="d-del">{x}</del> : <ins className="d-ins">{x}</ins>}</li>
        ),
      )}
    </ul>
  );
}

function FieldRows({ changes }: { changes: FieldChange[] }) {
  return (
    <div className="diff-grid">
      {changes.map((c) => (
        <FieldRow key={c.path} c={c} />
      ))}
    </div>
  );
}

function FieldRow({ c }: { c: FieldChange }) {
  const lists = isStringArray(c.before ?? []) && isStringArray(c.after ?? []) && (Array.isArray(c.before) || Array.isArray(c.after));
  return (
    <>
      <div className="diff-label">{c.label}</div>
      <div className="diff-cell">
        {c.text ? (
          <BeforeText ops={c.text} />
        ) : lists ? (
          <ListSide list={(c.before as string[]) ?? []} other={(c.after as string[]) ?? []} mark="del" />
        ) : (
          <del className="d-del">{formatValue(c.before)}</del>
        )}
      </div>
      <div className="diff-cell">
        {c.text ? (
          <AfterText ops={c.text} />
        ) : lists ? (
          <ListSide list={(c.after as string[]) ?? []} other={(c.before as string[]) ?? []} mark="ins" />
        ) : (
          <ins className="d-ins">{formatValue(c.after)}</ins>
        )}
      </div>
    </>
  );
}

type Kind = 'startingFacts' | 'steps' | 'sides' | 'sources';
type Item = Record<string, unknown>;

const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : JSON.stringify(v));

/** Every field of a depth layer, as label/value lines. */
function layerLines(layer: Item): [string, string][] {
  const out: [string, string][] = [];
  const add = (k: string, v: unknown) => {
    const t = str(v);
    if (t) out.push([k, t]);
  };
  add('Title', layer.title);
  add('Summary', layer.summary);
  add('Quote', layer.text && layer.kind === 'quote' ? layer.text : undefined);
  add('Speaker', layer.speaker);
  add('Context', layer.context);
  add('Body', layer.body);
  add('Source', layer.source_id);
  add('Sources', layer.source_ids);
  if (Array.isArray(layer.entries)) {
    (layer.entries as Item[]).forEach((e, i) => add(`Entry ${i + 1}`, `${String(e.date ?? '')}: ${String(e.text ?? '')}${Array.isArray(e.source_ids) && e.source_ids.length ? ` [${(e.source_ids as string[]).join(', ')}]` : ''}`));
  }
  return out;
}

/** All of an added or removed item's fields, so the reviewer sees what came in (or went out), not just its headline. */
function itemLines(kind: Kind, item: Item, sourceTitle: (id: string) => string): [string, string][] {
  const out: [string, string][] = [];
  const add = (label: string, v: unknown) => {
    const t = str(v);
    if (t) out.push([label, t]);
  };
  const cites = (ids: unknown) => (Array.isArray(ids) ? (ids as string[]).map((id) => `${id} (${sourceTitle(id)})`).join('; ') : undefined);
  if (kind === 'steps') {
    add('Headline', item.headline);
    add('Body', item.body);
    add('Confidence', item.confidence);
    add('Favors', item.favors);
    add('Impact', item.impact);
    add('Sources', cites(item.source_ids));
    add('Micro-poll', (item.micro_poll as Item | undefined)?.prompt);
    (Array.isArray(item.evidence) ? (item.evidence as Item[]) : []).forEach((e, i) => add(`Evidence ${i + 1}`, `“${String(e.quote ?? '')}” (${String(e.source_id ?? '')})`));
    (Array.isArray(item.depth) ? (item.depth as Item[]) : []).forEach((l) => {
      for (const [k, v] of layerLines(l)) out.push([`Depth › ${String(l.kind)} ${String(l.id)} › ${k}`, v]);
    });
  } else if (kind === 'startingFacts') {
    add('Text', item.text);
    add('Confidence', item.confidence);
    add('Sources', cites(item.source_ids));
    (Array.isArray(item.evidence) ? (item.evidence as Item[]) : []).forEach((e, i) => add(`Evidence ${i + 1}`, `“${String(e.quote ?? '')}” (${String(e.source_id ?? '')})`));
  } else if (kind === 'sides') {
    add('Label', item.label);
    add('Steelman', item.steelman);
  } else {
    add('Title', item.title);
    add('Publisher', item.publisher);
    add('Type', item.type);
    add('Date', item.date);
    add('URL', item.url);
    add('Accessed', item.accessed_at);
    add('Quote excerpt', item.quote_excerpt);
  }
  return out;
}

function WholeItem({ lines, side }: { lines: [string, string][]; side: 'before' | 'after' }) {
  return (
    <div className="diff-grid">
      {lines.map(([label, value], i) => (
        <Fragment key={i}>
          <div className="diff-label">{label}</div>
          <div className="diff-cell">{side === 'before' ? <del className="d-del">{value}</del> : <span className="faint">—</span>}</div>
          <div className="diff-cell">{side === 'after' ? <ins className="d-ins">{value}</ins> : <span className="faint">—</span>}</div>
        </Fragment>
      ))}
    </div>
  );
}
const KIND: Record<Kind, { title: string; noun: string; list: (c: CaseLike) => Record<string, unknown>[]; text: (x: Record<string, unknown>) => string }> = {
  startingFacts: { title: 'Starting facts', noun: 'fact', list: (c) => (c.starting_facts ?? []) as never, text: (x) => String(x.text ?? '') },
  steps: { title: 'Steps', noun: 'step', list: (c) => (c.steps ?? []) as never, text: (x) => String(x.headline ?? '') },
  sides: { title: 'Sides', noun: 'side', list: (c) => (c.sides ?? []) as never, text: (x) => String(x.label ?? '') },
  sources: { title: 'Sources', noun: 'source', list: (c) => (c.sources ?? []) as never, text: (x) => `${String(x.title ?? '')} — ${String(x.publisher ?? '')}` },
};

function ItemSection({ kind, items, before, after }: { kind: Kind; items: ItemDiff[]; before: CaseLike; after: CaseLike }) {
  const k = KIND[kind];
  const shown = items.filter((d) => d.status !== 'unchanged' || d.moved);
  const unchanged = items.length - shown.length;
  if (shown.length === 0) return null;
  const b = k.list(before);
  const a = k.list(after);
  const sourceTitle = (id: string) => {
    const src = [...((after.sources ?? []) as Item[]), ...((before.sources ?? []) as Item[])].find((x) => x.id === id);
    return src ? String(src.title ?? id) : 'unknown source';
  };
  return (
    <div style={{ marginTop: 20 }}>
      <h3>
        {k.title} <span className="small faint">{unchanged ? `· ${unchanged} unchanged` : ''}</span>
      </h3>
      {shown.map((d) => {
        const item = d.afterIndex !== null ? a[d.afterIndex] : d.beforeIndex !== null ? b[d.beforeIndex] : undefined;
        const pos =
          kind === 'steps' || kind === 'startingFacts'
            ? d.moved && d.beforeIndex !== null && d.afterIndex !== null
              ? ` · moved from position ${d.beforeIndex + 1} to ${d.afterIndex + 1}`
              : d.afterIndex !== null
                ? ` · position ${d.afterIndex + 1}`
                : ''
            : '';
        return (
          <div key={`${d.status}:${d.id}`} className={`diff-item diff-${d.status === 'unchanged' ? 'changed' : d.status}`} data-testid={`diff-${kind}-${d.id}`}>
            <div className="row small" style={{ marginBottom: 6 }}>
              <span className={`badge ${d.status === 'added' ? 'badge-ok' : d.status === 'removed' ? 'badge-error' : d.status === 'changed' ? 'badge-warn' : ''}`}>
                {d.status === 'unchanged' ? 'moved' : d.status}
              </span>
              {d.moved && d.status !== 'unchanged' ? <span className="badge">moved</span> : null}
              <span className="mono">{d.id}</span>
              <span className="faint">{pos}</span>
            </div>
            {d.status === 'added' && item ? <WholeItem lines={itemLines(kind, item, sourceTitle)} side="after" /> : null}
            {d.status === 'removed' && item ? <WholeItem lines={itemLines(kind, item, sourceTitle)} side="before" /> : null}
            {d.status === 'unchanged' && item ? <div className="muted">{k.text(item)}</div> : null}
            {d.changes.length ? <FieldRows changes={d.changes} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Side-by-side comparison with word-level highlights, from the shared diffCases(). */
export function DiffView({ before, after, beforeLabel, afterLabel }: { before: CaseLike; after: CaseLike; beforeLabel: string; afterLabel: string }) {
  const diff = useMemo(() => diffCases(before, after), [before, after]);
  const summary = useMemo(() => summarizeDiff(diff, after), [diff, after]);
  if (!diff.hasChanges) {
    return (
      <p className="notice notice-info" data-testid="diff-summary">
        No differences between {beforeLabel} and {afterLabel}.
      </p>
    );
  }
  return (
    <div data-testid="diff-view">
      <p className="notice notice-info" data-testid="diff-summary">
        {summary}
      </p>
      <p className="small muted">
        {diff.summary.added} added · {diff.summary.removed} removed · {diff.summary.changed} changed · {diff.summary.moved} moved (facts, steps, sides
        and sources)
      </p>
      <div className="diff-grid" style={{ marginTop: 12 }}>
        <div className="diff-col-head">{beforeLabel}</div>
        <div className="diff-col-head">{afterLabel}</div>
      </div>
      {diff.fields.length ? (
        <div style={{ marginTop: 8 }}>
          <h3>Case card and question</h3>
          <div className="diff-item diff-changed">
            <FieldRows changes={diff.fields} />
          </div>
        </div>
      ) : null}
      <ItemSection kind="startingFacts" items={diff.startingFacts} before={before} after={after} />
      <ItemSection kind="steps" items={diff.steps} before={before} after={after} />
      <ItemSection kind="sides" items={diff.sides} before={before} after={after} />
      <ItemSection kind="sources" items={diff.sources} before={before} after={after} />
    </div>
  );
}
