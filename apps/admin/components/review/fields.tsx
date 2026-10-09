'use client';

import { useEffect, useState } from 'react';
import type { Issue } from '@sia/case-schema';
import { safeHref } from '@/lib/format';
import { fieldDomId, idProblem, pathToString, toggleId, type Path } from '@/lib/working-copy';
import { useDocAt, useEditor, useIssuesAt, useIssuesUnder, useReadOnly, useSources } from './editor-context';

export function IssueList({ errors, warnings, id }: { errors: Issue[]; warnings: Issue[]; id?: string }) {
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <ul className="field-issues" id={id}>
      {errors.map((i, n) => (
        <li key={`e${n}`} className="issue-error">
          {i.message}
        </li>
      ))}
      {warnings.map((i, n) => (
        <li key={`w${n}`} className="issue-warning">
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function useFieldIssues(path: Path, deep = false) {
  const p = pathToString(path);
  // `deep` also shows issues on a list's items, e.g. `source_ids.0` (unknown source).
  const at = useIssuesAt(p);
  const under = useIssuesUnder(p);
  return deep ? under : at;
}

const invalidClass = (errors: Issue[], warnings: Issue[]) => (errors.length ? 'input-invalid' : warnings.length ? 'input-warn' : '');

/** A text field bound to `path`. `optional` removes the key when emptied. */
export function TextField({
  path,
  label,
  max,
  multiline,
  optional,
  className,
  placeholder,
  hint,
  type = 'text',
}: {
  path: Path;
  label: string;
  max?: number;
  multiline?: boolean;
  optional?: boolean;
  className?: string;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'url' | 'date';
}) {
  const { set, setOptional } = useEditor();
  const readOnly = useReadOnly();
  const raw = useDocAt(path);
  const value = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw);
  const { errors, warnings } = useFieldIssues(path);
  const id = fieldDomId(pathToString(path));
  const onChange = (v: string) => (optional ? setOptional(path, v) : set(path, v));
  const common = {
    id,
    value,
    readOnly,
    placeholder,
    'aria-invalid': errors.length > 0 || undefined,
    'aria-describedby': errors.length || warnings.length ? `${id}-issues` : undefined,
    className: `${className ?? ''} ${invalidClass(errors, warnings)}`.trim(),
  };
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {optional ? <span className="faint"> · optional</span> : null}
        {max ? (
          <span className="field-count" style={value.length > max ? { color: 'var(--error)' } : undefined}>
            {value.length}/{max}
          </span>
        ) : null}
      </span>
      {multiline ? (
        <textarea {...common} rows={2} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type={type} onChange={(e) => onChange(e.target.value)} />
      )}
      {hint ? <span className="field-hint">{hint}</span> : null}
      <IssueList errors={errors} warnings={warnings} id={`${id}-issues`} />
    </label>
  );
}

/** A select bound to `path`; with `optional`, the empty choice removes the key. */
export function SelectField({
  path,
  label,
  options,
  optional,
  emptyLabel = '—',
}: {
  path: Path;
  label: string;
  options: readonly { value: string; label: string }[];
  optional?: boolean;
  emptyLabel?: string;
}) {
  const { set } = useEditor();
  const readOnly = useReadOnly();
  const raw = useDocAt(path);
  const value = typeof raw === 'string' ? raw : '';
  const { errors, warnings } = useFieldIssues(path);
  const id = fieldDomId(pathToString(path));
  const known = options.some((o) => o.value === value);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        id={id}
        value={value}
        disabled={readOnly}
        className={invalidClass(errors, warnings)}
        onChange={(e) => set(path, e.target.value === '' && optional ? undefined : e.target.value)}
      >
        {optional || !known ? <option value="">{value && !known ? `${value} (unknown)` : emptyLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <IssueList errors={errors} warnings={warnings} />
    </label>
  );
}

/** The ids of cited sources as chips, with a picker to cite another source. */
export function SourceIdsField({ path, label = 'Sources' }: { path: Path; label?: string }) {
  const { set } = useEditor();
  const readOnly = useReadOnly();
  const sources = useSources();
  const ids = (useDocAt(path) as string[] | undefined) ?? [];
  const { errors, warnings } = useFieldIssues(path, true);
  const id = fieldDomId(pathToString(path));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const available = sources.filter((s) => !ids.includes(s.id));
  return (
    <div className="field" id={id} tabIndex={-1}>
      <span className="field-label">{label}</span>
      <div className="chips">
        {ids.length === 0 ? <span className="empty small">None cited</span> : null}
        {ids.map((sid) => {
          const s = byId.get(sid);
          return (
            <span key={sid} className={`chip ${s ? '' : 'chip-missing'}`} title={s ? `${sid}: ${s.title} — ${s.publisher} (${s.type.replace('_', ' ')}, ${s.date})` : 'Unknown source'}>
              {/* Type and publisher first: they decide reported vs established; only the title is truncated. */}
              <span className={`chip-type chip-type-${s?.type ?? 'unknown'}`}>{s ? s.type.replace('_', ' ') : 'unknown'}</span>
              <span className="chip-pub">{s ? s.publisher : sid}</span>
              {s ? (
                <a className="chip-text" href={safeHref(s.url) ?? undefined} target="_blank" rel="noreferrer noopener">
                  {s.title || sid}
                </a>
              ) : null}
              {readOnly ? null : (
                <button type="button" aria-label={`Remove source ${sid}`} onClick={() => set(path, toggleId(ids, sid, false))}>
                  ×
                </button>
              )}
            </span>
          );
        })}
        {readOnly || available.length === 0 ? null : (
          <select
            aria-label={`Cite a source (${label})`}
            value=""
            style={{ width: 'auto', maxWidth: 260 }}
            onChange={(e) => e.target.value && set(path, toggleId(ids, e.target.value, true))}
          >
            <option value="">+ Cite a source…</option>
            {available.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}: {s.title || '(untitled)'}
              </option>
            ))}
          </select>
        )}
      </div>
      <IssueList errors={errors} warnings={warnings} />
    </div>
  );
}

