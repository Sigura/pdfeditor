import { useState } from 'react';
import { MergeView } from './merge/MergeView.tsx';
import { EditorView } from './editor/EditorView.tsx';
import { Dialogs } from './lib/Dialogs.tsx';
import { useEditor } from './editor/store.ts';
import { useMergeStore } from './merge/store.ts';

const TAB_LABEL = { merge: 'Merge & Pages', edit: 'Edit' };

type Tab = 'merge' | 'edit';

export function App() {
  const [tab, setTab] = useState<Tab>('merge');
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-slate-200 bg-white px-4 py-2">
        <h1 className="text-lg font-semibold">PDF Toolkit</h1>
        <nav className="flex gap-1">
          {(['merge', 'edit'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 text-sm ${tab === t ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1">
        {tab === 'merge' ? (
          <MergeView
            onEdit={(file) => {
              useEditor.getState().setIncoming(file);
              setTab('edit');
            }}
          />
        ) : (
          <EditorView
            onArrange={(file) => {
              useMergeStore.getState().setIncoming([file]);
              setTab('merge');
            }}
          />
        )}
      </main>
      <Dialogs />
    </div>
  );
}
