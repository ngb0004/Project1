import { useEffect } from 'react';

/**
 * Web: while a dive is in progress, the browser asks before Back, a reload or
 * closing the tab unloads the page. (Answers are saved either way; this keeps
 * a reader who arrived from a shared link from leaving the site by accident.)
 */
export function useLeaveGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);
}
