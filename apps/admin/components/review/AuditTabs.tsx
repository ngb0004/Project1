'use client';

import { useState } from 'react';

export interface AuditTab {
  key: string;
  label: string;
  count?: number;
  /** Rendered on the server. */
  content: React.ReactNode;
}

export function AuditTabs({ tabs }: { tabs: AuditTab[] }) {
  const [active, setActive] = useState(tabs[0]?.key ?? '');
  return (
    <div data-testid="audit-tabs">
      <div className="tabs" role="tablist" aria-label="Audit">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={t.key === active}
            aria-controls={`panel-${t.key}`}
            className="tab"
            onClick={() => setActive(t.key)}
          >
            {t.label}
            {t.count !== undefined ? <span className="count">{t.count}</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" id={`panel-${t.key}`} aria-labelledby={`tab-${t.key}`} hidden={t.key !== active}>
          {t.content}
        </div>
      ))}
    </div>
  );
}
