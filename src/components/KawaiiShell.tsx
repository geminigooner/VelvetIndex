import React from 'react';
import {
  Home,
  BookOpen,
  UploadCloud,
  Search,
  BarChart3,
  FlaskConical,
  Bot,
  Terminal,
  Folder,
  Globe,
  Sparkles,
  Moon,
  Layers,
  Settings,
  FileText
} from 'lucide-react';

export type WorkspaceTab = 'experiments' | 'research' | 'harnesses' | 'corpus';

interface KawaiiShellProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  corpusCount: number;
  questionCount: number;
  statusMessage?: string;
  children: React.ReactNode;
}

export const KawaiiShell: React.FC<KawaiiShellProps> = ({
  activeTab,
  onTabChange,
  corpusCount,
  questionCount,
  statusMessage = '✓ Ingestion ready | ✓ Index built | ✓ A/B results: complete',
  children,
}) => {
  return (
    <div className="min-h-screen bg-[#D8B4F8] text-[#2E1065] flex flex-col font-sans select-none antialiased">
      {/* Top Application Bar matching reference mockup */}
      <header className="bg-[#E9D5FF] border-b-2 border-[#2E1065] px-6 py-2.5 flex items-center justify-between shadow-sm relative z-20">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[#FEF08A] border-2 border-[#2E1065] flex items-center justify-center shadow-[1px_1px_0px_#2E1065]">
            <Moon className="w-4 h-4 text-[#D97706] fill-[#FEF08A]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-black tracking-tight text-[#2E1065] flex items-center gap-1.5 drop-shadow-[0_1px_0_#FFF]">
                RAG / STAIR Research Studio <Sparkles className="w-4 h-4 text-[#F43F5E] fill-[#F43F5E]" />
              </h1>
            </div>
            <div className="bg-[#FEF08A] border border-[#2E1065] px-2.5 py-0.5 rounded-full inline-block mt-0.5 shadow-[1px_1px_0px_#2E1065]">
              <span className="text-[11px] font-bold text-[#854D0E] tracking-tight">
                Retrieval • Evaluation • Structure-Aware Routing
              </span>
            </div>
          </div>
        </div>

        {/* Center Kawaii Badges */}
        <div className="hidden lg:flex items-center gap-2.5">
          <div className="bg-white/80 border-2 border-[#2E1065] px-3 py-1 rounded-xl flex items-center gap-1.5 shadow-[2px_2px_0px_#2E1065] text-xs font-bold text-[#4C1D95]">
            <Folder className="w-3.5 h-3.5 text-[#7C3AED]" /> Project: RAG Eval
          </div>
          <div className="bg-white/80 border-2 border-[#2E1065] px-3 py-1 rounded-xl flex items-center gap-1.5 shadow-[2px_2px_0px_#2E1065] text-xs font-bold text-[#4C1D95]">
            <Layers className="w-3.5 h-3.5 text-[#EC4899]" /> Corpus: {corpusCount} papers
          </div>
          <div className="bg-white/80 border-2 border-[#2E1065] px-3 py-1 rounded-xl flex items-center gap-1.5 shadow-[2px_2px_0px_#2E1065] text-xs font-bold text-[#4C1D95]">
            <FileText className="w-3.5 h-3.5 text-[#0284C7]" /> Questions: {questionCount}
          </div>
        </div>

        {/* Right Window Controls */}
        <div className="flex items-center gap-1.5">
          <button className="w-7 h-7 rounded-lg bg-white border-2 border-[#2E1065] flex items-center justify-center font-black text-xs shadow-[2px_2px_0px_#2E1065] hover:bg-[#FDF2F8]">
            —
          </button>
          <button className="w-7 h-7 rounded-lg bg-white border-2 border-[#2E1065] flex items-center justify-center font-black text-xs shadow-[2px_2px_0px_#2E1065] hover:bg-[#FDF2F8]">
            □
          </button>
          <button className="w-7 h-7 rounded-lg bg-[#FDA4AF] border-2 border-[#2E1065] flex items-center justify-center font-black text-xs shadow-[2px_2px_0px_#2E1065] hover:bg-[#F43F5E] hover:text-white">
            ✕
          </button>
        </div>
      </header>

      {/* Main Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Kawaii Sidebar Navigation */}
        <aside className="w-44 bg-[#F5E8FF] border-r-2 border-[#2E1065] flex flex-col justify-between py-4 px-3 shrink-0 shadow-[2px_0px_0px_rgba(46,16,101,0.05)]">
          <nav className="flex flex-col gap-2">
            <button
              onClick={() => onTabChange('experiments')}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-extrabold border-2 transition-all ${
                activeTab === 'experiments'
                  ? 'bg-[#F472B6] text-white border-[#2E1065] shadow-[2px_2px_0px_#2E1065] translate-x-1'
                  : 'bg-white text-[#2E1065] border-[#2E1065] shadow-[1px_1px_0px_#2E1065] hover:bg-[#FCE7F3]'
              }`}
            >
              <FlaskConical className="w-4 h-4 shrink-0" />
              <span>Experiments</span>
            </button>

            <button
              onClick={() => onTabChange('research')}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-extrabold border-2 transition-all ${
                activeTab === 'research'
                  ? 'bg-[#A855F7] text-white border-[#2E1065] shadow-[2px_2px_0px_#2E1065] translate-x-1'
                  : 'bg-white text-[#2E1065] border-[#2E1065] shadow-[1px_1px_0px_#2E1065] hover:bg-[#F3E8FF]'
              }`}
            >
              <Bot className="w-4 h-4 shrink-0" />
              <span>Research Agent</span>
            </button>

            <button
              onClick={() => onTabChange('harnesses')}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-extrabold border-2 transition-all ${
                activeTab === 'harnesses'
                  ? 'bg-[#38BDF8] text-[#0C4A6E] border-[#2E1065] shadow-[2px_2px_0px_#2E1065] translate-x-1'
                  : 'bg-white text-[#2E1065] border-[#2E1065] shadow-[1px_1px_0px_#2E1065] hover:bg-[#E0F2FE]'
              }`}
            >
              <Settings className="w-4 h-4 shrink-0" />
              <span>Model Harness</span>
            </button>

            <button
              onClick={() => onTabChange('corpus')}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-extrabold border-2 transition-all ${
                activeTab === 'corpus'
                  ? 'bg-[#FBBF24] text-[#78350F] border-[#2E1065] shadow-[2px_2px_0px_#2E1065] translate-x-1'
                  : 'bg-white text-[#2E1065] border-[#2E1065] shadow-[1px_1px_0px_#2E1065] hover:bg-[#FEF3C7]'
              }`}
            >
              <BookOpen className="w-4 h-4 shrink-0" />
              <span>Corpus (ToC)</span>
            </button>
          </nav>

          {/* Sleeping Bunny Mascot on fluffy cloud */}
          <div className="pt-4 flex flex-col items-center">
            <div className="w-full bg-white border-2 border-[#2E1065] rounded-2xl p-2.5 flex flex-col items-center shadow-[3px_3px_0px_#2E1065]">
              <div className="text-2xl animate-pulse">(\(\</div>
              <div className="text-xs font-black text-[#4C1D95] tracking-tight">( -.-) 💤</div>
              <div className="text-[10px] font-bold text-[#9333EA] mt-1 bg-[#F5D0FE] px-2 py-0.5 rounded-full border border-[#2E1065]">
                studio ready
              </div>
            </div>
          </div>
        </aside>

        {/* Content Viewport */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 bg-[#C49DE8] flex flex-col">
          {children}
        </main>
      </div>

      {/* Bottom Status Dock matching reference */}
      <footer className="bg-[#E9D5FF] border-t-2 border-[#2E1065] px-6 py-2 flex items-center justify-between text-xs font-bold text-[#4C1D95] relative z-20">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-white border-2 border-[#2E1065] flex items-center justify-center shadow-[1px_1px_0px_#2E1065]">
            <Terminal className="w-3 h-3 text-[#2E1065]" />
          </div>
          <div className="w-6 h-6 rounded-md bg-white border-2 border-[#2E1065] flex items-center justify-center shadow-[1px_1px_0px_#2E1065]">
            <Folder className="w-3 h-3 text-[#2E1065]" />
          </div>
          <div className="w-6 h-6 rounded-md bg-white border-2 border-[#2E1065] flex items-center justify-center shadow-[1px_1px_0px_#2E1065]">
            <Globe className="w-3 h-3 text-[#2E1065]" />
          </div>
        </div>

        <div className="bg-white border-2 border-[#2E1065] px-4 py-1 rounded-full shadow-[2px_2px_0px_#2E1065] flex items-center gap-2 text-[11px] font-black tracking-wide">
          <span>{statusMessage}</span>
        </div>

        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-white border-2 border-[#2E1065] flex items-center justify-center shadow-[1px_1px_0px_#2E1065]">
            <BarChart3 className="w-3 h-3 text-[#EC4899]" />
          </div>
          <div className="w-6 h-6 rounded-md bg-white border-2 border-[#2E1065] flex items-center justify-center shadow-[1px_1px_0px_#2E1065]">
            <Layers className="w-3 h-3 text-[#7C3AED]" />
          </div>
          <div className="w-6 h-6 rounded-md bg-white border-2 border-[#2E1065] flex items-center justify-center shadow-[1px_1px_0px_#2E1065]">
            <Sparkles className="w-3 h-3 text-[#F59E0B]" />
          </div>
        </div>
      </footer>
    </div>
  );
};
