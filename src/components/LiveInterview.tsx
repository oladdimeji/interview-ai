import { useEffect, useState, useRef } from 'react';
import { db } from '../firebase';
import { doc, getDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../firebase';
import { Interview, TranscriptEntry } from '../types';
import { Mic, MicOff, PhoneOff, Video, Volume2, Timer, Bot, User } from 'lucide-react';

interface LiveInterviewProps {
  interviewId: string;
  micStream: MediaStream;
  onInterviewFinished: () => void;
}

// PCM Audio Helper queue player
class AudioQueuePlayer {
  private audioCtx: AudioContext;
  private nextPlayTime: number = 0;
  private onStateChange: (isPlaying: boolean) => void;
  private activeSources: AudioBufferSourceNode[] = [];
  private recordingDestination: MediaStreamAudioDestinationNode | null = null;
  public analyser: AnalyserNode;

  constructor(audioCtx: AudioContext, recordingDestination: MediaStreamAudioDestinationNode | null, onStateChange: (isPlaying: boolean) => void) {
    this.audioCtx = audioCtx;
    this.recordingDestination = recordingDestination;
    this.onStateChange = onStateChange;
    this.nextPlayTime = this.audioCtx.currentTime;

    // Create an AnalyserNode to measure actual output amplitude
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    // Connect the analyser to the main output
    this.analyser.connect(this.audioCtx.destination);
  }

  playChunk(float32Array: Float32Array) {
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    const buffer = this.audioCtx.createBuffer(1, float32Array.length, 24000);
    buffer.getChannelData(0).set(float32Array);

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    
    // Connect source to our analyser
    source.connect(this.analyser);
    
    if (this.recordingDestination) {
      source.connect(this.recordingDestination);
    }

    const startTime = Math.max(this.audioCtx.currentTime, this.nextPlayTime);
    source.start(startTime);
    this.activeSources.push(source);
    
    console.log(`[Audio Live] Audio chunk scheduled to play at: ${startTime}. Buffer size: ${float32Array.length} samples.`);

    // Manage trigger playing indicator
    this.onStateChange(true);
    source.onended = () => {
      this.activeSources = this.activeSources.filter(s => s !== source);
      if (this.activeSources.length === 0) {
        this.onStateChange(false);
      }
      console.log(`[Audio Live] Audio chunk finished playing.`);
    };

    const chunkDuration = float32Array.length / 24000;
    this.nextPlayTime = startTime + chunkDuration;
  }

  isPlayingOrQueued(): boolean {
    if (this.audioCtx.state === 'closed') return false;
    return this.activeSources.length > 0 || this.nextPlayTime > this.audioCtx.currentTime;
  }

  clear() {
    this.activeSources.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    this.activeSources = [];
    this.nextPlayTime = 0;
    this.onStateChange(false);
  }
}

// Float32 micro array converter to PCM Int16 Base64
function float32ToInt16(float32Array: Float32Array): Int16Array {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16Array;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function pcmToFloat32(base64Pcm: string): Float32Array {
  const binaryString = atob(base64Pcm);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const int16Array = new Int16Array(bytes.buffer);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768;
  }
  return float32Array;
}

export default function LiveInterview({ interviewId, micStream, onInterviewFinished }: LiveInterviewProps) {
  const [interview, setInterview] = useState<Interview | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(600); // 10 minutes fallback
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const handleCompleteInterviewRef = useRef<((trigger: 'button' | 'timer' | 'ai_conclusion') => Promise<void>) | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const micMutedRef = useRef(micMuted);
  useEffect(() => {
    micMutedRef.current = micMuted;
    if (micGainNodeRef.current) {
      micGainNodeRef.current.gain.value = micMuted ? 0 : 1;
    }
  }, [micMuted]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let phase = 0;

    const draw = () => {
      animationFrameId = requestAnimationFrame(draw);

      // Handle high-dpi screens dynamically
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      ctx.clearRect(0, 0, width, height);

      // Get real-time audio volume from analyser
      let volume = 0;
      if (audioPlayerRef.current && audioPlayerRef.current.analyser) {
        const analyser = audioPlayerRef.current.analyser;
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        volume = sum / dataArray.length / 255; // 0 to 1
      }

      // If active speaking state has some buffering or brief silent gap, simulate a tiny organic pulse
      if (isAiSpeaking && volume < 0.08) {
        volume = 0.12 + Math.sin(Date.now() / 120) * 0.04;
      }

      phase += 0.04 + volume * 0.12;

      const centerX = width / 2;
      const centerY = height / 2;
      const baseRadius = 44; // Fits beautifully inside a 192px/192px (w-48 h-48) canvas

      // Draw subtle backing glow/pulses when speaking
      if (volume > 0) {
        // Outer pulsing gradient
        const outerGlow = ctx.createRadialGradient(centerX, centerY, baseRadius - 10, centerX, centerY, baseRadius + 30 + volume * 40);
        outerGlow.addColorStop(0, 'rgba(16, 185, 129, 0.15)');
        outerGlow.addColorStop(0.5, 'rgba(16, 185, 129, 0.05)');
        outerGlow.addColorStop(1, 'rgba(16, 185, 129, 0)');
        ctx.fillStyle = outerGlow;
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius + 30 + volume * 40, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Subtle ambient ring glow when idle
        const outerGlow = ctx.createRadialGradient(centerX, centerY, baseRadius - 5, centerX, centerY, baseRadius + 10);
        outerGlow.addColorStop(0, 'rgba(255, 255, 255, 0.01)');
        outerGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = outerGlow;
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius + 10, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw solid central circle background (sleek deep graphite)
      ctx.beginPath();
      ctx.arc(centerX, centerY, baseRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#1D2939'; // Sleek dark slate gray (graphite)
      ctx.fill();

      // Draw rippling/distorted border/ring
      const points = 120;
      
      // Outer rippling eco-ring (only when speaking)
      if (volume > 0) {
        ctx.beginPath();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.35)';
        for (let i = 0; i <= points; i++) {
          const angle = (i / points) * Math.PI * 2;
          let r = baseRadius + 8;
          // Fluid organic ripples
          const wave1 = Math.sin(angle * 4 - phase * 1.2) * 5;
          const wave2 = Math.cos(angle * 7 + phase * 1.8) * 3;
          r += (wave1 + wave2) * volume * 2.0;
          
          const x = centerX + Math.cos(angle) * r;
          const y = centerY + Math.sin(angle) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }

      // Primary rippling ring (always present, but distorting/pulsating when speaking, static when idle)
      ctx.beginPath();
      ctx.lineWidth = volume > 0 ? 3.5 : 2.5;
      ctx.strokeStyle = volume > 0 ? 'rgba(16, 185, 129, 0.95)' : 'rgba(255, 255, 255, 0.65)';
      
      // Add neon-like shadow to the primary stroke when speaking
      if (volume > 0) {
        ctx.shadowColor = 'rgba(16, 185, 129, 0.8)';
        ctx.shadowBlur = 10 + volume * 15;
      } else {
        ctx.shadowBlur = 0;
      }

      for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2;
        let r = baseRadius;
        if (volume > 0) {
          const wave1 = Math.sin(angle * 6 - phase * 1.5) * 6;
          const wave2 = Math.cos(angle * 10 + phase * 2.2) * 4;
          r += (wave1 + wave2) * volume * 2.2;
        }
        
        const x = centerX + Math.cos(angle) * r;
        const y = centerY + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();

      // Reset shadow configuration for next renders
      ctx.shadowBlur = 0;
    };

    draw();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isAiSpeaking]);
  
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const isConnectingRef = useRef<boolean>(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioPlayerRef = useRef<AudioQueuePlayer | null>(null);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const micChunkCountRef = useRef<number>(0);

  // High-precision unique chronological transcript system
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const activeAiEntryRef = useRef<TranscriptEntry | null>(null);
  const activeCandidateEntryRef = useRef<TranscriptEntry | null>(null);
  const lastTimestampRef = useRef<number>(0);

  const lastAiSpokeTimeRef = useRef<number>(Date.now());
  const lastCandidateActivityTimeRef = useRef<number>(Date.now());
  const lastSilenceTriggeredTimeRef = useRef<number>(0);
  const candidateTurnStartTimeRef = useRef<number>(0);
  const lastOverLengthTriggeredTimeRef = useRef<number>(0);
  const isAiSpeakingRef = useRef<boolean>(false);

  const getUniqueTimestamp = (): number => {
    const now = Date.now();
    const unique = Math.max(now, lastTimestampRef.current + 1);
    lastTimestampRef.current = unique;
    return unique;
  };

  const updateTranscript = (newTranscript: TranscriptEntry[]) => {
    const sorted = [...newTranscript].sort((a, b) => a.timestamp - b.timestamp);
    transcriptRef.current = sorted;
    setTranscript(sorted);
  };

  const appendSpeechPart = (sender: 'AI' | 'Candidate', text: string) => {
    if (!text) return;

    const isAI = sender === 'AI';
    if (!isAI) {
      lastCandidateActivityTimeRef.current = Date.now();
      if (candidateTurnStartTimeRef.current === 0) {
        candidateTurnStartTimeRef.current = Date.now();
      }
    }

    const activeRef = isAI ? activeAiEntryRef : activeCandidateEntryRef;
    const otherRef = isAI ? activeCandidateEntryRef : activeAiEntryRef;

    let cleanedText = text;
    let markerDetected = false;
    const marker = '[INTERVIEW_COMPLETE]';

    if (isAI) {
      if (cleanedText.includes(marker)) {
        console.log("[WS Live] AI conclusion marker detected in incoming chunk.");
        markerDetected = true;
        cleanedText = cleanedText.replace(marker, '');
      }
    }

    if (cleanedText) {
      if (activeRef.current === null) {
        // Finalize the other role's active utterance
        otherRef.current = null;

        const timestamp = getUniqueTimestamp();
        const newEntry: TranscriptEntry = {
          sender,
          text: cleanedText,
          timestamp
        };
        activeRef.current = newEntry;

        console.log(`New transcript entry started: [${sender}] at [${timestamp}]`);
        updateTranscript([...transcriptRef.current, newEntry]);
      } else {
        const activeEntry = activeRef.current;
        const currentText = activeEntry.text;

        if (!currentText.endsWith(cleanedText)) {
          activeEntry.text += cleanedText;
        }

        if (isAI && activeEntry.text.includes(marker)) {
          console.log("[WS Live] AI conclusion marker detected in accumulated active text.");
          markerDetected = true;
          activeEntry.text = activeEntry.text.replace(marker, '');
        }

        const updated = transcriptRef.current.map(entry => {
          if (entry.timestamp === activeEntry.timestamp) {
            return { ...entry, text: activeEntry.text };
          }
          return entry;
        });
        updateTranscript(updated);
      }
    } else if (activeRef.current !== null && isAI) {
      const activeEntry = activeRef.current;
      if (activeEntry.text.includes(marker)) {
        console.log("[WS Live] AI conclusion marker detected in empty-cleaned-chunk fallback check.");
        markerDetected = true;
        activeEntry.text = activeEntry.text.replace(marker, '');
        const updated = transcriptRef.current.map(entry => {
          if (entry.timestamp === activeEntry.timestamp) {
            return { ...entry, text: activeEntry.text };
          }
          return entry;
        });
        updateTranscript(updated);
      }
    }

    if (markerDetected) {
      console.log("[WS Live] AI conclusion marker matched! Waiting for AI closing audio to finish playing...");
      const checkPlayback = setInterval(() => {
        const isPlaying = audioPlayerRef.current?.isPlayingOrQueued() || false;
        if (!isPlaying) {
          clearInterval(checkPlayback);
          console.log("AI closing audio finished playing");
          
          // Wait an additional short buffer of 4 to 7 seconds (let's use 5 seconds)
          const bufferDelay = 5000; // 5 seconds
          console.log(`Waiting for natural pause of ${bufferDelay / 1000} seconds...`);
          setTimeout(() => {
            console.log("Natural pause complete, ending interview");
            handleCompleteInterviewRef.current?.('ai_conclusion');
          }, bufferDelay);
        }
      }, 500);
    }
  };

  const saveTranscriptToFirestore = async (updatedTranscript: TranscriptEntry[]) => {
    try {
      const sorted = [...updatedTranscript].sort((a, b) => a.timestamp - b.timestamp);
      await updateDoc(doc(db, 'interviews', interviewId), {
        transcript: sorted
      });
      console.log("[Firestore] Transcript synced successfully.");
    } catch (err) {
      console.error("[Firestore] Failed to sync transcript to Firestore:", err);
    }
  };

  const handleCompleteInterview = async (trigger: 'button' | 'timer' | 'ai_conclusion' = 'button') => {
    console.log(`Interview ending — trigger: ${trigger}`);
    if (isSubmittingRef.current) {
      console.log("[LiveInterview] Already submitting, ignoring duplicate trigger:", trigger);
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);

    const hasRecording = recordedChunksRef.current.length > 0;

    try {
      // 1. Save final sorted transcript array directly to Firestore
      try {
        await saveTranscriptToFirestore(transcriptRef.current);
      } catch (e) {
        console.error("Failed to save final transcript:", e);
      }

      // 2. Stop webcam recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch (e) {}
      }

      // 3. Shut down connection lines
      if (wsRef.current) {
        try { wsRef.current.close(); } catch (e) {}
      }
      try { audioPlayerRef.current?.clear(); } catch (e) {}

      // 4. Update Firestore status to 'processing' immediately when the interview ends (and set recordingStatus if video is expected)
      const updateData: any = {
        status: 'processing'
      };
      if (hasRecording) {
        updateData.recordingStatus = 'uploading';
      }
      await updateDoc(doc(db, 'interviews', interviewId), updateData);

      // 4. Immediately transition the candidate to the thank-you screen
      onInterviewFinished();

      // 5. Launch background fire-and-forget processing tasks
      // Task A: Video Upload (Independent)
      console.log(`Video upload triggered for interview ${interviewId}`);
      if (hasRecording) {
        (async () => {
          try {
            console.log(`[Background Process] Video upload triggered for interview ${interviewId}`);
            // Wait briefly for final video chunks to buffer from the MediaRecorder stop
            await new Promise((resolve) => setTimeout(resolve, 800));
            
            console.log(`[Background Process] Total recorded chunks collected: ${recordedChunksRef.current.length}`);
            const videoBlob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
            console.log(`Recording blob size: ${videoBlob ? videoBlob.size : 0} bytes, MIME type: ${videoBlob ? videoBlob.type : 'undefined'}`);

            if (!videoBlob || videoBlob.size === 0) {
              throw new Error("Recorded video blob is empty or undefined");
            }

            // Chunk size: 4MB (4 * 1024 * 1024)
            const CHUNK_SIZE = 4 * 1024 * 1024;
            const totalChunks = Math.ceil(videoBlob.size / CHUNK_SIZE);
            console.log(`[Background Process] Chunking videoBlob of size ${videoBlob.size} into ${totalChunks} chunks of 4MB.`);

            let finalVideoUrl = "";
            let fallbackUsed = false;

            const CONCURRENCY_LIMIT = 4;
            let currentQueueIndex = 0;
            let activeUploadsCount = 0;

            const isTransientClientError = (status: number, errText: string): boolean => {
              if (status === 503 || status === 502 || status === 504 || status === 429 || status === 408) {
                return true;
              }
              const lower = errText.toLowerCase();
              if (lower.includes("transient") || lower.includes("rate limit") || lower.includes("timeout") || lower.includes("rate_limit") || lower.includes("503") || lower.includes("502") || lower.includes("504")) {
                return true;
              }
              return false;
            };

            const uploadTask = async (chunkIndex: number): Promise<{ url?: string; fallbackUsed?: boolean } | null> => {
              const start = chunkIndex * CHUNK_SIZE;
              const end = Math.min(start + CHUNK_SIZE, videoBlob.size);
              const chunkBlob = videoBlob.slice(start, end);

              const maxChunkRetries = 3;
              let attempt = 0;

              while (true) {
                try {
                  console.log(`[Background Process] [Parallel] Uploading chunk ${chunkIndex + 1}/${totalChunks} (${chunkBlob.size} bytes) for interview ${interviewId} (Attempt ${attempt + 1}/${maxChunkRetries + 1})...`);

                  const response = await fetch(`/api/upload-video-chunk?interviewId=${interviewId}&chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/octet-stream" },
                    body: chunkBlob
                  });

                  if (!response.ok) {
                    const errText = await response.text();
                    const status = response.status;
                    const isTransient = isTransientClientError(status, errText);

                    console.warn(`[Background Process] Chunk ${chunkIndex + 1} upload failed with status ${status}. Is transient: ${isTransient}. Details: ${errText}`);

                    if (isTransient && attempt < maxChunkRetries) {
                      attempt++;
                      const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
                      console.log(`[Background Process] Retrying chunk ${chunkIndex + 1} upload in ${backoffMs}ms (Attempt ${attempt}/${maxChunkRetries})...`);
                      await new Promise((resolve) => setTimeout(resolve, backoffMs));
                      continue;
                    } else {
                      console.error(`[Background Process] Chunk ${chunkIndex + 1} upload permanently failed after retries or non-transient error.`);
                      throw new Error(`Server returned non-transient error status ${status} for chunk ${chunkIndex}: ${errText}`);
                    }
                  }

                  const result = await response.json();
                  if (attempt > 0) {
                    console.log(`[Background Process] [Parallel] Chunk ${chunkIndex + 1}/${totalChunks} succeeded on retry attempt ${attempt}!`);
                  } else {
                    console.log(`[Background Process] [Parallel] Chunk ${chunkIndex + 1}/${totalChunks} uploaded successfully on first attempt.`);
                  }
                  return result;

                } catch (err: any) {
                  const isNetworkError = err instanceof TypeError || (err.message && err.message.toLowerCase().includes("fetch"));
                  console.error(`[Background Process] Exception during chunk ${chunkIndex + 1} upload (Network error? ${isNetworkError}):`, err);

                  if (isNetworkError && attempt < maxChunkRetries) {
                    attempt++;
                    const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
                    console.log(`[Background Process] Retrying chunk ${chunkIndex + 1} upload in ${backoffMs}ms due to network error (Attempt ${attempt}/${maxChunkRetries})...`);
                    await new Promise((resolve) => setTimeout(resolve, backoffMs));
                    continue;
                  } else {
                    console.error(`[Background Process] Chunk ${chunkIndex + 1} upload permanently failed (retries exhausted or non-transient error).`);
                    throw err;
                  }
                }
              }
            };

            const uploadPool = () => {
              return new Promise<{ url: string; fallbackUsed: boolean }>((resolve, reject) => {
                let hasFailed = false;
                let finalUrlFromPool = "";
                let fallbackUsedFromPool = false;

                const next = async () => {
                  if (hasFailed) return;
                  if (currentQueueIndex >= totalChunks) {
                    if (activeUploadsCount === 0) {
                      resolve({ url: finalUrlFromPool, fallbackUsed: fallbackUsedFromPool });
                    }
                    return;
                  }

                  const chunkIndex = currentQueueIndex++;
                  activeUploadsCount++;

                  try {
                    const result = await uploadTask(chunkIndex);
                    if (result && result.url) {
                      finalUrlFromPool = result.url;
                      fallbackUsedFromPool = !!result.fallbackUsed;
                    }
                    activeUploadsCount--;
                    next();
                  } catch (err) {
                    hasFailed = true;
                    reject(err);
                  }
                };

                // Start initial batch of workers
                for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, totalChunks); i++) {
                  next();
                }
              });
            };

            const uploadStartTime = Date.now();
            const uploadResult = await uploadPool();
            finalVideoUrl = uploadResult.url;
            fallbackUsed = uploadResult.fallbackUsed;
            const uploadDurationMs = Date.now() - uploadStartTime;

            console.log(`[Background Process] All video chunks uploaded in ${(uploadDurationMs / 1000).toFixed(2)}s! Final URL: ${finalVideoUrl}, FallbackUsed: ${fallbackUsed}`);

            // Double check that we received a URL
            if (!finalVideoUrl) {
              throw new Error("No video URL returned from the server after all chunks were processed");
            }

            const finalStatus = fallbackUsed ? 'local_only' : 'ready';
            await updateDoc(doc(db, 'interviews', interviewId), {
              recordingUrl: finalVideoUrl,
              recordingStatus: finalStatus
            });
            console.log(`[Background Process] Updated Firestore recordingStatus to '${finalStatus}' and recordingUrl successfully.`);
          } catch (uploadErr: any) {
            console.error("[Background Process] Video upload failed. Full error object:", uploadErr);
            if (uploadErr && typeof uploadErr === 'object') {
              console.error("[Background Process] Detailed error info:", {
                code: uploadErr.code,
                message: uploadErr.message,
                name: uploadErr.name,
                serverResponse: uploadErr.serverResponse,
                stack: uploadErr.stack,
                customData: uploadErr.customData
              });
            }
            try {
              await updateDoc(doc(db, 'interviews', interviewId), {
                recordingStatus: 'failed'
              });
              console.log("[Background Process] Updated Firestore recordingStatus to 'failed'.");
            } catch (dbErr) {
              console.error("[Background Process] Failed to update Firestore recordingStatus to 'failed':", dbErr);
            }
          }
        })();
      } else {
        console.warn(`[Background Process] Video upload skipped for interview ${interviewId} because hasRecording is false.`);
      }

      // Task B: Trigger Backend assessment generation with Firestore propagation delay and exponential backoff retries
      (async () => {
        // Step 1: Wait 1500ms to guarantee Firestore client writes are fully synced and propagated to the backend
        console.log("[Background Process] Waiting 1500ms for Firestore write propagation before triggering assessment...");
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const maxRetries = 3;
        let attempt = 0;
        let success = false;
        let lastError: any = null;

        while (attempt <= maxRetries && !success) {
          try {
            if (attempt > 0) {
              const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
              console.log(`[Background Process] Retrying assessment in ${backoffMs}ms (Attempt ${attempt}/${maxRetries})...`);
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }

            console.log(`[Background Process] Triggering backend AI assessment (Attempt ${attempt + 1}/${maxRetries + 1})...`);
            const response = await fetch('/api/assess', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ interviewId })
            });

            if (!response.ok) {
              throw new Error(`Assessment API returned non-ok status: ${response.status}`);
            }

            console.log("[Background Process] Backend AI assessment trigger completed successfully!");
            success = true;
          } catch (err: any) {
            console.error(`[Background Process] Attempt ${attempt + 1} failed:`, err);
            lastError = err;
            attempt++;
          }
        }

        // If all retries failed, transition the interview to completed but mark assessmentStatus as failed
        if (!success) {
          console.error(`[Background Process] CRITICAL: All AI assessment attempts failed after ${maxRetries} retries. Last error:`, lastError);
          try {
            console.log(`[Background Process] Setting interview ${interviewId} status to 'completed' and assessmentStatus to 'failed'...`);
            await updateDoc(doc(db, 'interviews', interviewId), {
              status: 'completed',
              assessmentStatus: 'failed'
            });
            console.log("[Background Process] Successfully marked assessment as failed in Firestore.");
          } catch (dbErr) {
            console.error("[Background Process] Failed to write assessmentStatus 'failed' to Firestore:", dbErr);
          }
        }
      })();

    } catch (err) {
      console.error("Error setting up processing state:", err);
      onInterviewFinished();
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  handleCompleteInterviewRef.current = handleCompleteInterview;

  useEffect(() => {
    let isAborted = false;
    let isSetupComplete = false;

    // Guard against dual connection attempts within the same session
    if (isConnectingRef.current || (wsRef.current && (wsRef.current.readyState === WebSocket.CONNECTING || wsRef.current.readyState === WebSocket.OPEN))) {
      console.log("[WS Live] WebSocket connection already connecting or open. Skipping duplicate connection attempt.");
      return;
    }
    isConnectingRef.current = true;

    // 1. Fetch interview details
    const loadInterview = async () => {
      const docSnap = await getDoc(doc(db, 'interviews', interviewId));
      if (isAborted) return;
      if (docSnap.exists()) {
        const data = docSnap.data() as Interview;
        setInterview(data);
        const elapsedTimeSeconds = data.startedAt
          ? Math.floor((Date.now() - data.startedAt) / 1000)
          : 0;
        const remainingSeconds = Math.max(0, (data.duration * 60) - elapsedTimeSeconds);
        setTimeLeft(remainingSeconds);
        const existingTranscript = data.transcript || [];
        transcriptRef.current = existingTranscript;
        setTranscript(existingTranscript);
      }
    };
    loadInterview();

    // 2. Setup video preview stream
    if (videoRef.current && videoRef.current.srcObject !== micStream) {
      videoRef.current.srcObject = micStream;
    }

    // 2.5. Create a shared AudioContext and MediaStreamAudioDestinationNode for mixing AI audio + candidate microphone
    const sharedAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    const recordingDestination = sharedAudioCtx.createMediaStreamDestination();

    // Connect candidate's microphone audio to the recording destination via a GainNode for proper muting support
    const micSourceNode = sharedAudioCtx.createMediaStreamSource(micStream);
    const micGainNode = sharedAudioCtx.createGain();
    micGainNode.gain.value = micMuted ? 0 : 1;
    micGainNodeRef.current = micGainNode;

    micSourceNode.connect(micGainNode);
    micGainNode.connect(recordingDestination);

    // 3. Start local candidate webcam video recording
    try {
      recordedChunksRef.current = [];
      const options = { mimeType: 'video/webm;codecs=vp8,opus' };
      
      const recordingStream = new MediaStream();
      micStream.getVideoTracks().forEach(track => recordingStream.addTrack(track));
      recordingDestination.stream.getAudioTracks().forEach(track => recordingStream.addTrack(track));

      console.log(`[MediaRecorder] Starting with ${recordingStream.getVideoTracks().length} video track(s) and ${recordingStream.getAudioTracks().length} audio track(s).`);
      recordingStream.getAudioTracks().forEach((track, idx) => {
        console.log(`[MediaRecorder] Audio Track ${idx}: label="${track.label}", id="${track.id}", kind="${track.kind}", enabled=${track.enabled}`);
      });

      const recorder = new MediaRecorder(recordingStream, options);
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
          console.log(`MediaRecorder chunk received: ${e.data.size} bytes, total chunks so far: ${recordedChunksRef.current.length}`);
        }
      };
      recorder.start(1000); // capture 1 second slices
      mediaRecorderRef.current = recorder;
    } catch (err) {
      console.error("Local MediaRecorder failed to initialize:", err);
      // Fallback for browsers that don't support vp8,opus codecs
      try {
        const recordingStream = new MediaStream();
        micStream.getVideoTracks().forEach(track => recordingStream.addTrack(track));
        recordingDestination.stream.getAudioTracks().forEach(track => recordingStream.addTrack(track));

        console.log(`[MediaRecorder Fallback] Starting with ${recordingStream.getVideoTracks().length} video track(s) and ${recordingStream.getAudioTracks().length} audio track(s).`);
        recordingStream.getAudioTracks().forEach((track, idx) => {
          console.log(`[MediaRecorder Fallback] Audio Track ${idx}: label="${track.label}", id="${track.id}", kind="${track.kind}", enabled=${track.enabled}`);
        });

        const recorder = new MediaRecorder(recordingStream);
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            recordedChunksRef.current.push(e.data);
            console.log(`MediaRecorder chunk received: ${e.data.size} bytes, total chunks so far: ${recordedChunksRef.current.length}`);
          }
        };
        recorder.start(1000);
        mediaRecorderRef.current = recorder;
      } catch (e) {
        console.error("Standard MediaRecorder fallback failed:", e);
      }
    }

    // 4. Initialize AI audio queue player with the shared AudioContext and MediaStreamAudioDestinationNode
    audioPlayerRef.current = new AudioQueuePlayer(sharedAudioCtx, recordingDestination, (isPlaying) => {
      setIsAiSpeaking(isPlaying);
      isAiSpeakingRef.current = isPlaying;
      if (isPlaying) {
        lastSilenceTriggeredTimeRef.current = 0;
        lastOverLengthTriggeredTimeRef.current = 0;
        candidateTurnStartTimeRef.current = 0;
      } else {
        lastAiSpokeTimeRef.current = Date.now();
        lastCandidateActivityTimeRef.current = Date.now();
      }
    });

    // 5. Connect to our secure WebSocket proxy of Gemini Live API
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/live`;
    console.log(`[WS Live] Connecting to proxy WebSocket: ${wsUrl}`);
    const socket = new WebSocket(wsUrl);
    wsRef.current = socket;

    socket.onopen = () => {
      if (isAborted) {
        console.log("[WS Live] onopen fired but effect was aborted. Closing socket.");
        try { socket.close(); } catch (e) {}
        return;
      }
      console.log("[WS Live] Connected to proxy WebSocket. Loading configuration details...");
      
      // Load interview details again to guarantee correct prompts
      getDoc(doc(db, 'interviews', interviewId)).then((docSnap) => {
        if (isAborted) {
          console.log("[WS Live] getDoc completed but effect was aborted. Ignoring setup config send.");
          return;
        }
        if (!docSnap.exists()) return;
        const info = docSnap.data() as Interview;

        // Structured interview prompts for Gemini Live API
        const existingTranscript = info.transcript || [];
        const isResuming = existingTranscript.length > 0;

        // Calculate recommended question count within 2 to 4 range based on interview length/type
        let targetQuestions = 3;
        if (info.duration <= 5) {
          targetQuestions = 2;
        } else if (info.duration >= 15) {
          targetQuestions = 4;
        } else {
          targetQuestions = info.interviewType === 'Technical' ? 3 : 4;
        }

        let cvSection = "";
        if (info.cvText && info.cvText.trim()) {
          console.log(`[CV Check] cvText is present. Length: ${info.cvText.length}. First 100 characters: "${info.cvText.slice(0, 100).replace(/\n/g, ' ')}"`);
          cvSection = `
CANDIDATE CV/RESUME CONTENT:
${info.cvText.trim().slice(0, 4000)}

CV-SPECIFIC QUESTION DIRECTIVE:
You have access to the candidate's actual CV/Resume text above. During the interview, you MUST ask at least one question that references specific, real details from the candidate's actual background, experience, skills, or projects described in their CV. Make this connection feel organic and highly personalized rather than generic.
`;
        } else {
          console.log("[CV Check] cvText is null/empty");
        }

        let systemInstruction = `
You are InterviewAI, an advanced, empathetic, and highly professional conversational AI interviewer conducting a structured, interactive, live video interview.

ROLE CONTEXT:
- Candidate Name: ${info.applicantName}
- Target Job: ${info.jobTitle}
- Job Description:
${info.jobDescription}
- Interview Style: ${info.interviewType} Interview
- Target Duration: ${info.duration} minutes
- Target Question Count: exactly ${targetQuestions} questions (from a strict range of 2 to 4 questions based on duration and interview type)

CONVERSATIONAL PACE & SPEAKING STYLE:
- Note: There is no native speed or speaking rate parameter in the Gemini Multimodal Live API. Therefore, you must manage your speaking rate entirely through your style.
- Speak at a calm, composed, moderately slower pace with natural-sounding pauses.
- Keep your sentences concise, simple, and conversational.

YOUR INTERVIEW FLOW:

1. OPENING GREETING:
- Warmly and calmly greet ${info.applicantName} by name.
- Introduce yourself as InterviewAI.
- Calmly, clearly, and reassuringly state:
  a. The role they are interviewing for (${info.jobTitle})
  b. The interview type (${info.interviewType} Interview)
  c. The total duration (${info.duration} minutes)
  d. Reassuring guidance on response length: "Feel free to take a moment to think, and aim to keep answers focused — a couple of minutes per question is plenty."
- Your first message must ONLY be the warm welcome and orientation (greeting, role, interview type, duration, response-length guidance). Do NOT ask your first interview question in this same message. End your first turn after the orientation, and wait for the candidate to respond (even a brief acknowledgment like 'okay' or 'I'm ready' is fine). Make sure this opening greeting feels settling, warm, and not rushed. Give the candidate a warm moment to settle and simply invite them to state when they are ready to begin.

2. INTERVIEW STRUCTURE & TONE:
- Ask exactly ${targetQuestions} questions in total during this interview session.
- Maintain a warm, highly conversational, and human tone.
- Avoid a rigid, mechanical "ask → wait → ask" cadence.
- React briefly and naturally to what the candidate says before transitioning (e.g., "That makes sense," "Interesting approach to that problem," etc.) to demonstrate active listening, rather than jumping straight to the next question.
${cvSection}

3. CLOSING & TERMINATING THE SESSION:
- Once you have asked all ${targetQuestions} questions, or if you are informed that the time limit is reached, conclude the interview naturally.
- Give a warm parting remark, thank the candidate for their time, and let them know the team will review the full dossier.
- CRITICAL - COMPLETION SIGNAL: After your final spoken parting remarks, you MUST append the exact literal marker [INTERVIEW_COMPLETE] at the very end of your final response text.
- Do NOT speak the marker [INTERVIEW_COMPLETE] aloud, do not spell it out, do not paraphrase it, and do not describe it. It is a silent, machine-readable signal only.
`;

        if (isResuming) {
          systemInstruction += `

RESUMPTION CONTEXT:
This is a resumption of a live interview session that was briefly disconnected.
Below is the existing transcript of the conversation so far. You must resume the interview EXACTLY where it left off, based on the last message in this transcript.
Do NOT repeat the welcome message or any questions that have already been asked and answered.
If the last message was from the candidate, respond to their answer and ask the next question or follow-up.
If the last message was from you (AI), restate your last question/response briefly or prompt them to answer.

EXISTING TRANSCRIPT:
${existingTranscript.map(t => `[${t.sender}]: ${t.text}`).join('\n')}
`;
        }

        // Diagnosing assembled system instruction text
        console.log(`[System Instruction] Assembled system instruction:\n${systemInstruction}`);

        const setupMessage = {
          setup: {
            model: "models/gemini-3.1-flash-live-preview",
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: "Kore" // Kore is a professional, friendly female voice config
                  }
                }
              }
            },
            systemInstruction: {
              parts: [{ text: systemInstruction }]
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        };

        console.log("[WS Live] Sending setup config message to Gemini Live API:", JSON.stringify(setupMessage, null, 2));
        socket.send(JSON.stringify(setupMessage));
      });
    };

    socket.onmessage = async (event) => {
      if (isAborted) return;
      try {
        const rawData = typeof event.data === 'string' ? event.data : await event.data.text();
        const msg = JSON.parse(rawData);

        // Handle Setup Complete
        if (msg.setupComplete) {
          isSetupComplete = true;
          const isResuming = transcriptRef.current.length > 0;
          const seedMessageText = isResuming
            ? "The connection was lost and I have reconnected. Please resume the conversation exactly where we left off, taking into account the conversation history provided in your instructions."
            : "Hello. I am ready to begin the interview. Please give me your warm welcome and orientation, and let me know when we are ready to start. Do not ask any questions yet.";

          console.log(`[WS Live] Gemini Live API Setup Complete. Resuming? ${isResuming}. Sending seed clientContent turn to initiate AI speech...`);
          const seedMessage = {
            clientContent: {
              turns: [
                {
                  role: "user",
                  parts: [
                    {
                      text: seedMessageText
                    }
                  ]
                }
              ],
              turnComplete: true
            }
          };
          socket.send(JSON.stringify(seedMessage));
          console.log("[WS Live] Initial clientContent seed message sent successfully.");
        }

        // Handle Audio Output and transcription from Gemini
        if (msg.serverContent) {
          const { modelTurn, userTurn, turnComplete, interrupted, inputTranscription, outputTranscription } = msg.serverContent;

          if (interrupted) {
            console.log("[WS Live] Interruption detected! Stopping current AI speech audio playback.");
            audioPlayerRef.current?.clear();
          }

          // 1. Play PCM Audio chunk from modelTurn if present
          if (modelTurn && modelTurn.parts) {
            for (const part of modelTurn.parts) {
              if (part.inlineData && part.inlineData.data) {
                console.log(`[WS Live] Audio chunk received from Gemini. Base64 length: ${part.inlineData.data.length}`);
                const pcmFloat32 = pcmToFloat32(part.inlineData.data);
                audioPlayerRef.current?.playChunk(pcmFloat32);
              }
              // Fallback text transcription from modelTurn.parts if present
              if (part.text) {
                appendSpeechPart('AI', part.text);
              }
            }
          }

          // 2. Handle real-time user transcription (from inputTranscription field)
          if (inputTranscription) {
            let text = "";
            if (typeof inputTranscription.text === 'string') {
              text = inputTranscription.text;
            } else if (Array.isArray(inputTranscription.parts)) {
              text = inputTranscription.parts.map((p: any) => p.text || "").join("");
            }

            if (text) {
              appendSpeechPart('Candidate', text);
            }
          }

          // 3. Handle real-time AI transcription (from outputTranscription field)
          if (outputTranscription) {
            let text = "";
            if (typeof outputTranscription.text === 'string') {
              text = outputTranscription.text;
            } else if (Array.isArray(outputTranscription.parts)) {
              text = outputTranscription.parts.map((p: any) => p.text || "").join("");
            }

            if (text) {
              appendSpeechPart('AI', text);
            }
          }

          // 4. Fallback: Handle real-time User text transcript from userTurn.parts if present
          if (userTurn && userTurn.parts) {
            for (const part of userTurn.parts) {
              if (part.text) {
                appendSpeechPart('Candidate', part.text);
              }
            }
          }

          // Sync completed segments to Firestore
          if (turnComplete) {
            // Finalize both active speech turns so next fragments start a new turn
            activeAiEntryRef.current = null;
            activeCandidateEntryRef.current = null;

            // Sync the full ordered transcript array to Firestore
            await saveTranscriptToFirestore(transcriptRef.current);
          }
        }
      } catch (err) {
        console.error("[WS Live] Error processing websocket message:", err);
      }
    };

    socket.onerror = (error) => {
      if (isAborted) return;
      console.error("[WS Live] WebSocket connection encountered error:", error);
    };

    socket.onclose = (event) => {
      if (isAborted) return;
      console.log(`[WS Live] WebSocket connection closed: code=${event.code}, reason=${event.reason}`);
    };

    // 6. Connect microphone output to WebSocket to stream user speech PCM bytes downsampled to 16kHz
    const setupMicAudio = async () => {
      try {
        console.log("[WS Live] Initializing microphone AudioContext with sampleRate: 16000 for Gemini Live compatibility...");
        const micContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        micAudioContextRef.current = micContext;

        const workletCode = `
function uint8ToBase64(uint8Array) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bytes = uint8Array;
  let len = bytes.length;
  let base64 = '';

  for (let i = 0; i < len; i += 3) {
    let b1 = bytes[i];
    let b2 = i + 1 < len ? bytes[i + 1] : 0;
    let b3 = i + 2 < len ? bytes[i + 2] : 0;

    let c1 = b1 >> 2;
    let c2 = ((b1 & 3) << 4) | (b2 >> 4);
    let c3 = i + 1 < len ? ((b2 & 15) << 2) | (b3 >> 6) : 64;
    let c4 = i + 2 < len ? b3 & 63 : 64;

    base64 += chars.charAt(c1) + chars.charAt(c2) +
              (c3 === 64 ? '=' : chars.charAt(c3)) +
              (c4 === 64 ? '=' : chars.charAt(c4));
  }
  return base64;
}

class MicProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }
    const float32Array = input[0];
    
    // Convert to PCM Int16
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    const uint8View = new Uint8Array(int16Array.buffer);
    const base64Data = uint8ToBase64(uint8View);
    
    this.port.postMessage({ base64: base64Data });
    
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
`;

        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await micContext.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);

        if (isAborted) {
          micContext.close();
          return;
        }

        const micSource = micContext.createMediaStreamSource(micStream);
        const micNode = new AudioWorkletNode(micContext, 'mic-processor');
        micWorkletNodeRef.current = micNode;

        micSource.connect(micNode);

        const silentGainNode = micContext.createGain();
        silentGainNode.gain.value = 0;
        micNode.connect(silentGainNode);
        silentGainNode.connect(micContext.destination);

        micNode.port.onmessage = (e) => {
          if (micMutedRef.current) return;
          if (!isSetupComplete) {
            console.log("[WS Live] Blocked audio chunk — setup not complete");
            return;
          }

          const base64Data = e.data.base64;

          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              realtimeInput: {
                audio: {
                  data: base64Data,
                  mimeType: "audio/pcm;rate=16000"
                }
              }
            }));

            micChunkCountRef.current++;
            if (micChunkCountRef.current % 50 === 0) {
              console.log(`[WS Live] Throttled Mic Audio Sent: stream active. Sent ${micChunkCountRef.current} chunks total.`);
            }
          }
        };
      } catch (audioErr) {
        console.error("[WS Live] AudioWorklet initialization failed, falling back to ScriptProcessorNode...", audioErr);
        try {
          const micContext = new (window.AudioContext || (window as any).webkitAudioContext)();
          micAudioContextRef.current = micContext;
          const micSource = micContext.createMediaStreamSource(micStream);
          const micProcessor = micContext.createScriptProcessor(2048, 1, 1);
          micProcessorRef.current = micProcessor;

          micSource.connect(micProcessor);
          micProcessor.connect(micContext.destination);

          micProcessor.onaudioprocess = (e) => {
            if (micMutedRef.current) return;
            if (!isSetupComplete) {
              console.log("[WS Live] Blocked audio chunk — setup not complete");
              return;
            }
            const float32MicData = e.inputBuffer.getChannelData(0);
            const pcmInt16 = float32ToInt16(float32MicData);
            const base64Data = arrayBufferToBase64(pcmInt16.buffer);

            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                realtimeInput: {
                  audio: {
                    data: base64Data,
                    mimeType: "audio/pcm;rate=16000"
                  }
                }
              }));

              micChunkCountRef.current++;
            }
          };
        } catch (innerAudioErr) {
          console.error("[WS Live] Safe AudioContext fallback initialization failed:", innerAudioErr);
        }
      }
    };

    setupMicAudio();

    return () => {
      // Cleanups
      console.log("[WS Live] Cleaning up LiveInterview socket, audio players, and microphone stream connections...");
      isAborted = true;
      isConnectingRef.current = false;
      if (wsRef.current === socket) {
        wsRef.current = null;
      }
      try { socket.close(); } catch (e) {}
      try { audioPlayerRef.current?.clear(); } catch (e) {}
      try { micProcessorRef.current?.disconnect(); } catch (e) {}
      try { micWorkletNodeRef.current?.disconnect(); } catch (e) {}
      try { micAudioContextRef.current?.close(); } catch (e) {}
      try { sharedAudioCtx.close(); } catch (e) {}
    };
  }, [interviewId, micStream]);

  // Silence and Over-Length checking loop
  useEffect(() => {
    const interval = setInterval(() => {
      if (isSubmittingRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        return;
      }

      const now = Date.now();

      // SILENCE HANDLING
      if (!isAiSpeakingRef.current) {
        const timeSinceAiSpoke = now - lastAiSpokeTimeRef.current;
        const timeSinceCandidateActivity = now - lastCandidateActivityTimeRef.current;

        if (timeSinceAiSpoke > 22000 && timeSinceCandidateActivity > 22000 && lastSilenceTriggeredTimeRef.current === 0) {
          lastSilenceTriggeredTimeRef.current = now;
          console.log("Silence threshold reached — prompting re-engagement");
          
          const nudgeMessage = {
            clientContent: {
              turns: [
                {
                  role: "user",
                  parts: [
                    {
                      text: "[SYSTEM NOTE: Generate a natural, unique check-in in your own conversational style to gently nudge/re-engage the candidate. Keep it warm, polite, brief, and varied (do not repeat standard phrases).]"
                    }
                  ]
                }
              ],
              turnComplete: true
            }
          };
          wsRef.current.send(JSON.stringify(nudgeMessage));
        }
      }

      // OVER-LENGTH HANDLING
      if (candidateTurnStartTimeRef.current > 0 && !isAiSpeakingRef.current) {
        const timeSpentSpeaking = now - candidateTurnStartTimeRef.current;
        const durationMin = interview?.duration || 10;
        const overLengthThresholdMs = (durationMin * 60 * 0.2) * 1000;
        const thresholdMs = Math.max(45000, overLengthThresholdMs);

        if (timeSpentSpeaking > thresholdMs && lastOverLengthTriggeredTimeRef.current === 0) {
          lastOverLengthTriggeredTimeRef.current = now;
          console.log("Over-length response detected — prompting wrap-up");

          const overLengthMessage = {
            clientContent: {
              turns: [
                {
                  role: "user",
                  parts: [
                    {
                      text: "[SYSTEM NOTE: The candidate has been speaking continuously for an unusually long time (consuming a significant portion of the total interview budget). Please politely and naturally interject or gently nudge them to wrap up their answer so you can move to the next question, e.g., 'Thank you, that is a great overview — to make sure we cover everything, let's move on to...' or similar. Keep it professional, gentle, and smooth.]"
                    }
                  ]
                }
              ],
              turnComplete: true
            }
          };
          wsRef.current.send(JSON.stringify(overLengthMessage));
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [interview]);

  // Timer Countdown loop
  useEffect(() => {
    if (timeLeft <= 0) {
      handleCompleteInterviewRef.current?.('timer');
      return;
    }
    const timer = setInterval(() => {
      setTimeLeft((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [timeLeft]);

  const toggleMic = () => {
    setMicMuted(!micMuted);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const ratio = timeLeft / ((interview?.duration || 10) * 60);
  const elapsedRatio = 1 - ratio; // percentage of total time elapsed
  const timerColorClass = elapsedRatio >= 0.80 
    ? 'border-rose-500/30 bg-rose-500/5 text-rose-500 animate-pulse' 
    : elapsedRatio >= 0.60 
      ? 'border-amber-accent/30 bg-amber-accent/5 text-amber-accent' 
      : 'border-emerald-accent/30 bg-emerald-accent/5 text-emerald-accent';
  const timerIconClass = elapsedRatio >= 0.80 
    ? 'text-rose-500' 
    : elapsedRatio >= 0.60 
      ? 'text-amber-accent' 
      : 'text-emerald-accent';

  return (
    <div className="min-h-screen bg-ink text-white flex flex-col font-sans" id="live-interview-canvas">
      {/* Top Header details */}
      <div className="border-b border-graphite px-6 py-4 flex items-center justify-between bg-slate">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xs sm:text-sm font-bold tracking-tight font-display text-white">Interview in Session</h1>
            <p className="text-[10px] text-neutral-bg/50 font-mono mt-0.5">Target Position: {interview?.jobTitle}</p>
          </div>
        </div>

        {/* Time and Finish Early Controls */}
        <div className="flex items-center gap-4">
          <div className={`flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-mono transition-all duration-300 ${timerColorClass}`}>
            <Timer className={`h-4 w-4 shrink-0 ${timerIconClass}`} />
            <span>Time Budget: {formatTime(timeLeft)}</span>
          </div>
          <button
            onClick={() => handleCompleteInterview('button')}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 bg-rose-600 hover:bg-rose-500 disabled:bg-rose-800 text-white px-4 py-1.5 text-xs font-bold font-mono rounded-lg transition-colors cursor-pointer"
          >
            <PhoneOff className="h-3.5 w-3.5" /> End Interview
          </button>
        </div>
      </div>

      {/* Main split screens panel */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 p-6 gap-6">
        
        {/* Left Side: Animated AI Avatar */}
        <div className="bg-slate border border-graphite rounded-2xl flex flex-col items-center justify-center p-8 relative overflow-hidden min-h-[300px]">
          <div className="absolute top-4 left-4 flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-accent opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-accent"></span>
            </span>
            <span className="text-[10px] uppercase font-bold text-neutral-bg/50 tracking-wider font-mono">Session Active</span>
          </div>

          <div className="space-y-6 text-center z-10 w-full max-w-sm">
            {/* AI Avatar Circular Reactive Visualizer */}
            <div className="flex flex-col items-center justify-center gap-6">
              <div className="h-48 w-48 flex items-center justify-center relative">
                <canvas ref={canvasRef} className="w-full h-full opacity-100" />
              </div>
            </div>

            <div className="space-y-1.5">
              <h3 className="text-sm font-bold tracking-wide font-display text-white min-h-[24px]">
                {isAiSpeaking ? 'Interviewer Speaking...' : 'Interviewer Listening...'}
              </h3>
            </div>
          </div>
        </div>

        {/* Right Side: Candidate webcam preview */}
        <div className="bg-slate border border-graphite rounded-2xl relative overflow-hidden min-h-[300px] flex items-center justify-center">
          <div className="absolute top-4 left-4 flex items-center gap-2 z-20">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-500 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
            </span>
            <span className="text-[10px] uppercase font-bold text-neutral-bg/50 tracking-wider font-mono">Camera Recording</span>
          </div>

          {/* Local camera preview */}
          <video
            ref={(el) => {
              videoRef.current = el;
              if (el && micStream && el.srcObject !== micStream) {
                el.srcObject = micStream;
                el.play().catch(err => console.error("[Video Preview] Element failed to play stream:", err));
              }
            }}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover scale-x-[-1] z-10 opacity-90 transition-opacity duration-500"
          />

          {/* Mic controls */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
            <button
              onClick={toggleMic}
              className={`p-3 rounded-full cursor-pointer transition-all duration-200 border ${
                micMuted 
                  ? 'bg-rose-600 border-rose-500 hover:bg-rose-500 text-white' 
                  : 'bg-graphite/90 border-slate hover:bg-slate text-neutral-bg shadow-lg'
              }`}
            >
              {micMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            </button>
          </div>
        </div>

      </div>

      {/* Real-time Subtitles / Dialog Log */}
      <div className="border-t border-graphite px-6 py-4 bg-slate max-h-48 overflow-y-auto">
        <span className="text-[10px] uppercase tracking-wider font-bold text-neutral-bg/40 block mb-2 font-mono">
          Live Session Dialogue Log (Capturing...)
        </span>
        <div className="space-y-2">
          {transcript.slice(-2).map((item, index) => (
            <div key={index} className="flex gap-2 items-start text-xs leading-relaxed animate-fade-in font-mono">
              <span className={`font-bold shrink-0 ${item.sender === 'AI' ? 'text-emerald-accent' : 'text-amber-accent'}`}>
                {item.sender === 'AI' ? 'AI Host:' : 'You:'}
              </span>
              <p className="text-neutral-bg/80">{item.text}</p>
            </div>
          ))}
          {transcript.length === 0 && (
            <span className="text-xs text-neutral-bg/40 italic font-mono">Connecting and initializing audio session. AI will speak momentarily...</span>
          )}
        </div>
      </div>

      {/* Overlay Submission loader */}
      {isSubmitting && (
        <div className="fixed inset-0 bg-ink/95 flex flex-col items-center justify-center z-50 p-4 space-y-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-emerald-accent border-t-transparent" />
          <div className="text-center">
            <h2 className="text-base font-bold font-display text-white">Uploading webcam recording & compiling AI evaluation dossier...</h2>
            <p className="text-xs text-neutral-bg/40 mt-1 font-mono">Please keep this browser window open. Finalizing session data.</p>
          </div>
        </div>
      )}
    </div>
  );
}
