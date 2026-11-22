import { useEffect, useRef, useState } from 'react';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30">
      <form
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
          <button ref={okRef} type="submit" data-testid="dialog-ok" className="rounded bg-slate-900 px-3 py-1.5 text-white">
            {password ? 'Open' : ask.ok}
          </button>
        </div>
      </form>
    </div>
  );
}
