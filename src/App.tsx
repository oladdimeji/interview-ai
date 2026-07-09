import { useEffect, useState } from 'react';
import { db, auth } from './firebase';
import { doc, getDoc } from 'firebase/firestore';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import { Interview } from './types';

// Importing custom components
import CreateInterview from './components/CreateInterview';
import InterviewList from './components/InterviewList';
import InterviewDetail from './components/InterviewDetail';
import WaitingRoom from './components/WaitingRoom';
import LiveInterview from './components/LiveInterview';
import InterviewComplete from './components/InterviewComplete';
import Login from './components/Login';

import { Bot, Sparkles, LogOut } from 'lucide-react';

export default function App() {
  const [route, setRoute] = useState<{ path: 'admin' | 'candidate'; interviewId?: string }>({ path: 'admin' });
  
  // Authentication states
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Admin dashboard state
  const [adminView, setAdminView] = useState<'dashboard' | 'create'>('dashboard');
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

  // --- ADMIN LOADING STATE ---
  if (route.path === 'admin' && authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-bg font-sans">
        <div className="flex flex-col items-center space-y-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-accent border-t-transparent" />
          <p className="text-xs font-semibold text-slate-500">Checking authorization status...</p>
        </div>
      </div>
    );
  }

  // --- ADMIN GATED LOGIN SCREEN ---
  if (route.path === 'admin' && !currentUser) {
    return <Login />;
  }

  return (
    <div className="min-h-screen lg:h-screen w-full bg-neutral-bg flex flex-col lg:flex-row font-sans text-ink overflow-hidden">
      {/* Sidebar Navigation */}
      <aside className="w-full lg:w-64 bg-ink text-neutral-bg flex flex-col shrink-0 border-b border-graphite lg:border-none shadow-xl z-10">
        <div className="p-6 flex items-center space-x-3 border-b border-graphite">
          <div className="w-9 h-9 bg-emerald-accent rounded-lg flex items-center justify-center text-ink shadow-[0_0_12px_rgba(16,185,129,0.3)]">
            <span className="text-xl font-bold font-display">I</span>
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight font-display text-white">InterviewAI</h1>
          </div>
        </div>

        <nav className="flex-1 px-4 space-y-1.5 mt-6">
          <button
            onClick={() => {
              setAdminView('dashboard');
              setSelectedInterview(null);
            }}
            className={`w-full flex items-center space-x-3 p-3 rounded-lg transition-all duration-200 cursor-pointer text-left ${
              adminView === 'dashboard' && !selectedInterview
                ? 'bg-emerald-accent text-ink font-semibold shadow-lg shadow-emerald-accent/20' 
                : 'text-neutral-bg/70 hover:bg-slate/50 hover:text-white'
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            <span className="text-sm">Dashboard</span>
          </button>
          
          <button
            onClick={() => {
              setSelectedInterview(null);
              setAdminView('create');
            }}
            className={`w-full flex items-center space-x-3 p-3 rounded-lg transition-all duration-200 cursor-pointer text-left ${
              adminView === 'create'
                ? 'bg-emerald-accent text-ink font-semibold shadow-lg shadow-emerald-accent/20' 
                : 'text-neutral-bg/70 hover:bg-slate/50 hover:text-white'
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            <span className="text-sm">Create New</span>
          </button>
        </nav>

        <div className="p-6 border-t border-graphite bg-slate/30 flex items-center justify-between gap-2">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="w-9 h-9 rounded-full bg-slate border border-graphite shrink-0 flex items-center justify-center text-white font-bold uppercase font-display text-xs">
              AD
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold truncate text-white">Administrator</div>
            </div>
          </div>
          <button
            onClick={() => signOut(auth)}
            title="Log out"
            className="p-1.5 rounded-md hover:bg-white/10 text-neutral-bg/60 hover:text-white transition-colors cursor-pointer"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-white border-b border-neutral-200 px-6 sm:px-8 flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2 text-sm text-ink/60 font-medium truncate">
            <button 
              onClick={() => {
                setAdminView('dashboard');
                setSelectedInterview(null);
              }}
              className="hover:text-emerald-accent transition-colors cursor-pointer font-semibold"
            >
              Interviews
            </button>
            <span className="text-neutral-bg/50">/</span>
            <span className="text-ink truncate font-semibold">
              {selectedInterview ? selectedInterview.applicantName : adminView === 'create' ? 'Create New' : 'Dashboard'}
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
                className="px-4 py-2 bg-slate text-neutral-bg text-xs border border-graphite rounded-lg font-semibold hover:bg-ink transition-colors duration-200 cursor-pointer shadow-sm flex items-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5 text-emerald-accent" />
                Copy Share Link
              </button>
            )}
          </div>
        </header>

        {/* Scrollable Layout Content */}
        <div className="flex-1 p-6 sm:p-8 overflow-y-auto bg-neutral-bg">
          {adminView === 'create' ? (
            <div className="max-w-3xl mx-auto">
              <CreateInterview 
                onInterviewCreated={() => {
                  refreshInterviewList();
                  setAdminView('dashboard');
                }} 
              />
            </div>
          ) : (
            <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* Left column: Interview Directory */}
              <div className="lg:col-span-5 space-y-6">
                <InterviewList
                  key={listRefreshKey}
                  onSelectInterview={(selected) => setSelectedInterview(selected)}
                  selectedInterviewId={selectedInterview?.id}
                  onDeleteSuccess={() => setSelectedInterview(null)}
                />
              </div>

              {/* Right column: Selected candidate detailed assessment dossier report */}
              <div className="lg:col-span-7 lg:sticky lg:top-0 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto pr-2">
                {selectedInterview ? (
                  <InterviewDetail 
                    interviewId={selectedInterview.id} 
                    onDeleteSuccess={() => setSelectedInterview(null)}
                  />
                ) : (
                  <div className="bg-white rounded-xl border border-neutral-bg/20 p-12 shadow-sm text-center min-h-[400px] flex flex-col justify-center items-center space-y-4">
                    <div className="h-16 w-16 bg-emerald-accent/10 rounded-2xl flex items-center justify-center text-emerald-accent shadow-sm">
                      <Bot className="h-8 w-8" />
                    </div>
                    <div className="space-y-1.5 max-w-sm">
                      <h3 className="font-display font-bold text-lg text-ink">Applicant Overview</h3>
                      <p className="text-xs text-ink/60 leading-relaxed">
                        Select an interview from the directory on the left to review automated transcripts, webcam recordings, score breakdowns, and hire/no-hire decision reports.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
