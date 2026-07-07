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
  private audioCtx: AudioContext | null = null;
  private nextPlayTime: number = 0;
  private onStateChange: (isPlaying: boolean) => void;
  private activeSources: AudioBufferSourceNode[] = [];

  constructor(onStateChange: (isPlaying: boolean) => void) {
    this.onStateChange = onStateChange;
  }

  playChunk(float32Array: Float32Array) {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      this.nextPlayTime = this.audioCtx.currentTime;
    }

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    const buffer = this.audioCtx.createBuffer(1, float32Array.length, 24000);
    buffer.getChannelData(0).set(float32Array);

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);

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

  clear() {
    this.activeSources.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    this.activeSources = [];
    this.nextPlayTime = 0;
    this.onStateChange(false);
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch (e) {}
      this.audioCtx = null;
    }
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
  }, [micMuted]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const isConnectingRef = useRef<boolean>(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioPlayerRef = useRef<AudioQueuePlayer | null>(null);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micChunkCountRef = useRef<number>(0);

  // High-precision unique chronological transcript system
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const activeAiEntryRef = useRef<TranscriptEntry | null>(null);
  const activeCandidateEntryRef = useRef<TranscriptEntry | null>(null);
  const lastTimestampRef = useRef<number>(0);

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
    const activeRef = isAI ? activeAiEntryRef : activeCandidateEntryRef;
    const otherRef = isAI ? activeCandidateEntryRef : activeAiEntryRef;

    if (activeRef.current === null) {
      // Finalize the other role's active utterance
      otherRef.current = null;

      const timestamp = getUniqueTimestamp();
      const newEntry: TranscriptEntry = {
        sender,
        text,
        timestamp
      };
      activeRef.current = newEntry;

      console.log(`New transcript entry started: [${sender}] at [${timestamp}]`);
      updateTranscript([...transcriptRef.current, newEntry]);
    } else {
      const activeEntry = activeRef.current;
      const currentText = activeEntry.text;

      if (!currentText.endsWith(text)) {
        activeEntry.text += text;
      }

      const updated = transcriptRef.current.map(entry => {
        if (entry.timestamp === activeEntry.timestamp) {
          return { ...entry, text: activeEntry.text };
        }
        return entry;
      });
      updateTranscript(updated);
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

            const uploadTask = async (chunkIndex: number): Promise<{ url?: string; fallbackUsed?: boolean } | null> => {
              const start = chunkIndex * CHUNK_SIZE;
              const end = Math.min(start + CHUNK_SIZE, videoBlob.size);
              const chunkBlob = videoBlob.slice(start, end);

              console.log(`[Background Process] [Parallel] Uploading chunk ${chunkIndex + 1}/${totalChunks} (${chunkBlob.size} bytes) for interview ${interviewId}...`);

              const response = await fetch(`/api/upload-video-chunk?interviewId=${interviewId}&chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`, {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: chunkBlob
              });

              if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Server returned error status ${response.status} for chunk ${chunkIndex}: ${errText}`);
              }

              const result = await response.json();
              console.log(`[Background Process] [Parallel] Chunk ${chunkIndex + 1}/${totalChunks} uploaded successfully.`, result);
              return result;
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

      // Task B: Trigger Backend assessment generation (Independent)
      (async () => {
        try {
          console.log("[Background Process] Triggering backend AI assessment...");
          const response = await fetch('/api/assess', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ interviewId })
          });

          if (!response.ok) {
            console.error("[Background Process] Assessment API returned non-ok status:", response.status);
          } else {
            console.log("[Background Process] Backend AI assessment trigger completed successfully!");
          }
        } catch (assessErr) {
          console.error("[Background Process] Assessment trigger failed:", assessErr);
          // In case of error, still try to set status to 'completed' as fallback so the admin can see it
          try {
            const docSnap = await getDoc(doc(db, 'interviews', interviewId));
            const data = docSnap.exists() ? docSnap.data() as Interview : null;
            if (data && data.status !== 'completed') {
              await updateDoc(doc(db, 'interviews', interviewId), {
                status: 'completed'
              });
            }
          } catch (e) {
            console.error("[Background Process] Fallback status update failed:", e);
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

    // 3. Start local candidate webcam video recording
    try {
      recordedChunksRef.current = [];
      const options = { mimeType: 'video/webm;codecs=vp8,opus' };
      const recorder = new MediaRecorder(micStream, options);
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
        const recorder = new MediaRecorder(micStream);
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

    // 4. Initialize AI audio queue player
    audioPlayerRef.current = new AudioQueuePlayer((isPlaying) => {
      setIsAiSpeaking(isPlaying);
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

        let systemInstruction = `
You are InterviewAI, an advanced conversational AI interviewer conducting a structured, highly professional, interactive one-question-at-a-time live interview.

ROLE CONTEXT:
- Candidate Name: ${info.applicantName}
- Target Job: ${info.jobTitle}
- Job Description:
${info.jobDescription}
- Interview Style: ${info.interviewType} Interview
- Target Duration: ${info.duration} minutes

YOUR DIRECTIVES:
1. Conduct a structured, welcoming, and high-fidelity interactive interview. Speak naturally, ask ONLY ONE question at a time, wait for the candidate's complete answer, and respond with relevant follow-ups or move onto the next topic.
2. The candidate will speak to you using voice. Use built-in Voice Activity Detection to listen, pause, and respond naturally. If the candidate interrupts you, pause immediately.
3. Begin by welcoming ${info.applicantName} to the InterviewAI terminal, state the role they are interviewing for, and ask the first screening or warm-up question.
4. Naturally conclude the interview by thanking the candidate when a reasonable number of questions (around 4-6) have been asked or when you are notified of time budget completion. Provide a friendly parting remark and let them know the team will review the full dossier.
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
            : "Hello. I am ready to begin the interview. Please welcome me, introduce yourself as InterviewAI, state the role I am interviewing for, and ask the first question.";

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

            // Detect AI closing/concluding remarks
            const lastAiEntry = [...transcriptRef.current].reverse().find(t => t.sender === 'AI');
            if (lastAiEntry) {
              const text = lastAiEntry.text.toLowerCase();
              const hasClosingPhrase = 
                text.includes("thank you for your time") ||
                text.includes("thank you very much for your time") ||
                text.includes("team will review") ||
                text.includes("review the full dossier") ||
                text.includes("review your dossier") ||
                text.includes("review the dossier") ||
                text.includes("conclude our interview") ||
                text.includes("concludes our interview") ||
                text.includes("conclude the interview") ||
                text.includes("concludes the interview") ||
                text.includes("wish you the best") ||
                text.includes("best of luck") ||
                text.includes("thank you for participating");

              if (hasClosingPhrase) {
                console.log("[WS Live] AI closing remarks detected in transcript. Triggering interview completion in 4.5 seconds...");
                setTimeout(() => {
                  handleCompleteInterviewRef.current?.('ai_conclusion');
                }, 4500);
              }
            }
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
    try {
      console.log("[WS Live] Initializing microphone AudioContext with sampleRate: 16000 for Gemini Live compatibility...");
      const micContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      micAudioContextRef.current = micContext;
      const micSource = micContext.createMediaStreamSource(micStream);
      const micProcessor = micContext.createScriptProcessor(2048, 1, 1);
      micProcessorRef.current = micProcessor;

      micSource.connect(micProcessor);
      micProcessor.connect(micContext.destination);

      micProcessor.onaudioprocess = (e) => {
        if (micMutedRef.current) return; // Silent if mic muted in UI (using ref to avoid stale closures)
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
          if (micChunkCountRef.current % 50 === 0) {
            console.log(`[WS Live] Throttled Mic Audio Sent: stream active. Sent ${micChunkCountRef.current} chunks total.`);
          }
        }
      };
    } catch (audioErr) {
      console.error("[WS Live] Failed to initialize AudioContext with 16000Hz, falling back to default sample rate...", audioErr);
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
      try { micAudioContextRef.current?.close(); } catch (e) {}
    };
  }, [interviewId, micStream]);

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

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col font-sans" id="live-interview-canvas">
      {/* Top Header details */}
      <div className="border-b border-slate-900 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bot className="h-5 w-5 text-indigo-400" />
          <div>
            <h1 className="text-sm font-bold tracking-tight">InterviewAI Active Terminal</h1>
            <p className="text-[10px] text-slate-400">Target: {interview?.jobTitle}</p>
          </div>
        </div>

        {/* Time and Finish Early Controls */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-300 font-mono">
            <Timer className="h-4 w-4 text-indigo-400" />
            <span>Time Budget: {formatTime(timeLeft)}</span>
          </div>
          <button
            onClick={() => handleCompleteInterview('button')}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 bg-rose-600 hover:bg-rose-500 disabled:bg-rose-800 text-white px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
          >
            <PhoneOff className="h-3.5 w-3.5" /> End Interview
          </button>
        </div>
      </div>

      {/* Main split screens panel */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 p-6 gap-6">
        
        {/* Left Side: Animated AI Avatar */}
        <div className="bg-slate-900/60 border border-slate-900 rounded-2xl flex flex-col items-center justify-center p-8 relative overflow-hidden min-h-[300px]">
          <div className="absolute top-4 left-4 flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
            </span>
            <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">AI Host Active</span>
          </div>

          <div className="space-y-6 text-center z-10">
            {/* AI Avatar Pulse */}
            <div className="flex justify-center">
              <div className={`h-24 w-24 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center transition-all ${isAiSpeaking ? 'pulse-ai' : 'scale-95 opacity-80'}`}>
                <Bot className="h-10 w-10 text-white" />
              </div>
            </div>

            <div className="space-y-1.5 max-w-sm">
              <h3 className="text-sm font-semibold tracking-wide">
                {isAiSpeaking ? 'AI Interrogator Speaking...' : 'AI Host is Listening...'}
              </h3>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                The AI will conduct the interview automatically. Speak naturally when the AI finishes speaking.
              </p>
            </div>
          </div>
        </div>

        {/* Right Side: Candidate webcam preview */}
        <div className="bg-slate-900/60 border border-slate-900 rounded-2xl relative overflow-hidden min-h-[300px] flex items-center justify-center">
          <div className="absolute top-4 left-4 flex items-center gap-2 z-20">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
            </span>
            <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Webcam Streaming & Recording</span>
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
            className="absolute inset-0 w-full h-full object-cover scale-x-[-1] z-10"
          />

          {/* Mic controls */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex gap-2">
            <button
              onClick={toggleMic}
              className={`p-3 rounded-full cursor-pointer transition-colors border ${
                micMuted 
                  ? 'bg-rose-600 border-rose-500 hover:bg-rose-500 text-white' 
                  : 'bg-slate-800/80 border-slate-700 hover:bg-slate-700 text-slate-200'
              }`}
            >
              {micMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            </button>
            <div className="flex items-center gap-1 bg-slate-900/90 border border-slate-800 rounded-full px-4 text-xs font-semibold text-slate-200">
              <Volume2 className="h-4 w-4 text-indigo-400" />
              <span>Voice Detection On</span>
            </div>
          </div>
        </div>

      </div>

      {/* Real-time Subtitles / Dialog Log */}
      <div className="border-t border-slate-900 px-6 py-4 bg-slate-950/80 max-h-48 overflow-y-auto">
        <span className="text-[9px] uppercase tracking-wider font-bold text-slate-500 block mb-2">
          Live Session Transcription Transcript
        </span>
        <div className="space-y-2">
          {transcript.slice(-2).map((item, index) => (
            <div key={index} className="flex gap-2 items-start text-xs leading-relaxed animate-fade-in">
              <span className={`font-bold shrink-0 ${item.sender === 'AI' ? 'text-indigo-400' : 'text-slate-300'}`}>
                {item.sender === 'AI' ? 'AI Host:' : 'You:'}
              </span>
              <p className="text-slate-300">{item.text}</p>
            </div>
          ))}
          {transcript.length === 0 && (
            <span className="text-xs text-slate-500 italic">Connecting and initializing audio session. AI will speak momentarily...</span>
          )}
        </div>
      </div>

      {/* Overlay Submission loader */}
      {isSubmitting && (
        <div className="fixed inset-0 bg-slate-950/90 flex flex-col items-center justify-center z-50 p-4 space-y-4">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
          <div className="text-center">
            <h2 className="text-lg font-bold">Uploading webcam recording & generating AI evaluation dossier...</h2>
            <p className="text-xs text-slate-400 mt-1">Please wait. Do not close your browser tab.</p>
          </div>
        </div>
      )}
    </div>
  );
}
