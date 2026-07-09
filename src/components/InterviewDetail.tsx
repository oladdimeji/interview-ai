import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { Interview } from '../types';
import { Award, CheckCircle, XCircle, FileText, Video, ThumbsUp, ThumbsDown, MessageSquare, Briefcase, HelpCircle, AlertTriangle, Trash2 } from 'lucide-react';

interface InterviewDetailProps {
  interviewId: string;
  onDeleteSuccess?: () => void;
}

export default function InterviewDetail({ interviewId, onDeleteSuccess }: InterviewDetailProps) {
  const [interview, setInterview] = useState<Interview | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'report' | 'transcript'>('report');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    // Set up a real-time listener for the specific interview document to receive automatic updates
    const docRef = doc(db, 'interviews', interviewId);
    
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        setInterview({ id: docSnap.id, ...docSnap.data() } as Interview);
      }
      setLoading(false);
    }, (error) => {
      console.error('Error listening to interview detail:', error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [interviewId]);

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-neutral-200 p-8 shadow-sm flex items-center justify-center min-h-[300px]" id="dossier-loading">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-accent border-t-transparent" />
      </div>
    );
  }

  if (!interview) {
    return (
      <div className="bg-white rounded-xl border border-neutral-200 p-8 shadow-sm text-center min-h-[300px] flex flex-col justify-center items-center" id="dossier-empty">
        <div className="p-3 bg-neutral-bg rounded-full mb-3">
          <HelpCircle className="h-8 w-8 text-ink/30" />
        </div>
        <p className="text-sm text-ink font-semibold">ATS Dossier Report</p>
        <p className="text-xs text-ink/40 mt-1 max-w-sm">Select an interview from the directory directory to view the automated candidate report and transcripts.</p>
      </div>
    );
  }

  const isCompleted = interview.status === 'completed' || !!interview.summary;
  const isInProgress = interview.status === 'in_progress';
  const isProcessing = interview.status === 'processing';

  const getScoreColor = (score: number) => {
    if (score >= 8) return 'text-emerald-accent bg-emerald-accent/10 border-emerald-accent/25';
    if (score >= 6) return 'text-amber-accent bg-amber-accent/10 border-amber-accent/25';
    return 'text-rose-500 bg-rose-500/10 border-rose-500/25';
  };

  const getScoreBarBg = (score: number) => {
    if (score >= 8) return 'bg-emerald-accent';
    if (score >= 6) return 'bg-amber-accent';
    return 'bg-rose-500';
  };

  const averageScore = Math.round(
    (interview.scoreBreakdown?.reduce((sum, item) => sum + item.score, 0) || 0) / 
    (interview.scoreBreakdown?.length || 1) * 10
  );

  return (
    <div className="bg-white rounded-xl border border-neutral-200 shadow-sm p-6 sm:p-8 overflow-hidden" id="interview-dossier">
      {/* Candidate Hero from Geometric Balance Design */}
      <div className="flex flex-col sm:flex-row items-start justify-between gap-4 mb-8 border-b border-neutral-100 pb-6">
        <div>
          <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-accent bg-emerald-accent/10 border border-emerald-accent/20 px-2.5 py-1 rounded">
            {interview.interviewType} Interview
          </span>
          <h2 className="text-2xl sm:text-3xl font-bold text-ink mt-3 font-display tracking-tight">{interview.applicantName}</h2>
          <p className="text-xs text-ink/60 mt-1 font-sans">
            Role: <span className="text-ink font-bold">{interview.jobTitle}</span> • Session duration: <span className="font-mono">{interview.duration} mins</span>
          </p>
          {interview.cvFileUrl && (
            <div className="mt-3">
              <a
                href={interview.cvFileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-accent bg-emerald-accent/5 hover:bg-emerald-accent/10 px-3 py-1.5 rounded-lg transition-colors border border-emerald-accent/20 font-mono"
              >
                <FileText className="h-3.5 w-3.5" /> View CV / Resume
              </a>
            </div>
          )}
        </div>
        <div className="text-left sm:text-right shrink-0">
          {!isCompleted ? (
            <div className="flex flex-col items-start sm:items-end gap-2">
              <div className="inline-flex items-center px-3 py-1 bg-amber-accent/10 text-amber-accent rounded-full font-bold text-[10px] uppercase tracking-wider border border-amber-accent/20 font-mono">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-accent animate-pulse mr-1.5 inline-block" />
                {isInProgress ? 'In Session' : isProcessing ? 'Processing evaluation' : 'Awaiting Live Connect'}
              </div>
              <button
                onClick={() => setShowDeleteModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-neutral-200 hover:bg-neutral-bg text-ink/60 hover:text-ink font-bold text-[10px] uppercase font-mono rounded-lg transition-colors cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="h-3.5 w-3.5 text-amber-accent" /> Delete Interview
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-start sm:items-end gap-2">
              {interview.assessmentStatus === 'failed' ? (
                <div className="inline-flex items-center px-3 py-1 bg-neutral-bg text-ink/70 rounded-full font-bold text-[10px] uppercase tracking-wider border border-neutral-200 font-mono">
                  Assessment Failed
                </div>
              ) : interview.decision === 'hire' ? (
                <div className="inline-flex items-center px-3 py-1 bg-emerald-accent text-ink rounded-full font-bold text-[10px] uppercase tracking-wider border border-emerald-accent shadow-sm font-mono">
                  Strong Hire
                </div>
              ) : (
                <div className="inline-flex items-center px-3 py-1 bg-rose-500 text-white rounded-full font-bold text-[10px] uppercase tracking-wider border border-rose-600 shadow-sm font-mono animate-pulse">
                  No-Hire / Reject
                </div>
              )}
              <button
                onClick={() => setShowDeleteModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-neutral-200 hover:bg-neutral-bg text-ink/60 hover:text-ink font-bold text-[10px] uppercase font-mono rounded-lg transition-colors cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="h-3.5 w-3.5 text-amber-accent" /> Delete Interview
              </button>
            </div>
          )}
          {isCompleted && interview.assessmentStatus !== 'failed' && (
            <div className={`text-3xl sm:text-4xl font-black mt-2 font-mono ${interview.decision === 'hire' ? 'text-emerald-accent' : 'text-rose-500'}`}>
              {averageScore}
              <span className="text-sm text-ink/30 font-normal">/100</span>
            </div>
          )}
        </div>
      </div>

      {/* Navigation tabs */}
      <div className="border-b border-neutral-100 flex space-x-6 mb-6">
        <button
          onClick={() => setActiveTab('report')}
          className={`flex items-center gap-2 pb-3 px-1 border-b-2 text-xs uppercase tracking-wider font-bold font-mono transition-all cursor-pointer ${
            activeTab === 'report'
              ? 'border-emerald-accent text-emerald-accent'
              : 'border-transparent text-ink/40 hover:text-ink/70'
          }`}
        >
          <Award className="h-4 w-4" /> Evaluation Report
        </button>
        <button
          onClick={() => setActiveTab('transcript')}
          className={`flex items-center gap-2 pb-3 px-1 border-b-2 text-xs uppercase tracking-wider font-bold font-mono transition-all cursor-pointer ${
            activeTab === 'transcript'
              ? 'border-emerald-accent text-emerald-accent'
              : 'border-transparent text-ink/40 hover:text-ink/70'
          }`}
        >
          <MessageSquare className="h-4 w-4" /> Full Interview Record
        </button>
      </div>

      <div>
        {activeTab === 'report' ? (
          /* Dossier performance report view */
          <div className="space-y-6">
            {!isCompleted ? (
              <div className="text-center py-16 bg-neutral-bg/20 rounded-xl border border-neutral-200 p-6">
                <Video className="h-8 w-8 text-ink/30 mx-auto mb-3 animate-pulse" />
                <p className="text-sm text-ink font-semibold">Active Session in Pending State</p>
                <p className="text-xs text-ink/40 mt-1 max-w-sm mx-auto">Once the candidate submits their real-time session, the automated dossier rating will generate instantly.</p>
              </div>
            ) : interview.assessmentStatus === 'failed' ? (
              <div className="text-center py-16 bg-amber-accent/5 rounded-xl border border-amber-accent/20 p-6 max-w-2xl mx-auto">
                <AlertTriangle className="h-10 w-10 text-amber-accent mx-auto mb-3" />
                <p className="text-sm text-ink font-bold">AI Evaluation Report Generation Failed</p>
                <p className="text-xs text-ink/60 mt-2 leading-relaxed">
                  We encountered an error generating the automated assessment dossier for this candidate.
                  You can still view the full interview dialogue recording and text transcript under the <strong>"Full Interview Record"</strong> tab above.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Executive Summary */}
                <div className="bg-white rounded-xl border border-neutral-200 p-6 space-y-3">
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-ink/40 flex items-center gap-2 font-mono">
                    <FileText className="h-4 w-4 text-emerald-accent" /> Executive Summary
                  </h3>
                  <p className="text-sm leading-relaxed text-ink/80 font-sans">{interview.summary}</p>
                </div>

                {/* Decision justification */}
                <div className="bg-white rounded-xl border border-neutral-200 p-6 space-y-3">
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-ink/40 flex items-center gap-2 font-mono">
                    <CheckCircle className={`h-4 w-4 ${interview.decision === 'hire' ? 'text-emerald-accent' : 'text-rose-500'}`} /> Decision Justification
                  </h3>
                  <p className="text-sm leading-relaxed text-ink/80 font-sans">{interview.decisionReasoning}</p>
                </div>

                {/* Skill Assessment */}
                <div className="bg-white rounded-xl border border-neutral-200 p-6 space-y-5">
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-ink/40 flex items-center gap-2 font-mono">
                    <Award className="h-4 w-4 text-emerald-accent" /> Skill Assessment
                  </h3>
                  <div className="space-y-6">
                    {interview.scoreBreakdown?.map((criterion, index) => {
                      const scoreValue = criterion.score * 10;
                      const scoreColorText = criterion.score >= 8 
                        ? 'text-emerald-accent' 
                        : criterion.score >= 6 
                          ? 'text-amber-accent' 
                          : 'text-rose-500';

                      return (
                        <div key={index} className="space-y-2 border-b border-neutral-100 last:border-0 pb-5 last:pb-0">
                          <div className="flex justify-between items-baseline gap-4">
                            <span className="font-bold text-sm sm:text-base text-ink font-sans">{criterion.criteria}</span>
                            <div className="flex items-baseline gap-1">
                              <span className={`font-mono font-black text-lg sm:text-2xl ${scoreColorText}`}>
                                {scoreValue}
                              </span>
                              <span className="text-[10px] font-mono text-ink/40">/100</span>
                            </div>
                          </div>
                          
                          {/* Prominent visual meter/bar */}
                          <div className="h-3 w-full bg-neutral-bg rounded-full overflow-hidden border border-neutral-200/50 shadow-inner">
                            <div 
                              className={`h-full rounded-full transition-all duration-700 ${getScoreBarBg(criterion.score)} shadow-[0_0_8px_rgba(0,0,0,0.05)]`} 
                              style={{ width: `${scoreValue}%` }}
                            />
                          </div>
                          
                          <p className="text-xs text-ink/60 leading-relaxed font-sans pt-1">
                            {criterion.feedback}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Video & Transcript Full View */
          <div className="space-y-6">
            {/* Webcam / Recording Panel */}
            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-ink/40 mb-3 flex items-center gap-2 font-mono">
                <Video className="h-4 w-4 text-emerald-accent" /> Candidate Session Recording
              </h3>
              {interview.recordingUrl ? (
                <div className="space-y-3">
                  <div className="aspect-video w-full bg-slate rounded-xl overflow-hidden shadow-lg border border-graphite">
                    <iframe 
                      src={interview.recordingUrl} 
                      className="w-full h-full border-0"
                      allow="autoplay; encrypted-media"
                      allowFullScreen
                      title="Candidate Session Recording"
                    />
                  </div>
                </div>
              ) : interview.recordingStatus === 'uploading' ? (
                <div className="p-12 rounded-xl bg-amber-accent/5 border border-amber-accent/20 text-center flex flex-col items-center justify-center animate-pulse">
                  <svg className="animate-spin h-8 w-8 text-amber-accent mb-3" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <p className="text-sm font-bold text-amber-accent">Uploading recording...</p>
                  <p className="text-xs text-ink/40 mt-1">The candidate's video file is currently being saved to cloud storage.</p>
                </div>
              ) : interview.recordingStatus === 'failed' ? (
                <div className="p-8 rounded-xl bg-neutral-bg border border-neutral-200 text-center flex flex-col items-center justify-center">
                  <XCircle className="h-8 w-8 text-ink/40 mb-2" />
                  <p className="text-xs font-bold text-ink">Recording unavailable</p>
                  <p className="text-[11px] text-ink/40 mt-1">The video recording failed to upload. Dialogue transcripts are preserved below.</p>
                </div>
              ) : isProcessing ? (
                <div className="p-12 rounded-xl bg-emerald-accent/5 border border-emerald-accent/20 text-center flex flex-col items-center justify-center animate-pulse">
                  <svg className="animate-spin h-8 w-8 text-emerald-accent mb-3" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <p className="text-sm font-bold text-emerald-accent">Processing Evaluation...</p>
                </div>
              ) : (
                <div className="p-8 rounded-xl bg-neutral-bg/40 border border-neutral-200 text-center flex flex-col items-center justify-center">
                  <Video className="h-8 w-8 text-ink/20 mb-2" />
                  <p className="text-xs font-bold text-ink/60">No Video Recording Captured</p>
                  <p className="text-[11px] text-ink/40 mt-1 font-mono">Dialogue segments are preserved below via real-time transcript capture.</p>
                </div>
              )}
            </div>

            {/* Transcript Timeline */}
            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-ink/40 mb-4 flex items-center gap-2 font-mono">
                <MessageSquare className="h-4 w-4 text-emerald-accent" /> Dialogue Timeline Transcript
              </h3>
              {interview.transcript && interview.transcript.length > 0 ? (
                <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 border border-neutral-200 p-5 rounded-xl bg-neutral-bg/10">
                  {[...interview.transcript].sort((a, b) => a.timestamp - b.timestamp).map((item, index) => {
                    const isAI = item.sender === 'AI';
                    return (
                      <div 
                        key={index} 
                        className={`flex flex-col ${isAI ? 'items-start' : 'items-end'}`}
                      >
                        <div className="flex items-center gap-1.5 mb-1 text-[10px] text-ink/40 font-mono px-1">
                          <span className="font-bold text-ink/75">{isAI ? 'InterviewAI Agent' : interview.applicantName}</span>
                          <span>•</span>
                          <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div 
                          className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed shadow-xs ${
                            isAI 
                              ? 'bg-white text-ink border border-neutral-200 rounded-tl-none' 
                              : 'bg-slate text-neutral-bg border border-graphite rounded-tr-none'
                          }`}
                        >
                          {item.text}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-10 border border-dashed border-neutral-200 rounded-xl text-ink/30 text-xs font-mono">
                  No dialogue segments recorded yet.
                </div>
              )}
            </div>
          </div>
        )}

        {showDeleteModal && (
          <div className="fixed inset-0 bg-ink/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
            <div className="bg-white rounded-xl shadow-2xl border border-neutral-200 p-6 max-w-md w-full animate-in fade-in zoom-in-95 duration-200 text-left">
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 rounded-full bg-amber-accent/10 text-amber-accent flex items-center justify-center shrink-0">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-ink">Delete this interview?</h3>
                  <p className="text-xs text-ink/60 mt-2 leading-relaxed">
                    This will permanently remove the interview, its transcript, and its recording. This action cannot be undone.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6 font-mono text-xs">
                <button
                  disabled={isDeleting}
                  onClick={() => setShowDeleteModal(false)}
                  className="px-4 py-2 font-bold border border-neutral-200 rounded-lg hover:bg-neutral-bg text-ink cursor-pointer transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  disabled={isDeleting}
                  onClick={async () => {
                    setIsDeleting(true);
                    try {
                      const res = await fetch(`/api/interviews/${interview.id}`, {
                        method: 'DELETE',
                      });
                      if (!res.ok) {
                        throw new Error('Failed to delete interview');
                      }
                      setShowDeleteModal(false);
                      if (onDeleteSuccess) {
                        onDeleteSuccess();
                      }
                    } catch (err) {
                      console.error('Error deleting interview:', err);
                      alert('Failed to delete interview. Please try again.');
                    } finally {
                      setIsDeleting(false);
                    }
                  }}
                  className="px-4 py-2 font-bold bg-ink hover:opacity-90 text-white rounded-lg cursor-pointer transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isDeleting ? (
                    <>
                      <svg className="animate-spin -ml-0.5 mr-1.5 h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Deleting...
                    </>
                  ) : (
                    'Delete'
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