/** A single source id (document and quote layers, evidence quotes). */
export function SourceIdField({ path, label = 'Source', restrictTo }: { path: Path; label?: string; restrictTo?: string[] }) {
  const sources = useSources();
  const options = sources
    .filter((s) => !restrictTo || restrictTo.includes(s.id))
    .map((s) => ({ value: s.id, label: `${s.id}: ${s.title || '(untitled)'}` }));
  return <SelectField path={path} label={label} options={options} emptyLabel="Pick a source…" />;
}

/**
 * An id that other parts of the document refer to. The rename is applied on
 * blur (with every reference updated by `rename`), never while typing, so a
 * half-typed id cannot collide with another one.
 */
export function IdField({
  path,
  label = 'Id',
  taken,
  rename,
}: {
  path: Path;
  label?: string;
  taken: string[];
  rename: (from: string, to: string) => void;
}) {
  const readOnly = useReadOnly();
  const current = String(useDocAt(path) ?? '');
  const [draft, setDraft] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);
  const { errors, warnings } = useFieldIssues(path);
  useEffect(() => setDraft(current), [current]);
  const id = fieldDomId(pathToString(path));
  const commit = () => {
    const next = draft.trim();
    const p = idProblem(next, taken.filter((t) => t !== current), current);
    if (p) {
      setProblem(p);
      setDraft(current);
      return;
    }
    setProblem(null);
    if (next !== current) rename(current, next);
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        id={id}
        type="text"
        className={`mono ${invalidClass(errors, warnings)}`}
        value={draft}
        readOnly={readOnly}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {problem ? <span className="field-issues issue-error small">{problem}</span> : null}
      <IssueList errors={errors} warnings={warnings} />
    </label>
  );
}

/** Small icon buttons for list items: move up, move down, remove. */
export function ItemTools({
  index,
  count,
  onMove,
  onRemove,
  noun,
  removeBlockedBy,
}: {
  index: number;
  count: number;
  onMove?: (to: number) => void;
  onRemove?: () => void;
  noun: string;
  /** Why this item cannot be removed (shown instead of removing). */
  removeBlockedBy?: string | null;
}) {
  const readOnly = useReadOnly();
  if (readOnly) return null;
  return (
    <span className="card-tools">
      {onMove ? (
        <>
          <button type="button" className="btn btn-icon" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label={`Move ${noun} up`} title="Move up">
            ↑
          </button>
          <button type="button" className="btn btn-icon" disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label={`Move ${noun} down`} title="Move down">
            ↓
          </button>
        </>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="btn btn-icon btn-danger"
          onClick={() => {
            if (removeBlockedBy) {
              window.alert(removeBlockedBy);
              return;
            }
            if (window.confirm(`Remove this ${noun}?`)) onRemove();
          }}
          aria-label={`Remove ${noun}`}
          title="Remove"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
