import { useEffect, useRef, useState, type RefObject } from 'react';
import { create } from 'zustand';

type Ask =
  | { kind: 'password'; message: string; resolve: (pw: string | null) => void }
  | { kind: 'confirm'; message: string; ok: string; resolve: (yes: boolean) => void };
const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

function cancelOpen() {
  const a = useAsk.getState().ask;
  if (a?.kind === 'password') a.resolve(null);
  else if (a) a.resolve(false);
}

// The focus to give back when a modal closes: autoFocus inside a modal happens before its effects run.
let lastOutside: HTMLElement | null = null;
document.addEventListener(
  'focusin',
  (e) => {
    if (e.target instanceof HTMLElement && !e.target.closest('[aria-modal="true"]')) lastOutside = e.target;
  },
  true,
);

/**
 * Keeps Tab inside the modal `ref` while it is shown and gives the focus back to where it was when it closes.
 * `open` changes when another dialog takes the same element.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: unknown) {
  useEffect(() => {
    if (!open) return;
    const before = lastOutside;
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key !== 'Tab' || !el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')).filter((x) => !(x as HTMLButtonElement).disabled);
      if (!items.length) return;
      const [first, last] = [items[0]!, items.at(-1)!];
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (before?.isConnected && (document.activeElement === document.body || !document.activeElement)) before.focus({ preventScroll: true });
    };
  }, [ref, open]);
}

/** Whether a modal dialog is open; page shortcuts stay off then, wherever the focus is. */
export const modalOpen = () => !!document.querySelector('[aria-modal="true"]');

/** Asks for a PDF password in a dialog; null when the user cancels. */
export function askPassword(message: string): Promise<string | null> {
  cancelOpen();
  return new Promise((resolve) => useAsk.setState({ ask: { kind: 'password', message, resolve } }));
}

/** Asks the user to confirm an action; `ok` labels the confirming button. */
export function askConfirm(message: string, ok: string): Promise<boolean> {
  cancelOpen();
  return new Promise((resolve) => useAsk.setState({ ask: { kind: 'confirm', message, ok, resolve } }));
}

export function Dialogs() {
  const ask = useAsk((s) => s.ask);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useModalFocus(formRef, !!ask);
  useEffect(() => {
    setValue('');
    (inputRef.current ?? okRef.current)?.focus();
  }, [ask]);
  if (!ask) return null;
  const done = (yes: boolean) => {
    useAsk.setState({ ask: null });
    if (ask.kind === 'password') ask.resolve(yes ? value : null);
    else ask.resolve(yes);
  };
  const password = ask.kind === 'password';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30" onClick={(e) => e.target === e.currentTarget && done(false)}>
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        data-testid={password ? 'password-dialog' : 'confirm-dialog'}
        className="w-96 space-y-3 rounded-lg bg-white p-4 text-sm shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          done(true);
        }}
        onKeyDown={(e) => e.key === 'Escape' && done(false)}
      >
        <h2 id="dialog-title" className="font-semibold">{password ? 'Password required' : 'Are you sure?'}</h2>
        <p className="break-words text-slate-600">{ask.message}</p>
        {password && (
          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            aria-label="Password"
            data-testid="password-input"
            className="w-full rounded border border-slate-300 px-2 py-1.5"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded px-3 py-1.5 hover:bg-slate-100" onClick={() => done(false)}>
            Cancel
          </button>
          <button ref={okRef} type="submit" data-testid="dialog-ok" className="rounded bg-sky-600 px-3 py-1.5 text-white hover:bg-sky-700">
            {password ? 'Open' : ask.ok}
          </button>
        </div>
      </form>
    </div>
  );
}
