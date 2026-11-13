import React, { useState, useEffect } from 'react';
import {
  Search,
  Sparkles,
  Bot,
  CheckCircle2,
  XCircle,
  FileText,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
  Clock,
  Layers,
  ChevronRight
} from 'lucide-react';

interface ResearchPaper {
  id: string;
  title: string;
  authors: string[];
  year: number;
  url: string;
  venue: string;
  abstract: string;
  fullText?: string;
  extractedMarkdown?: string;
  isFullTextAvailable: boolean;
  status: 'discovered' | 'acquired' | 'structured' | 'approved' | 'rejected';
}

interface ResearchTask {
  taskId: string;
  query: string;
  venues: string[];
  status: string;
  progressPercent: number;
  currentStepMessage: string;
  papers: ResearchPaper[];
}

export const ResearchAgentStudio: React.FC<{ onPaperApproved: () => void }> = ({ onPaperApproved }) => {
  const [query, setQuery] = useState('Structure-aware hierarchical RAG and Table of Contents retrieval');
  const [selectedVenues, setSelectedVenues] = useState<string[]>(['arXiv', 'Google Research', 'Anthropic']);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTask, setActiveTask] = useState<ResearchTask | null>(null);
  const [previewPaper, setPreviewPaper] = useState<ResearchPaper | null>(null);
  const [tasksList, setTasksList] = useState<ResearchTask[]>([]);

  const venuesList = ['arXiv', 'Google Research', 'Anthropic', 'DeepMind', 'Semantic Scholar'];

  const toggleVenue = (v: string) => {
    if (selectedVenues.includes(v)) {
      if (selectedVenues.length > 1) setSelectedVenues(selectedVenues.filter((x) => x !== v));
    } else {
      setSelectedVenues([...selectedVenues, v]);
    }
  };

  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/research/tasks');
      const data = await res.json();
      if (data.tasks) {
        setTasksList(data.tasks);
        if (data.tasks.length > 0 && !activeTask) {
          setActiveTask(data.tasks[0]);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  const handleStartResearch = async () => {
    if (!query.trim()) return;
    setIsRunning(true);
    try {
      const res = await fetch('/api/research/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, venues: selectedVenues }),
      });
      const task = await res.json();
      setActiveTask(task);

      // Poll task status until complete
      const interval = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/research/tasks/${task.taskId}`);
          const pollData = await pollRes.json();
          setActiveTask(pollData);
          if (pollData.status === 'staged' || pollData.status === 'failed' || pollData.status === 'approved') {
            clearInterval(interval);
            setIsRunning(false);
            fetchTasks();
          }
        } catch {
          clearInterval(interval);
          setIsRunning(false);
        }
      }, 2000);
    } catch (e) {
      console.error(e);
      setIsRunning(false);
    }
  };

  const handlePaperAction = async (paperId: string, action: 'approved' | 'rejected') => {
    if (!activeTask) return;
    try {
      const res = await fetch('/api/research/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: activeTask.taskId, paperId, action }),
      });
      const data = await res.json();
      if (data.success) {
        // Update local state
        setActiveTask({
          ...activeTask,
          papers: activeTask.papers.map((p) => (p.id === paperId ? { ...p, status: action } : p)),
        });
        if (action === 'approved') {
          onPaperApproved();
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-[1500px] mx-auto w-full pb-8">
      {/* Top Banner */}
      <div className="bg-[#FFFDFB] border-2 border-[#2E1065] rounded-2xl p-4 shadow-[3px_3px_0px_#2E1065] flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[#A855F7] text-white flex items-center justify-center border-2 border-[#2E1065] shadow-[2px_2px_0px_#2E1065]">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-black text-[#2E1065] flex items-center gap-1.5">
              Autonomous Research Acquisition Studio <Sparkles className="w-4 h-4 text-[#F43F5E] fill-[#F43F5E]" />
            </h2>
            <p className="text-xs font-bold text-[#6B21A8]">
              Grounding via Google Search • Full-Text Extraction • Structured Markdown Generator
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="bg-[#FEF08A] border-2 border-[#2E1065] px-3 py-1 rounded-xl text-xs font-black text-[#854D0E] flex items-center gap-1.5 shadow-[2px_2px_0px_#2E1065]">
            <ShieldCheck className="w-4 h-4 text-[#16A34A]" /> Human Ingestion Gate Enforced
          </div>
        </div>
      </div>

      {/* Query & Filter Configuration */}
      <div className="bg-[#FFFDFB] border-2 border-[#2E1065] rounded-2xl p-4 shadow-[3px_3px_0px_#2E1065] flex flex-col gap-3">
        <div className="flex flex-col md:flex-row items-center gap-2.5">
          <div className="flex-1 w-full bg-white border-2 border-[#2E1065] rounded-xl px-3 py-2 flex items-center gap-2 shadow-[2px_2px_0px_#2E1065]">
            <Search className="w-4 h-4 text-[#7C3AED]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter academic research topic or keywords..."
              className="w-full text-xs font-bold text-[#2E1065] focus:outline-none"
            />
          </div>
          <button
            onClick={handleStartResearch}
            disabled={isRunning}
            className="w-full md:w-auto bg-[#F472B6] hover:bg-[#EC4899] disabled:opacity-50 text-white border-2 border-[#2E1065] px-6 py-2 rounded-xl text-xs font-black flex items-center justify-center gap-2 shadow-[2px_2px_0px_#2E1065] active:translate-y-0.5 transition-all"
          >
            {isRunning ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Running Agent...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 fill-white" />
                <span>Start Research</span>
              </>
            )}
          </button>
        </div>

        {/* Repositories Filter Bar */}
        <div className="flex items-center gap-2 pt-1 flex-wrap">
          <span className="text-xs font-extrabold text-[#4C1D95]">Target Repositories:</span>
          {venuesList.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => toggleVenue(v)}
              className={`px-3 py-1 rounded-xl text-xs font-bold border-2 transition-all ${
                selectedVenues.includes(v)
                  ? 'bg-[#E9D5FF] text-[#4C1D95] border-[#2E1065] shadow-[1px_1px_0px_#2E1065]'
                  : 'bg-white text-slate-500 border-slate-300 hover:border-[#2E1065]'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Live Agent Execution Activity & Progress */}
      {activeTask && (
        <div className="bg-[#FFFDFB] border-2 border-[#2E1065] rounded-2xl p-4 shadow-[3px_3px_0px_#2E1065] flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black uppercase text-[#4C1D95] flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-[#7C3AED]" /> Agent Execution Activity
            </span>
            <span className="text-xs font-mono font-black text-[#A855F7] bg-[#F3E8FF] px-2 py-0.5 rounded-lg border border-[#2E1065]">
              {activeTask.progressPercent}%
            </span>
          </div>

          {/* Progress Bar */}
          <div className="w-full bg-[#E9D5FF] h-3 rounded-full border border-[#2E1065] overflow-hidden">
            <div
              className="bg-gradient-to-r from-[#A855F7] to-[#F472B6] h-full transition-all duration-500"
              style={{ width: `${activeTask.progressPercent}%` }}
            />
          </div>

          <div className="text-xs font-bold text-[#4C1D95] bg-[#FAF5FF] p-2 rounded-xl border border-[#DDD6FE]">
            {activeTask.currentStepMessage}
          </div>
        </div>
      )}

      {/* Discovered Papers Cards Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {activeTask?.papers.map((paper) => (
          <div
            key={paper.id}
            className={`bg-[#FFFDFB] border-2 border-[#2E1065] rounded-2xl p-4 shadow-[3px_3px_0px_#2E1065] flex flex-col justify-between gap-3 ${
              paper.status === 'approved' ? 'bg-[#F0FDF4]' : ''
            }`}
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-black text-[#2E1065] leading-snug">{paper.title}</h3>
                <span
                  className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border border-[#2E1065] shrink-0 ${
                    paper.status === 'approved'
                      ? 'bg-[#DCFCE7] text-[#166534]'
                      : paper.status === 'rejected'
                      ? 'bg-[#FEE2E2] text-[#991B1B]'
                      : 'bg-[#FEF08A] text-[#854D0E]'
                  }`}
                >
                  {paper.status}
                </span>
              </div>

              <div className="text-[11px] font-bold text-[#6B21A8]">
                {paper.authors.join(', ')} · {paper.year} · <span className="underline">{paper.venue}</span>
              </div>

              <p className="text-xs text-slate-700 line-clamp-3 bg-[#FAF5FF] p-2 rounded-xl border border-[#E9D5FF]">
                {paper.abstract}
              </p>
            </div>

            {/* Actions Bar */}
            <div className="flex items-center justify-between pt-2 border-t border-[#E9D5FF]">
              <button
                onClick={() => setPreviewPaper(paper)}
                className="text-xs font-bold text-[#7C3AED] hover:underline flex items-center gap-1"
              >
                <FileText className="w-3.5 h-3.5" /> Preview Markdown
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handlePaperAction(paper.id, 'rejected')}
                  disabled={paper.status === 'rejected'}
                  className="bg-white hover:bg-red-50 text-red-600 border border-[#2E1065] px-2.5 py-1 rounded-xl text-xs font-black shadow-[1px_1px_0px_#2E1065]"
                >
                  Reject
                </button>
                <button
                  onClick={() => handlePaperAction(paper.id, 'approved')}
                  disabled={paper.status === 'approved'}
                  className="bg-[#DCFCE7] hover:bg-[#BBF7D0] text-[#166534] border border-[#2E1065] px-3 py-1 rounded-xl text-xs font-black shadow-[1px_1px_0px_#2E1065] flex items-center gap-1"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" /> Approve & Ingest
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Markdown Preview Drawer Modal */}
      {previewPaper && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#FFFDFB] border-4 border-[#2E1065] rounded-3xl p-6 max-w-2xl w-full max-h-[80vh] flex flex-col gap-3 shadow-[6px_6px_0px_#2E1065]">
            <div className="flex items-center justify-between pb-2 border-b-2 border-[#2E1065]">
              <h3 className="text-sm font-black text-[#2E1065] truncate">{previewPaper.title}</h3>
              <button
                onClick={() => setPreviewPaper(null)}
                className="w-7 h-7 rounded-lg bg-[#FDA4AF] border-2 border-[#2E1065] font-black text-xs"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto bg-slate-900 text-slate-100 p-4 rounded-2xl font-mono text-xs leading-relaxed">
              <pre className="whitespace-pre-wrap">{previewPaper.extractedMarkdown || previewPaper.abstract}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
