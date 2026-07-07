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
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  if (permissionError && !interview) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4 font-sans">
        <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-sm border border-gray-100 text-center">
          <AlertTriangle className="h-12 w-12 text-rose-500 mx-auto mb-4" />
          <h2 className="font-display text-xl font-bold text-gray-900">Unable to Join Session</h2>
          <p className="mt-2 text-sm text-gray-500">{permissionError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] py-12 px-4 sm:px-6 lg:px-8 font-sans" id="waiting-room-view">
      <div className="mx-auto max-w-4xl grid grid-cols-1 md:grid-cols-12 gap-8">
        
        {/* Left column: Interview Details card */}
        <div className="md:col-span-5 space-y-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div>
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded">
                Candidate Workspace
              </span>
              <h1 className="font-display text-2xl font-bold text-slate-900 mt-3">Ready to Start?</h1>
              <p className="text-xs text-slate-400 mt-1 font-semibold">Candidate: {interview?.applicantName}</p>
            </div>

            <div className="border-t border-slate-100 pt-4 space-y-4">
              <div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Target Position</span>
                <span className="text-sm font-bold text-slate-800">{interview?.jobTitle}</span>
              </div>
              
              <div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Position Brief</span>
                <p className="text-xs text-slate-600 leading-relaxed max-h-32 overflow-y-auto mt-0.5 bg-[#F8FAFC] p-3 rounded border border-slate-100">
                  {interview?.jobDescription}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-1">
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Session Style</span>
                  <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">{interview?.interviewType}</span>
                </div>
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Duration</span>
                  <span className="text-xs font-semibold text-slate-700">{interview?.duration} minutes</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right column: Tech Check & Camera Preview */}
        <div className="md:col-span-7 space-y-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h2 className="font-display text-lg font-bold text-slate-900 flex items-center gap-2">
              <Camera className="h-5 w-5 text-indigo-600" /> Equipment & Device Check
            </h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Ensure your webcam is positioned correctly and you are in a quiet, well-lit workspace for optimal real-time speech evaluation.
            </p>

            {/* Live Camera Preview */}
            <div className="aspect-video w-full bg-slate-950 rounded-xl overflow-hidden relative border border-slate-200">
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
                  className="w-full h-full object-cover scale-x-[-1]" 
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center text-slate-400 space-y-3">
                  <Video className="h-12 w-12 text-slate-700" />
                  <p className="text-xs text-slate-500 max-w-xs">Webcam live feed will activate instantly once browser equipment permissions are granted.</p>
                  <button
                    onClick={requestPermissions}
                    className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 text-xs font-bold transition-colors cursor-pointer"
                  >
                    Grant Media Device Access
                  </button>
                </div>
              )}
            </div>

            {/* Error notifications */}
            {permissionError && (
              <div className="flex items-start gap-3 rounded-lg bg-rose-50 p-4 text-xs text-rose-600 border border-rose-100">
                <ShieldAlert className="h-5 w-5 shrink-0 text-rose-500 mt-0.5" />
                <span>{permissionError}</span>
              </div>
            )}

            {/* Tech check checklist */}
            <div className="grid grid-cols-2 gap-4 text-xs pt-2">
              <div className={`flex items-center gap-2 p-3 rounded-lg border ${permissionsGranted ? 'bg-emerald-50/50 border-emerald-100 text-green-700' : 'bg-slate-50 border-slate-100 text-slate-400'}`}>
                <Mic className="h-4 w-4" />
                <span className="font-bold">Microphone {permissionsGranted ? 'Connected' : 'Required'}</span>
              </div>
              <div className={`flex items-center gap-2 p-3 rounded-lg border ${permissionsGranted ? 'bg-emerald-50/50 border-emerald-100 text-green-700' : 'bg-slate-50 border-slate-100 text-slate-400'}`}>
                <Camera className="h-4 w-4" />
                <span className="font-bold">Webcam {permissionsGranted ? 'Connected' : 'Required'}</span>
              </div>
            </div>

            {/* Start Interview Action */}
            <button
              onClick={handleStart}
              disabled={!permissionsGranted}
              className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors cursor-pointer flex justify-center items-center gap-2"
            >
              <Play className="h-4 w-4 fill-current" /> Start Live Interview Session
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
