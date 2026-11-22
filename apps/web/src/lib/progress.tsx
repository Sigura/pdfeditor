import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';

export type Activity = { id: number; label: string; since: number };
let activityId = 0;

export const useActivities = create<{ activities: Activity[] }>(() => ({ activities: [] }));

export function beginActivity(label: string): number {
  const id = ++activityId;
  useActivities.setState((s) => ({ activities: [...s.activities, { id, label, since: Date.now() }] }));
  return id;
}

export const progressActivity = (id: number, label: string) => useActivities.setState((s) => ({ activities: s.activities.map((a) => (a.id === id ? { ...a, label } : a)) }));

export const endActivity = (id: number) => useActivities.setState((s) => ({ activities: s.activities.filter((a) => a.id !== id) }));

/** Runs `fn` as a named activity, so a long wait shows progress. */
export async function track<T>(label: string, fn: (step: (label: string) => void) => Promise<T>): Promise<T> {
  const id = beginActivity(label);
  try {
    return await fn((l) => progressActivity(id, l));
  } finally {
    endActivity(id);
  }
}

const PROGRESS_AFTER_MS = 300;

/** Status bar: the latest running activity once something has run for 0.3 s, with the elapsed time; `idle` otherwise. */
export function StatusBar({ idle }: { idle: ReactNode }) {
  const activities = useActivities((s) => s.activities);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activities.length) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [activities.length]);
  const oldest = activities[0];
  const running = oldest && now - oldest.since >= PROGRESS_AFTER_MS;
  return (
    <footer data-testid="status-bar" className="flex h-7 shrink-0 items-center gap-2 border-t border-slate-200 bg-white px-4 text-xs text-slate-600">
      {running ? (
        <span data-testid="progress" className="flex items-center gap-2 text-slate-900">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-sky-600" />
          <span role="status">{activities.at(-1)!.label}</span>
          <span aria-hidden className="tabular-nums text-slate-500">{((now - oldest.since) / 1000).toFixed(1)} s</span>
        </span>
      ) : (
        <span role="status" data-testid="status-idle">{idle}</span>
      )}
    </footer>
  );
}
