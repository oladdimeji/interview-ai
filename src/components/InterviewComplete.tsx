import { CheckCircle2, Calendar } from 'lucide-react';

interface InterviewCompleteProps {
  onRestart?: () => void;
}

export default function InterviewComplete({ onRestart }: InterviewCompleteProps) {
  return (
    <div className="min-h-screen bg-[#F2F4F7] flex items-center justify-center p-4 font-sans" id="interview-complete-view">
      <div className="w-full max-w-lg bg-white p-8 rounded-xl shadow-lg border border-neutral-200 text-center space-y-6 animate-fade-in">
        
        {/* Visual Checkmark */}
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-xl bg-emerald-accent/10 border border-emerald-accent/20 text-emerald-accent shadow-sm">
          <CheckCircle2 className="h-8 w-8" />
        </div>

        {/* Text Details */}
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-bold text-ink tracking-tight">Session Completed</h1>
          <p className="text-[10px] text-emerald-accent font-bold uppercase tracking-widest font-mono">Your live AI interview has finished successfully</p>
        </div>

        {/* Detailed Explanation */}
        <div className="bg-[#F2F4F7]/40 rounded-lg p-5 border border-neutral-200 text-left">
          <div className="flex items-start gap-3">
            <div className="p-1.5 bg-emerald-accent/10 rounded-md mt-0.5">
              <Calendar className="h-4 w-4 text-emerald-accent shrink-0" />
            </div>
            <div className="text-xs">
              <span className="font-bold text-ink block mb-1 font-sans text-sm">What Happens Next</span>
              <span className="text-ink/70 leading-relaxed font-sans">Your responses have been recorded and evaluated. Our talent team will review your results and reach out to you with feedback and next steps.</span>
            </div>
          </div>
        </div>

        <p className="text-[11px] font-mono text-ink/40">You can now close this browser window safely.</p>
      </div>
    </div>
  );
}
