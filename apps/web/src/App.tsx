import { useState } from 'react';
import { MergeView } from './merge/MergeView.tsx';
import { EditorView } from './editor/EditorView.tsx';
import { Dialogs } from './lib/Dialogs.tsx';
import { StatusBar } from './lib/progress.tsx';
import { hasUnsaved, pageNo, pageOrder, savedDocument, useEditor } from './editor/store.ts';
import { BLANK, useMergeStore } from './merge/store.ts';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function IdleStatus({ tab }: { tab: Tab }) {
  const merge = useMergeStore();
  const ed = useEditor();
  if (tab === 'merge') {
    const files = Object.keys(merge.files).length;
    return <>{files ? `Ready · ${plural(files, 'file')} · ${plural(merge.pages.length, 'page')}${merge.pages.some((p) => p.fileId === BLANK) ? ' (with blanks)' : ''}` : 'Ready'}</>;
  }
  if (!ed.docId) return <>Ready</>;
  const count = pageNo(ed, ed.pageIndex) > 0 ? `page ${pageNo(ed, ed.pageIndex)} of ${pageOrder(ed.ops, ed.pages).length}` : '';
  const saved = !ed.ops.length ? 'no changes' : `${plural(ed.ops.length, 'change')} · ${hasUnsaved(ed) ? 'not downloaded' : 'downloaded'}`;
  return <>{['Ready', ed.fileName, count, saved].filter(Boolean).join(' · ')}</>;
}

const TAB_LABEL = { merge: 'Merge & Pages', edit: 'Edit' };

type Tab = 'merge' | 'edit';

export function App() {
  const [tab, setTab] = useState<Tab>(() => (savedDocument() ? 'edit' : 'merge'));
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-slate-200 bg-white px-4 py-2">
        <h1 className="text-lg font-semibold">PDF Toolkit</h1>
        <nav className="flex gap-1" role="tablist" aria-label="Tools">
          {(['merge', 'edit'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
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
            onArrange={(files) => {
              useMergeStore.getState().setIncoming(files);
              setTab('merge');
            }}
          />
        )}
      </main>
      <StatusBar idle={<IdleStatus tab={tab} />} />
      <Dialogs />
    </div>
  );
}
