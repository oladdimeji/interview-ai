import { useEffect, useState } from 'react';
import { db } from './firebase';
import { doc, getDoc } from 'firebase/firestore';
import { Interview } from './types';

// Importing custom components
import CreateInterview from './components/CreateInterview';
import InterviewList from './components/InterviewList';
import InterviewDetail from './components/InterviewDetail';
import WaitingRoom from './components/WaitingRoom';
import LiveInterview from './components/LiveInterview';
import InterviewComplete from './components/InterviewComplete';

import { Bot, Sparkles } from 'lucide-react';

export default function App() {
  const [route, setRoute] = useState<{ path: 'admin' | 'candidate'; interviewId?: string }>({ path: 'admin' });
  
  // Admin dashboard state
  const [selectedInterview, setSelectedInterview] = useState<Interview | null>(null);
  const [listRefreshKey, setListRefreshKey] = useState(0);

  // Candidate experience state
  const [candidateStep, setCandidateStep] = useState<'waiting_room' | 'live_interview' | 'complete'>('waiting_room');
  const [micStream, setMicStream] = useState<MediaStream | null>(null);

  // URL Popstate Router
  useEffect(() => {
    const handleRouting = () => {
      const pathname = window.location.pathname;
      const match = pathname.match(/^\/interview\/([a-zA-Z0-9_-]+)$/);
      if (match) {
        setRoute({ path: 'candidate', interviewId: match[1] });
      } else {
        setRoute({ path: 'admin' });
      }
    };

    window.addEventListener('popstate', handleRouting);
    handleRouting(); // run initial route matching

    return () => window.removeEventListener('popstate', handleRouting);
  }, []);

  const [loadingCandidateStatus, setLoadingCandidateStatus] = useState<boolean>(true);
  const [resumePermissionError, setResumePermissionError] = useState<string | null>(null);

  // Fetch interview document FIRST and check its "status" on candidate page load
  useEffect(() => {
    if (route.path !== 'candidate' || !route.interviewId) {
      setLoadingCandidateStatus(false);
      return;
    }

    setLoadingCandidateStatus(true);
    setResumePermissionError(null);

    const checkStatus = async () => {
      try {
        const docRef = doc(db, 'interviews', route.interviewId!);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data() as Interview;
          console.log(`Interview status on load: ${data.status}`);
          
          if (data.status === 'pending') {
            setCandidateStep('waiting_room');
          } else if (data.status === 'in_progress') {
            setCandidateStep('live_interview');
            // Try to auto-request permission for resuming candidates
            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480, facingMode: 'user' },
                audio: true
              });
              setMicStream(stream);
            } catch (err) {
              console.warn("Auto-permissions for resume blocked. Prompting user.", err);
              setResumePermissionError("Please allow access to your microphone and camera to resume the interview.");
            }
          } else if (data.status === 'completed' || data.status === 'processing') {
            setCandidateStep('complete');
          }
        } else {
          console.log("Interview status on load: not_found");
          setCandidateStep('waiting_room'); // Let waiting room show invalid link message
        }
      } catch (err) {
        console.error("Error checking interview status on page load:", err);
      } finally {
        setLoadingCandidateStatus(false);
      }
    };

    checkStatus();
  }, [route.path, route.interviewId]);

  // Reset candidate flow step and clean up mic/camera streams when returning to admin or switching interviews
  useEffect(() => {
    if (route.path === 'admin') {
      setCandidateStep('waiting_room');
      if (micStream) {
        micStream.getTracks().forEach((track) => track.stop());
        setMicStream(null);
      }
    }
  }, [route.path, route.interviewId]);

  const refreshInterviewList = () => {
    setListRefreshKey((prev) => prev + 1);
  };

  // --- CANDIDATE SCREEN ROUTING ---
  if (route.path === 'candidate' && route.interviewId) {
    if (loadingCandidateStatus) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC]">
          <div className="flex flex-col items-center space-y-4">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
            <p className="text-xs font-semibold text-slate-500">Checking interview status...</p>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-gray-50">
        {candidateStep === 'waiting_room' && (
          <WaitingRoom
            interviewId={route.interviewId}
            onStartInterview={(stream) => {
              setMicStream(stream);
              setCandidateStep('live_interview');
            }}
          />
        )}

        {candidateStep === 'live_interview' && !micStream && (
          <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-4 font-sans">
            <div className="w-full max-w-md bg-white p-8 rounded-xl shadow-sm border border-slate-200 text-center space-y-6">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 animate-pulse">
                <svg className="w-6 h-6 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 15H19" />
                </svg>
              </div>
              <div className="space-y-2">
                <h2 className="font-display text-xl font-bold text-slate-900">Resuming Live Session</h2>
                <p className="text-xs text-slate-500 max-w-sm mx-auto leading-relaxed">
                  You have an active interview session in progress. Please enable your microphone and camera to resume the live conversation.
                </p>
              </div>
              
              {resumePermissionError && (
                <div className="rounded-lg bg-rose-50 p-4 text-xs text-rose-600 border border-rose-100 text-left">
                  {resumePermissionError}
                </div>
              )}

              <button
                onClick={async () => {
                  try {
                    setResumePermissionError(null);
                    const stream = await navigator.mediaDevices.getUserMedia({
                      video: { width: 640, height: 480, facingMode: 'user' },
                      audio: true
                    });
                    setMicStream(stream);
                  } catch (err) {
                    console.error("Manual permission request failed:", err);
                    setResumePermissionError("Failed to obtain device permissions. Please ensure camera and microphone access are allowed in your browser settings.");
                  }
                }}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-3 text-sm font-semibold transition-colors cursor-pointer"
              >
                Enable Camera & Microphone
              </button>
            </div>
          </div>
        )}
        
        {candidateStep === 'live_interview' && micStream && (
          <LiveInterview
            interviewId={route.interviewId}
            micStream={micStream}
            onInterviewFinished={() => {
              // stop mic stream tracks
              if (micStream) {
                micStream.getTracks().forEach((track) => track.stop());
              }
              setCandidateStep('complete');
            }}
          />
        )}

        {candidateStep === 'complete' && (
          <InterviewComplete />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen lg:h-screen w-full bg-[#F8FAFC] flex flex-col lg:flex-row font-sans text-slate-900 overflow-hidden">
      {/* Sidebar Navigation */}
      <aside className="w-full lg:w-64 bg-slate-900 text-white flex flex-col shrink-0 border-b border-slate-800 lg:border-none">
        <div className="p-6 flex items-center space-x-2">
          <div className="w-8 h-8 bg-indigo-500 rounded-lg flex items-center justify-center text-white">
            <span className="text-xl font-bold font-display">I</span>
          </div>
          <h1 className="text-xl font-bold tracking-tight font-display">InterviewAI</h1>
        </div>

        <nav className="flex-1 px-4 space-y-1 mt-4">
          <div className="p-3 text-slate-400 text-xs font-semibold uppercase tracking-wider">Admin Panel</div>
          <button
            onClick={() => setSelectedInterview(null)}
            className={`w-full flex items-center space-x-3 p-3 rounded-lg transition-colors cursor-pointer text-left ${
              !selectedInterview 
                ? 'bg-indigo-600 text-white font-medium' 
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span>Dashboard</span>
          </button>
          
          <button
            onClick={() => {
              setSelectedInterview(null);
              setTimeout(() => {
                const element = document.getElementById('create-interview-view');
                if (element) {
                  element.scrollIntoView({ behavior: 'smooth' });
                }
              }, 100);
            }}
            className="w-full flex items-center space-x-3 p-3 rounded-lg text-slate-300 hover:bg-slate-800 transition-colors cursor-pointer text-left"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            <span>Create New</span>
          </button>
        </nav>

        <div className="p-6 border-t border-slate-800">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-slate-700 shrink-0 flex items-center justify-center text-white font-bold uppercase font-display text-xs">
              AD
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate text-white">Administrator</div>
              <div className="text-[10px] text-slate-400 uppercase tracking-wide">Recruiter Panel</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-white border-b border-slate-200 px-6 sm:px-8 flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2 text-sm text-slate-500 font-medium truncate">
            <button 
              onClick={() => setSelectedInterview(null)}
              className="hover:text-indigo-600 transition-colors cursor-pointer font-semibold"
            >
              Interviews
            </button>
            <span className="text-slate-300">/</span>
            <span className="text-slate-900 truncate font-semibold">
              {selectedInterview ? selectedInterview.applicantName : 'Dashboard'}
            </span>
          </div>
          <div className="flex space-x-3 shrink-0">
            {selectedInterview && (
              <button
                onClick={() => {
                  const origin = window.location.origin;
                  const shareLink = `${origin}/interview/${selectedInterview.id}`;
                  navigator.clipboard.writeText(shareLink);
                  alert("Shareable candidate interview link copied to clipboard!");
                }}
                className="px-4 py-2 border border-slate-200 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-colors cursor-pointer"
              >
                Copy Link
              </button>
            )}
          </div>
        </header>

        {/* Scrollable Layout Content */}
        <div className="flex-1 p-6 sm:p-8 overflow-y-auto bg-[#F8FAFC]">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left column: Create Form + Interview Directory */}
            <div className="lg:col-span-5 space-y-6">
              <CreateInterview onInterviewCreated={refreshInterviewList} />
              
              <InterviewList
                key={listRefreshKey}
                onSelectInterview={(selected) => setSelectedInterview(selected)}
                selectedInterviewId={selectedInterview?.id}
                onDeleteSuccess={() => setSelectedInterview(null)}
              />
            </div>

            {/* Right column: Selected candidate detailed assessment dossier report */}
            <div className="lg:col-span-7">
              {selectedInterview ? (
                <InterviewDetail 
                  interviewId={selectedInterview.id} 
                  onDeleteSuccess={() => setSelectedInterview(null)}
                />
              ) : (
                <div className="bg-white rounded-xl border border-slate-200 p-12 shadow-sm text-center min-h-[400px] flex flex-col justify-center items-center space-y-4">
                  <div className="h-16 w-16 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-500">
                    <Bot className="h-8 w-8" />
                  </div>
                  <div className="space-y-1.5 max-w-sm">
                    <h3 className="font-display font-bold text-lg text-slate-900">Applicant Dossier Viewer</h3>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      Select an interview from the directory directory on the left to review automated transcripts, webcam recordings, score breakdowns, and hire/no-hire decision reports.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
