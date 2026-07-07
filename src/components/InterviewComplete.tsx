import { CheckCircle2, ShieldCheck, Calendar } from 'lucide-react';

interface InterviewCompleteProps {
  onRestart?: () => void;
}

export default function InterviewComplete({ onRestart }: InterviewCompleteProps) {
  return (
    <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-4 font-sans" id="interview-complete-view">
      <div className="w-full max-w-lg bg-white p-8 rounded-xl shadow-sm border border-slate-200 text-center space-y-6">
        
        {/* Visual Checkmark */}
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
          <CheckCircle2 className="h-8 w-8" />
        </div>

        {/* Text Details */}
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold text-slate-900">Session Completed</h1>
          <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">Your live AI interview has finished</p>
        </div>

        {/* Detailed Explanation */}
        <div className="bg-[#F8FAFC] rounded-lg p-5 border border-slate-200 text-left space-y-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-indigo-600 shrink-0 mt-0.5" />
            <div className="text-xs">
              <span className="font-bold text-slate-800 block mb-0.5">Dossier Generated Securely</span>
              <span className="text-slate-500 leading-relaxed">Your audio stream, session logs, and performance metrics are saved directly into the hiring database.</span>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Calendar className="h-5 w-5 text-indigo-600 shrink-0 mt-0.5" />
            <div className="text-xs">
              <span className="font-bold text-slate-800 block mb-0.5">Recruiter Review Ready</span>
              <span className="text-slate-500 leading-relaxed">The talent acquisition team has been notified. They can access your complete interview report immediately.</span>
            </div>
          </div>
        </div>

        <p className="text-xs font-semibold text-slate-400">You may now close this browser window safely.</p>
      </div>
    </div>
  );
}
