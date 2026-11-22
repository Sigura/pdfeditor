import { useEffect, useState } from 'react';
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

const PROGRESS_AFTER_MS = 1500;

/** The latest running activity, once something has run for 1.5 s, with the elapsed time. */
export function ProgressBanner() {
  const activities = useActivities((s) => s.activities);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activities.length) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [activities.length]);
  const oldest = activities[0];
  if (!oldest || now - oldest.since < PROGRESS_AFTER_MS) return null;
  const latest = activities.at(-1)!;
  return (
    <div data-testid="progress" role="status" className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
      <span>{latest.label}</span>
      <span className="tabular-nums text-white/60">{((now - oldest.since) / 1000).toFixed(1)} s</span>
    </div>
  );
}
