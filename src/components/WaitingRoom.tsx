import { useEffect, useState, useRef } from 'react';
import { db } from '../firebase';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { Interview } from '../types';
import { Camera, Mic, Play, ShieldAlert, Video, AlertTriangle } from 'lucide-react';

interface WaitingRoomProps {
  interviewId: string;
  onStartInterview: (stream: MediaStream) => void;
}

export default function WaitingRoom({ interviewId, onStartInterview }: WaitingRoomProps) {
  const [interview, setInterview] = useState<Interview | null>(null);
  const [loading, setLoading] = useState(true);
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const hasHandedOverStreamRef = useRef<boolean>(false);

  useEffect(() => {
    // Fetch initial interview details
    const fetchInterview = async () => {
      try {
        const docRef = doc(db, 'interviews', interviewId);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          setInterview({ id: docSnap.id, ...docSnap.data() } as Interview);
        } else {
          setPermissionError('Interview link is invalid. Please contact your administrator.');
        }
      } catch (err) {
        console.error('Error fetching interview:', err);
        setPermissionError('Failed to load interview details.');
      } finally {
        setLoading(false);
      }
    };

    fetchInterview();
  }, [interviewId]);

  // Request permissions and open webcam stream
  const requestPermissions = async () => {
    setPermissionError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: true
      });
      
      streamRef.current = stream;
      setMediaStream(stream);
      setPermissionsGranted(true);
    } catch (err: any) {
      console.error('Error requesting camera/microphone access:', err);
      setPermissionError(
        'Camera and Microphone access are required to proceed. Please grant permissions in your browser bar.'
      );
    }
  };

  // Clean up webcam stream on unmount (only if not transitioning/handed over)
  useEffect(() => {
    return () => {
      if (streamRef.current && !hasHandedOverStreamRef.current) {
        console.log('[WaitingRoom] Stopping tracks during normal cleanup...');
        streamRef.current.getTracks().forEach((track) => track.stop());
      } else if (streamRef.current && hasHandedOverStreamRef.current) {
        console.log('[WaitingRoom] Preserving tracks for the Live Interview transition.');
      }
    };
  }, []);

  const handleStart = async () => {
    if (!permissionsGranted || !streamRef.current || !interview) return;

    try {
      // 1. Set interview status to "in_progress" in Firestore
      const docRef = doc(db, 'interviews', interview.id);
      await updateDoc(docRef, {
        status: 'in_progress',
        startedAt: Date.now()
      });

      // Mark that we are handing over the stream so unmount cleanup preserves it
      hasHandedOverStreamRef.current = true;

      // 2. Pass stream to parent and transition
      onStartInterview(streamRef.current);
    } catch (err) {
      console.error('Error starting interview:', err);
      alert('Failed to initialize interview session.');
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-bg">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-accent border-t-transparent" />
      </div>
    );
  }

  if (permissionError && !interview) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-bg p-4 font-sans">
        <div className="w-full max-w-md bg-white p-8 rounded-xl shadow-lg border border-neutral-200 text-center">
          <AlertTriangle className="h-12 w-12 text-amber-accent mx-auto mb-4" />
          <h2 className="font-display text-xl font-bold text-ink">Unable to Join Session</h2>
          <p className="mt-2 text-sm text-ink/60">{permissionError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F2F4F7] py-12 px-4 sm:px-6 lg:px-8 font-sans" id="waiting-room-view">
      <div className="mx-auto max-w-4xl grid grid-cols-1 md:grid-cols-12 gap-8">
        
        {/* Left column: Interview Details card */}
        <div className="md:col-span-5 space-y-6">
          <div className="bg-white p-6 rounded-xl border border-neutral-200 shadow-sm space-y-4">
            <div>
              <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-emerald-accent bg-emerald-accent/10 border border-emerald-accent/20 px-2.5 py-1 rounded">
                INTERVIEW WAITING ROOM
              </span>
              <h1 className="font-display text-2xl font-bold text-ink mt-3 tracking-tight">Ready to Start?</h1>
              <p className="text-xs text-ink/60 mt-1 font-semibold">Candidate: {interview?.applicantName}</p>
            </div>

            <div className="border-t border-neutral-100 pt-4 space-y-4">
              <div>
                <span className="text-[10px] font-bold text-ink/40 uppercase tracking-widest block mb-1 font-mono">Target Position</span>
                <span className="text-sm font-bold text-ink">{interview?.jobTitle}</span>
              </div>
              
              <div>
                <span className="text-[10px] font-bold text-ink/40 uppercase tracking-widest block mb-1 font-mono">Position Brief</span>
                <p className="text-xs text-ink/75 leading-relaxed max-h-32 overflow-y-auto mt-0.5 bg-neutral-bg/40 p-3 rounded-lg border border-neutral-200">
                  {interview?.jobDescription}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-1">
                <div>
                  <span className="text-[10px] font-bold text-ink/40 uppercase tracking-widest block mb-1 font-mono">Session Style</span>
                  <span className="text-xs font-bold text-emerald-accent uppercase tracking-wider font-mono">{interview?.interviewType}</span>
                </div>
                <div>
                  <span className="text-[10px] font-bold text-ink/40 uppercase tracking-widest block mb-1 font-mono">Duration</span>
                  <span className="text-xs font-semibold text-ink">{interview?.duration} minutes</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-emerald-accent/5 rounded-lg border border-emerald-accent/15 p-4 text-xs text-ink/70 leading-relaxed space-y-1.5 shadow-sm">
            <p className="font-bold text-emerald-accent font-sans">Session Guideline:</p>
            <p className="font-sans leading-relaxed text-ink/80">
              This session will be conducted by our automated interviewer. Speak naturally once the interviewer finishes speaking, and take a moment to gather your thoughts if you need to.
            </p>
          </div>
        </div>

        {/* Right column: Tech Check & Camera Preview */}
        <div className="md:col-span-7 space-y-6">
          <div className="bg-white p-6 rounded-xl border border-neutral-200 shadow-sm space-y-4">
            <h2 className="font-display text-base font-bold text-ink flex items-center gap-2">
              <div className="p-1.5 bg-emerald-accent/10 rounded-lg">
                <Camera className="h-4 w-4 text-emerald-accent" />
              </div>
              <div>
                <span>Equipment & Device Check</span>
              </div>
            </h2>
            <p className="text-xs text-ink/60 leading-relaxed font-sans">
              Ensure your webcam is positioned correctly and you are in a quiet, well-lit workspace for optimal real-time speech evaluation.
            </p>

            {/* Live Camera Preview */}
            <div className="aspect-video w-full bg-slate rounded-xl overflow-hidden relative border border-graphite shadow-md">
              {permissionsGranted && mediaStream ? (
                <video 
                  ref={(el) => {
                    videoRef.current = el;
                    if (el && mediaStream) {
                      if (el.srcObject !== mediaStream) {
                        el.srcObject = mediaStream;
                        console.log('srcObject attached:', el.srcObject);
                        el.play()
                          .then(() => console.log('[Video Preview] play() succeeded.'))
                          .catch((err) => console.error('[Video Preview] play() failed:', err));
                      }
                    }
                  }} 
                  autoPlay 
                  playsInline 
                  muted 
                  className="w-full h-full object-cover scale-x-[-1] transition-opacity duration-500 animate-fade-in" 
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center text-neutral-bg space-y-3">
                  <Video className="h-10 w-10 text-ink/30" />
                  <p className="text-xs text-ink/40 max-w-xs font-sans">Webcam live feed will activate instantly once browser equipment permissions are granted.</p>
                  <button
                    onClick={requestPermissions}
                    className="flex items-center gap-2 rounded-lg bg-emerald-accent hover:opacity-90 text-ink px-4 py-2.5 text-xs font-bold transition-all duration-200 cursor-pointer shadow-md shadow-emerald-accent/15"
                  >
                    Grant Media Device Access
                  </button>
                </div>
              )}
            </div>

            {/* Error notifications */}
            {permissionError && (
              <div className="flex items-start gap-3 rounded-lg bg-amber-accent/5 p-4 text-xs text-amber-accent border border-amber-accent/20 animate-shake">
                <ShieldAlert className="h-5 w-5 shrink-0 text-amber-accent mt-0.5" />
                <span>{permissionError}</span>
              </div>
            )}

            {/* Tech check checklist */}
            <div className="grid grid-cols-2 gap-4 text-xs pt-2">
              <div className={`flex items-center gap-2 p-3 rounded-lg border transition-all duration-300 ${permissionsGranted ? 'bg-emerald-accent/10 border-emerald-accent/20 text-emerald-accent' : 'bg-neutral-bg border-neutral-200 text-ink/30'}`}>
                <Mic className="h-4 w-4 shrink-0" />
                <span className="font-bold font-mono">Mic {permissionsGranted ? 'Active' : 'Pending'}</span>
              </div>
              <div className={`flex items-center gap-2 p-3 rounded-lg border transition-all duration-300 ${permissionsGranted ? 'bg-emerald-accent/10 border-emerald-accent/20 text-emerald-accent' : 'bg-neutral-bg border-neutral-200 text-ink/30'}`}>
                <Camera className="h-4 w-4 shrink-0" />
                <span className="font-bold font-mono">Camera {permissionsGranted ? 'Active' : 'Pending'}</span>
              </div>
            </div>

            {/* Start Interview Action */}
            <button
              onClick={handleStart}
              disabled={!permissionsGranted}
              className="w-full rounded-lg bg-emerald-accent px-4 py-3 text-sm font-bold text-ink hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-emerald-accent/50 disabled:bg-neutral-bg disabled:text-ink/30 disabled:border-neutral-200 disabled:cursor-not-allowed transition-all duration-200 cursor-pointer flex justify-center items-center gap-2 shadow-md shadow-emerald-accent/15"
            >
              <Play className="h-3.5 w-3.5 fill-current shrink-0" /> Start Live Interview Session
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
