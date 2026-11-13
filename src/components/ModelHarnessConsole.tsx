import React, { useState, useEffect } from 'react';
import {
  Settings,
  ShieldCheck,
  Sparkles,
  RefreshCw,
  Clock,
  Terminal,
  Activity,
  Layers,
  Lock,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';

interface ModelRegistration {
  role: string;
  requestedName: string;
  configuredIdentifier: string;
  verificationState: string;
  lastVerifiedAt?: string;
  verificationMetadata?: {
    modelReturned?: string;
    latencyMs?: number;
    error?: string;
  };
  promptVersion: string;
  systemPrompt: string;
}

interface TelemetryLog {
  id: string;
  timestamp: string;
  role: string;
  modelIdentifier: string;
  latencyMs: number;
  cached: boolean;
  status: string;
  errorMessage?: string;
}

export const ModelHarnessConsole: React.FC = () => {
  const [models, setModels] = useState<ModelRegistration[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryLog[]>([]);
  const [verifyingRole, setVerifyingRole] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [editId, setEditId] = useState('');

  const fetchRegistry = async () => {
    try {
      const res = await fetch('/api/harness/registry');
      const data = await res.json();
      if (data.models) setModels(data.models);
      if (data.telemetry) setTelemetry(data.telemetry);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchRegistry();
  }, []);

  const handleVerify = async (role: string) => {
    setVerifyingRole(role);
    try {
      const res = await fetch('/api/harness/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      await res.json();
      await fetchRegistry();
    } catch (e) {
      console.error(e);
    } finally {
      setVerifyingRole(null);
    }
  };

  const handleSaveConfig = async (role: string) => {
    try {
      const res = await fetch('/api/harness/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, configuredIdentifier: editId }),
      });
      await res.json();
      setEditingRole(null);
      await fetchRegistry();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-[1500px] mx-auto w-full pb-8">
      {/* Top Banner */}
      <div className="bg-[#FFFDFB] border-2 border-[#2E1065] rounded-2xl p-4 shadow-[3px_3px_0px_#2E1065] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[#38BDF8] text-[#0C4A6E] flex items-center justify-center border-2 border-[#2E1065] shadow-[2px_2px_0px_#2E1065]">
            <Settings className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-black text-[#2E1065] flex items-center gap-1.5">
              Shared Model Harness Framework <Sparkles className="w-4 h-4 text-[#F43F5E] fill-[#F43F5E]" />
            </h2>
            <p className="text-xs font-bold text-[#0369A1]">
              Live Availability Verification • Role Boundaries & Isolation • Telemetry Monitoring
            </p>
          </div>
        </div>
      </div>

      {/* Model Cards Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {models.map((m) => {
          const isVerified = m.verificationState === 'live_verified';
          const isFailed = m.verificationState === 'failed';

          return (
            <div
              key={m.role}
              className="bg-[#FFFDFB] border-2 border-[#2E1065] rounded-2xl p-4 shadow-[3px_3px_0px_#2E1065] flex flex-col justify-between gap-3"
            >
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between pb-1 border-b border-[#E9D5FF]">
                  <span className="text-[10px] font-black uppercase text-[#4C1D95]">
                    {m.role.replace('_', ' ')}
                  </span>
                  <span
                    className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border border-[#2E1065] ${
                      isVerified
                        ? 'bg-[#DCFCE7] text-[#166534]'
                        : isFailed
                        ? 'bg-[#FEE2E2] text-[#991B1B]'
                        : 'bg-[#FEF08A] text-[#854D0E]'
                    }`}
                  >
                    {m.verificationState}
                  </span>
                </div>

                <div>
                  <h3 className="text-sm font-black text-[#2E1065]">{m.requestedName}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    {editingRole === m.role ? (
                      <div className="flex items-center gap-1 w-full">
                        <input
                          type="text"
                          value={editId}
                          onChange={(e) => setEditId(e.target.value)}
                          className="text-xs bg-white border border-[#2E1065] rounded px-1.5 py-0.5 font-mono w-full"
                        />
                        <button
                          onClick={() => handleSaveConfig(m.role)}
                          className="bg-[#DCFCE7] text-[#166534] border border-[#2E1065] px-2 py-0.5 rounded text-[10px] font-bold"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between w-full">
                        <code className="text-xs font-mono font-bold text-[#7C3AED] bg-[#F5E8FF] px-2 py-0.5 rounded border border-[#E9D5FF]">
                          {m.configuredIdentifier}
                        </code>
                        <button
                          onClick={() => {
                            setEditingRole(m.role);
                            setEditId(m.configuredIdentifier);
                          }}
                          className="text-[10px] text-slate-500 hover:text-[#2E1065] underline"
                        >
                          Edit ID
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Role Boundary & Permissions Tag */}
                <div className="bg-[#FAF5FF] border border-[#DDD6FE] p-2 rounded-xl text-[11px] flex flex-col gap-1">
                  <div className="font-extrabold text-[#4C1D95] flex items-center gap-1">
                    <Lock className="w-3 h-3 text-[#7C3AED]" /> Permission Boundary:
                  </div>
                  <p className="text-slate-600 leading-tight">
                    {m.role === 'structure_router' && 'Table of Contents hierarchies & query only. Never document bodies or answers.'}
                    {m.role === 'evaluation_judge' && 'Blinded candidate answers & gold reference rubrics. No deterministic score calculation.'}
                    {m.role === 'research_agent' && 'Google Search grounding, URL extraction, Markdown structuring. No answer evaluation.'}
                  </p>
                </div>

                {/* Verification Metadata */}
                {m.verificationMetadata && (
                  <div className="text-[10px] bg-slate-50 border border-slate-200 p-2 rounded-xl font-mono text-slate-600 flex flex-col gap-0.5">
                    {m.verificationMetadata.latencyMs && (
                      <div>Latency: {m.verificationMetadata.latencyMs} ms</div>
                    )}
                    {m.verificationMetadata.error && (
                      <div className="text-red-600 break-words line-clamp-2">Error: {m.verificationMetadata.error}</div>
                    )}
                    {m.lastVerifiedAt && <div>Verified: {new Date(m.lastVerifiedAt).toLocaleTimeString()}</div>}
                  </div>
                )}
              </div>

              {/* Action Button */}
              <button
                onClick={() => handleVerify(m.role)}
                disabled={verifyingRole === m.role}
                className="w-full bg-[#38BDF8] hover:bg-[#0284C7] disabled:opacity-50 text-[#0C4A6E] hover:text-white border-2 border-[#2E1065] py-1.5 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 shadow-[2px_2px_0px_#2E1065] transition-all"
              >
                {verifyingRole === m.role ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Verifying Live...
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-3.5 h-3.5" /> Verify Model Access Live
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Invocation Telemetry Log Table */}
      <div className="bg-[#FFFDFB] border-2 border-[#2E1065] rounded-2xl p-4 shadow-[3px_3px_0px_#2E1065] flex flex-col gap-2">
        <div className="flex items-center justify-between pb-1 border-b border-[#E9D5FF]">
          <span className="text-xs font-black uppercase text-[#4C1D95] flex items-center gap-1.5">
            <Activity className="w-4 h-4 text-[#7C3AED]" /> Invocation Telemetry Log ({telemetry.length})
          </span>
          <button
            onClick={fetchRegistry}
            className="text-[11px] font-bold text-[#7C3AED] hover:underline flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>

        <div className="overflow-x-auto max-h-[250px] overflow-y-auto">
          {telemetry.length === 0 ? (
            <p className="text-xs text-slate-500 py-4 text-center">No model invocations logged yet.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-[#4C1D95] font-extrabold text-[10px] uppercase">
                  <th className="py-1 px-2">Time</th>
                  <th className="py-1 px-2">Role</th>
                  <th className="py-1 px-2">Model</th>
                  <th className="py-1 px-2">Latency</th>
                  <th className="py-1 px-2">Cache</th>
                  <th className="py-1 px-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                {telemetry.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="py-1 px-2 text-slate-500">{new Date(t.timestamp).toLocaleTimeString()}</td>
                    <td className="py-1 px-2 font-bold text-[#2E1065]">{t.role}</td>
                    <td className="py-1 px-2 text-[#7C3AED]">{t.modelIdentifier}</td>
                    <td className="py-1 px-2">{t.latencyMs}ms</td>
                    <td className="py-1 px-2">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] ${t.cached ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'}`}>
                        {t.cached ? 'HIT' : 'MISS'}
                      </span>
                    </td>
                    <td className="py-1 px-2">
                      <span className={`font-bold ${t.status === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                        {t.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
