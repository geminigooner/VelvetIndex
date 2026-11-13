import React, { useState, useEffect } from 'react';
import { KawaiiShell, WorkspaceTab } from './components/KawaiiShell.tsx';
import { ExperimentsLab } from './components/ExperimentsLab.tsx';
import { ResearchAgentStudio } from './components/ResearchAgentStudio.tsx';
import { ModelHarnessConsole } from './components/ModelHarnessConsole.tsx';
import { BookOpen, FileText, ChevronRight } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('experiments');
  const [corpus, setCorpus] = useState<any[]>([]);
  const [questionCount, setQuestionCount] = useState<number>(6);

  const fetchCorpus = async () => {
    try {
      const res = await fetch('/api/corpus');
      const data = await res.json();
      if (data.docs) setCorpus(data.docs);
      if (typeof data.questionCount === 'number') setQuestionCount(data.questionCount);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchCorpus();
  }, []);

  return (
    <KawaiiShell
      activeTab={activeTab}
      onTabChange={setActiveTab}
      corpusCount={corpus.length}
      questionCount={questionCount}
    >
      {activeTab === 'experiments' && (
        <ExperimentsLab
          corpus={corpus}
          onOpenResearchAgent={() => setActiveTab('research')}
        />
      )}

      {activeTab === 'research' && (
        <ResearchAgentStudio onPaperApproved={fetchCorpus} />
      )}

      {activeTab === 'harnesses' && <ModelHarnessConsole />}

      {activeTab === 'corpus' && (
        <div className="max-w-[1400px] mx-auto w-full flex flex-col gap-4 pb-8">
          <div className="bg-[#FFFDFB] border-2 border-[#2E1065] rounded-2xl p-4 shadow-[3px_3px_0px_#2E1065] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-[#FEF08A] text-[#854D0E] flex items-center justify-center border-2 border-[#2E1065] shadow-[2px_2px_0px_#2E1065]">
                <BookOpen className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-black text-[#2E1065]">Corpus & Document Table of Contents</h2>
                <p className="text-xs font-bold text-[#854D0E]">
                  Exact UTF-16 character offsets and section boundaries verified against chunking invariants.
                </p>
              </div>
            </div>
            <button
              onClick={() => setActiveTab('research')}
              className="bg-[#F472B6] hover:bg-[#EC4899] text-white border-2 border-[#2E1065] px-3.5 py-1.5 rounded-xl text-xs font-black shadow-[2px_2px_0px_#2E1065]"
            >
              + Acquire New Papers
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {corpus.map((doc) => (
              <div
                key={doc.doc_id}
                className="bg-[#FFFDFB] border-2 border-[#2E1065] rounded-2xl p-4 shadow-[3px_3px_0px_#2E1065] flex flex-col gap-2"
              >
                <div className="flex items-center justify-between pb-1 border-b border-[#E9D5FF]">
                  <span className="text-xs font-black text-[#2E1065]">{doc.title}</span>
                  <span className="text-[10px] font-mono bg-[#E0F2FE] text-[#0369A1] px-2 py-0.5 rounded border border-[#2E1065]">
                    {doc.doc_id}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5 pt-1">
                  {(doc.sections || []).map((s: any) => (
                    <div
                      key={s.section_id}
                      className="bg-[#FAF5FF] border border-[#DDD6FE] p-2 rounded-xl text-xs flex items-center justify-between"
                    >
                      <span className="font-bold text-[#4C1D95]">{s.heading}</span>
                      <span className="font-mono text-[10px] text-slate-500">
                        [{s.char_start}..{s.char_end}]
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </KawaiiShell>
  );
}
