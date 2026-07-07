import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { Interview } from '../types';
import { Award, CheckCircle, XCircle, FileText, Video, ThumbsUp, ThumbsDown, MessageSquare, Briefcase, HelpCircle, AlertTriangle } from 'lucide-react';

interface InterviewDetailProps {
  interviewId: string;
}

export default function InterviewDetail({ interviewId }: InterviewDetailProps) {
  const [interview, setInterview] = useState<Interview | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'report' | 'transcript'>('report');

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
      <div className="bg-white rounded-2xl border border-gray-100 p-8 shadow-sm flex items-center justify-center min-h-[300px]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  if (!interview) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-8 shadow-sm text-center min-h-[300px] flex flex-col justify-center items-center">
        <HelpCircle className="h-10 w-10 text-gray-300 mb-2" />
        <p className="text-sm text-gray-500 font-medium">Select an interview from the directory to view the ATS dossier report.</p>
      </div>
    );
  }

  const isCompleted = interview.status === 'completed' || !!interview.summary;
  const isInProgress = interview.status === 'in_progress';
  const isProcessing = interview.status === 'processing';

  const getScoreColor = (score: number) => {
    if (score >= 8) return 'text-emerald-600 bg-emerald-50 border-emerald-100';
    if (score >= 6) return 'text-amber-600 bg-amber-50 border-amber-100';
    return 'text-rose-600 bg-rose-50 border-rose-100';
  };

  const getScoreBarBg = (score: number) => {
    if (score >= 8) return 'bg-emerald-500';
    if (score >= 6) return 'bg-amber-500';
    return 'bg-rose-500';
  };

  const averageScore = Math.round(
    (interview.scoreBreakdown?.reduce((sum, item) => sum + item.score, 0) || 0) / 
    (interview.scoreBreakdown?.length || 1) * 10
  );

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 sm:p-8 overflow-hidden" id="interview-dossier">
      {/* Candidate Hero from Geometric Balance Design */}
      <div className="flex flex-col sm:flex-row items-start justify-between gap-4 mb-8 border-b border-slate-100 pb-6">
        <div>
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded">
            {interview.interviewType} Interview
          </span>
          <h2 className="text-3xl font-bold text-slate-900 mt-2 font-display">{interview.applicantName}</h2>
          <p className="text-slate-500 font-medium mt-1">
            Role: <span className="text-slate-800 font-semibold">{interview.jobTitle}</span> • Session duration: {interview.duration} mins
          </p>
        </div>
        <div className="text-left sm:text-right shrink-0">
          {!isCompleted ? (
            <div className="flex flex-col items-start sm:items-end gap-3">
              <div className="inline-flex items-center px-4 py-1.5 bg-amber-50 text-amber-700 rounded-full font-bold text-xs uppercase tracking-wide border border-amber-200">
                <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse mr-2 inline-block" />
                {isInProgress ? 'In Session' : isProcessing ? 'Processing Evaluation' : 'Awaiting Live Connect'}
              </div>
              {!isProcessing && (
                <button
                  onClick={() => {
                    window.history.pushState({}, '', `/interview/${interview.id}`);
                    window.dispatchEvent(new Event('popstate'));
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-lg shadow-xs transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Video className="h-3.5 w-3.5" /> Test / Preview Interview
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-start sm:items-end gap-2">
              {interview.recordingStatus === 'uploading' && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-bold text-amber-700 border border-amber-200 animate-pulse mb-1">
                  <svg className="animate-spin h-3 w-3 text-amber-600" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Uploading Video
                </span>
              )}
              {interview.decision === 'hire' ? (
                <div className="inline-flex items-center px-4 py-1.5 bg-emerald-100 text-emerald-700 rounded-full font-bold text-xs uppercase tracking-wide border border-emerald-200">
                  Strong Hire
                </div>
              ) : (
                <div className="inline-flex items-center px-4 py-1.5 bg-rose-100 text-rose-700 rounded-full font-bold text-xs uppercase tracking-wide border border-rose-200">
                  No-Hire / Reject
                </div>
              )}
            </div>
          )}
          {isCompleted && (
            <div className="text-4xl font-black text-slate-900 mt-2">
              {averageScore}
              <span className="text-lg text-slate-400 font-normal">/100</span>
            </div>
          )}
        </div>
      </div>

      {/* Navigation tabs */}
      <div className="border-b border-slate-100 flex space-x-6 mb-6">
        <button
          onClick={() => setActiveTab('report')}
          className={`flex items-center gap-2 pb-3 px-1 border-b-2 text-sm font-bold transition-all cursor-pointer ${
            activeTab === 'report'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-400 hover:text-slate-600'
          }`}
        >
          <Award className="h-4 w-4" /> Performance Dossier
        </button>
        <button
          onClick={() => setActiveTab('transcript')}
          className={`flex items-center gap-2 pb-3 px-1 border-b-2 text-sm font-bold transition-all cursor-pointer ${
            activeTab === 'transcript'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-400 hover:text-slate-600'
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
              <div className="text-center py-16 bg-slate-50/50 rounded-xl border border-slate-100 p-6">
                <Video className="h-8 w-8 text-slate-400 mx-auto mb-3" />
                <p className="text-sm text-slate-600 font-semibold">Active Session in Pending State</p>
                <p className="text-xs text-slate-400 mt-1">Once the candidate submits their real-time session, the automated dossier rating will generate instantly.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* Executive summary & decision justification */}
                <div className="lg:col-span-7 space-y-6">
                  {/* Executive Summary */}
                  <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-2.5">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
                      <FileText className="h-4 w-4 text-indigo-500" /> Executive Summary
                    </h3>
                    <p className="text-sm leading-relaxed text-slate-700">{interview.summary}</p>
                  </div>

                  {/* Decision justification */}
                  <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-2.5">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
                      <CheckCircle className={`h-4 w-4 ${interview.decision === 'hire' ? 'text-emerald-500' : 'text-rose-500'}`} /> Decision Justification
                    </h3>
                    <p className="text-sm leading-relaxed text-slate-700">{interview.decisionReasoning}</p>
                  </div>
                </div>

                {/* Score breakdown sidebar */}
                <div className="lg:col-span-5 space-y-6">
                  <div className="bg-white rounded-xl border border-slate-200 p-5">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-4 flex items-center gap-2">
                      <Award className="h-4 w-4 text-indigo-500" /> Skill Assessment
                    </h3>
                    <div className="space-y-5">
                      {interview.scoreBreakdown?.map((criterion, index) => (
                        <div key={index} className="space-y-1.5">
                          <div className="flex justify-between items-center text-xs">
                            <span className="font-bold text-slate-700">{criterion.criteria}</span>
                            <span className={`px-2 py-0.5 rounded font-mono font-bold text-xs border ${getScoreColor(criterion.score)}`}>
                              {criterion.score * 10}/100
                            </span>
                          </div>
                          <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                            <div 
                              className={`h-full rounded-full transition-all duration-500 ${getScoreBarBg(criterion.score)}`} 
                              style={{ width: `${criterion.score * 10}%` }}
                            />
                          </div>
                          <p className="text-[11px] text-slate-500 italic mt-1 leading-normal">{criterion.feedback}</p>
                        </div>
                      ))}
                    </div>
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
              <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-2">
                <Video className="h-4 w-4 text-indigo-500" /> Candidate Session Recording
              </h3>
              {interview.recordingUrl ? (
                <div className="space-y-3">
                  {interview.recordingStatus === 'local_only' && (
                    <div className="flex items-start gap-3 p-4 bg-amber-50/70 border border-amber-200 text-amber-900 rounded-xl text-xs">
                      <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold">Recording stored temporarily — may not persist</p>
                        <p className="text-amber-700 mt-1 leading-normal">
                          The real Firebase Storage cloud upload was not enabled or failed. This video is stored temporarily on this server's ephemeral container disk. It will be wiped permanently on the next container redeployment or restart.
                        </p>
                      </div>
                    </div>
                  )}
                  <div className="aspect-video w-full bg-slate-900 rounded-xl overflow-hidden shadow-sm border border-slate-200">
                    <video 
                      src={interview.recordingUrl} 
                      controls 
                      className="w-full h-full object-contain"
                    />
                  </div>
                </div>
              ) : interview.recordingStatus === 'uploading' ? (
                <div className="p-12 rounded-xl bg-amber-50/40 border border-amber-200 text-center flex flex-col items-center justify-center animate-pulse">
                  <svg className="animate-spin h-8 w-8 text-amber-500 mb-3" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <p className="text-sm font-bold text-amber-700">Uploading recording...</p>
                  <p className="text-xs text-amber-500 mt-1">The candidate's video file is currently being saved to cloud storage.</p>
                </div>
              ) : interview.recordingStatus === 'failed' ? (
                <div className="p-8 rounded-xl bg-rose-50 border border-rose-200 text-center flex flex-col items-center justify-center">
                  <XCircle className="h-8 w-8 text-rose-500 mb-2" />
                  <p className="text-xs font-bold text-rose-700">Recording unavailable</p>
                  <p className="text-[11px] text-rose-500 mt-1">The video recording failed to upload. Dialogue transcripts are preserved below.</p>
                </div>
              ) : isProcessing ? (
                <div className="p-12 rounded-xl bg-indigo-50/40 border border-indigo-200 text-center flex flex-col items-center justify-center animate-pulse">
                  <svg className="animate-spin h-8 w-8 text-indigo-500 mb-3" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <p className="text-sm font-bold text-indigo-700">Processing Evaluation...</p>
                </div>
              ) : (
                <div className="p-8 rounded-xl bg-slate-50 border border-slate-200 text-center flex flex-col items-center justify-center">
                  <Video className="h-8 w-8 text-slate-400 mb-2" />
                  <p className="text-xs font-bold text-slate-700">No Video Recording Captured</p>
                  <p className="text-[11px] text-slate-500 mt-1">Dialogue segments are preserved below via real-time transcript capture.</p>
                </div>
              )}
            </div>

            {/* Transcript Timeline */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-4 flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-indigo-500" /> Dialog Timeline Transcript
              </h3>
              {interview.transcript && interview.transcript.length > 0 ? (
                <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 border border-slate-200/60 p-4 rounded-xl bg-slate-50/50">
                  {[...interview.transcript].sort((a, b) => a.timestamp - b.timestamp).map((item, index) => {
                    const isAI = item.sender === 'AI';
                    return (
                      <div 
                        key={index} 
                        className={`flex flex-col ${isAI ? 'items-start' : 'items-end'}`}
                      >
                        <div className="flex items-center gap-1.5 mb-1 text-[10px] text-slate-400 font-medium px-1">
                          <span className="font-semibold text-slate-600">{isAI ? 'InterviewAI Agent' : interview.applicantName}</span>
                          <span>•</span>
                          <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div 
                          className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm leading-relaxed shadow-2xs ${
                            isAI 
                              ? 'bg-white text-slate-800 border border-slate-200/60 rounded-tl-none' 
                              : 'bg-indigo-600 text-white rounded-tr-none'
                          }`}
                        >
                          {item.text}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-10 border border-dashed border-slate-200 rounded-xl text-slate-400 text-sm">
                  No dialog segments recorded yet.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
