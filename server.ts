import express from "express";
import path from "path";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "./src/firebase.js";

dotenv.config();

function safeClose(socket: WebSocket, code: number, reason?: string | Buffer) {
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      // Valid RFC 6455 close codes to send over the wire are 1000-4999, excluding 1004, 1005, 1006, 1015
      const isValidCode = code >= 1000 && code <= 4999 && code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015;
      if (isValidCode) {
        socket.close(code, reason ? reason.toString() : undefined);
      } else {
        socket.close(1000, "Normal Closure");
      }
    }
  } catch (error) {
    console.error("[Proxy Server] Error closing WebSocket safely:", error);
    try {
      socket.close();
    } catch (e) {}
  }
}

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/api/live" });

// Initialize Gemini API client
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

// API routes
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", geminiConfigured: !!ai });
});

// AI Assessment Endpoint
app.post("/api/assess", async (req, res) => {
  const { interviewId } = req.body;
  if (!interviewId) {
    return res.status(400).json({ error: "interviewId is required" });
  }

  if (!ai) {
    return res.status(500).json({ error: "Gemini API client is not configured" });
  }

  try {
    // 1. Fetch interview details from Firestore
    const docRef = doc(db, "interviews", interviewId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      return res.status(404).json({ error: "Interview not found" });
    }

    const interview = docSnap.data();
    const transcript = interview.transcript || [];

    if (transcript.length === 0) {
      // Handle empty transcript gracefully
      const updateFields: any = {
        status: "completed",
        summary: "No interview conversation occurred.",
        scoreBreakdown: [
          { criteria: "Engagement", score: 1, feedback: "Candidate did not speak during the session." }
        ],
        decision: "no_hire",
        decisionReasoning: "The candidate joined the interview but did not provide any answers or speech."
      };

      await updateDoc(docRef, updateFields);
      return res.json({ status: "completed_empty" });
    }

    // 2. Format transcript for Gemini
    const transcriptText = transcript
      .map((entry: any) => `[${entry.sender}]: ${entry.text}`)
      .join("\n");

    // 3. Create prompt for Gemini
    const prompt = `
You are an expert executive recruiter and talent assessor. Analyze the following interview for the role of "${interview.jobTitle}" (${interview.interviewType} Interview).

Job Description:
${interview.jobDescription}

Interview Transcript:
${transcriptText}

Provide a comprehensive, professional, and objective analysis of the candidate's performance. You MUST return ONLY a JSON object matching the following structure:
{
  "summary": "A concise, high-level overview of the candidate's performance (2-3 sentences)",
  "scoreBreakdown": [
    {
      "criteria": "Criterion Name (e.g., Communication Skills, Problem Solving, Technical Aptitude, Role Fit)",
      "score": 8, // An integer between 1 and 10
      "feedback": "Specific feedback detail for this criterion"
    }
  ],
  "decision": "hire" or "no_hire",
  "decisionReasoning": "Detailed, professional justification of the hire/no-hire decision based on evidence in the transcript."
}
`;

    // 4. Generate Content
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error("No response text from Gemini");
    }

    // Parse the JSON result
    const assessment = JSON.parse(responseText.trim());

    // 5. Update interview document with assessment results
    const updateFields: any = {
      status: "completed",
      summary: assessment.summary,
      scoreBreakdown: assessment.scoreBreakdown,
      decision: assessment.decision,
      decisionReasoning: assessment.decisionReasoning,
    };

    await updateDoc(docRef, updateFields);

    res.json({ success: true, assessment });
  } catch (error: any) {
    console.error("Error in AI assessment:", error);
    res.status(500).json({ error: error.message || "Failed to complete AI assessment" });
  }
});

// In-memory set to prevent parallel reassembly race conditions
const reassemblingInterviews = new Set<string>();

// Ensure the recordings directory exists
const recordingsDir = path.join(process.cwd(), "recordings");
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

// Register static route to serve local recordings
app.use("/recordings", express.static(recordingsDir));

// Server-side Video Chunked Upload Endpoint
app.post("/api/upload-video-chunk", express.raw({ type: "*/*", limit: "15mb" }), async (req, res) => {
  const interviewId = req.query.interviewId as string;
  const chunkIndexStr = req.query.chunkIndex as string;
  const totalChunksStr = req.query.totalChunks as string;

  if (!interviewId) {
    return res.status(400).json({ error: "interviewId query parameter is required" });
  }
  if (!chunkIndexStr || !totalChunksStr) {
    return res.status(400).json({ error: "chunkIndex and totalChunks query parameters are required" });
  }

  const chunkIndex = parseInt(chunkIndexStr, 10);
  const totalChunks = parseInt(totalChunksStr, 10);

  if (isNaN(chunkIndex) || isNaN(totalChunks)) {
    return res.status(400).json({ error: "chunkIndex and totalChunks must be valid integers" });
  }

  const chunkBuffer = req.body;
  const bufferLength = chunkBuffer ? chunkBuffer.length : 0;

  console.log(`[Server Chunk Upload] Received chunk ${chunkIndex + 1}/${totalChunks} for interview ${interviewId}, size: ${bufferLength} bytes`);

  if (!chunkBuffer || bufferLength === 0) {
    return res.status(400).json({ error: "No chunk data received or buffer is empty" });
  }

  // Create temporary directory for chunks of this interview
  const tempDir = path.join(recordingsDir, `temp_${interviewId}`);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Write this chunk to disk
  const chunkFilePath = path.join(tempDir, `chunk_${chunkIndex}`);
  try {
    fs.writeFileSync(chunkFilePath, chunkBuffer);
    console.log(`[Server Chunk Upload] Saved chunk ${chunkIndex + 1}/${totalChunks} to: ${chunkFilePath}`);
  } catch (err: any) {
    console.error(`[Server Chunk Upload] Failed to write chunk ${chunkIndex} to disk:`, err);
    return res.status(500).json({ error: `Failed to write chunk to disk: ${err.message}` });
  }

  // Check if we have received all chunks
  let allChunksReceived = true;
  for (let i = 0; i < totalChunks; i++) {
    const expectedChunkPath = path.join(tempDir, `chunk_${i}`);
    if (!fs.existsSync(expectedChunkPath)) {
      allChunksReceived = false;
      break;
    }
  }

  // If not all chunks have arrived, simply acknowledge current chunk upload
  if (!allChunksReceived) {
    return res.json({ success: true, chunkReceived: chunkIndex });
  }

  // Prevent double execution in highly concurrent environments
  if (reassemblingInterviews.has(interviewId)) {
    console.log(`[Server Chunk Upload] Reassembly already in progress for interview ${interviewId}. Acknowledging chunk index: ${chunkIndex}`);
    return res.json({ success: true, chunkReceived: chunkIndex, status: "reassembly_in_progress" });
  }
  reassemblingInterviews.add(interviewId);

  // Otherwise, all chunks are received! Start reassembly and upload!
  console.log(`[Server Chunk Upload] All ${totalChunks} chunks received for interview ${interviewId}, reassembling and uploading to Storage...`);

  const localFileName = `${interviewId}.webm`;
  const localFilePath = path.join(recordingsDir, localFileName);

  try {
    // Reassemble sequentially
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }

    for (let i = 0; i < totalChunks; i++) {
      const p = path.join(tempDir, `chunk_${i}`);
      const buf = fs.readFileSync(p);
      fs.appendFileSync(localFilePath, buf);
    }
    console.log(`[Server Chunk Upload] Successfully reassembled complete video locally at: ${localFilePath}`);
  } catch (reassembleErr: any) {
    reassemblingInterviews.delete(interviewId);
    console.error(`[Server Chunk Upload] Reassembly failed:`, reassembleErr);
    return res.status(500).json({ error: `Video reassembly failed: ${reassembleErr.message}` });
  }

  // Clean up temporary chunks directory now that we have reassembled the file
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`[Server Chunk Upload] Temporary chunks directory cleaned up for interview: ${interviewId}`);
  } catch (cleanupErr) {
    console.warn(`[Server Chunk Upload] Warning: Failed to clean up temp chunks directory:`, cleanupErr);
  }

  // Upload complete reassembled file to Firebase Storage
  let videoUrl = `/recordings/${localFileName}`; // Default fallback URL
  let firebaseUploadSucceeded = false;
  let fallbackReason = "";

  let bucketName = "gen-lang-client-0637900846.firebasestorage.app";
  let firebaseApiKey = apiKey;

  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      bucketName = firebaseConfig.storageBucket || bucketName;
      firebaseApiKey = firebaseConfig.apiKey || firebaseApiKey;
    }
  } catch (err) {
    console.warn(`[Server Chunk Upload] Could not read firebase-applet-config.json, using defaults.`, err);
  }

  if (bucketName && firebaseApiKey) {
    const objectPath = encodeURIComponent(`recordings/${interviewId}.webm`);
    const uploadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o?name=${objectPath}&uploadType=media&key=${firebaseApiKey}`;
    
    console.log(`[Server Chunk Upload] Attempting Firebase Storage upload via REST to: ${uploadUrl}`);
    try {
      const fullVideoBuffer = fs.readFileSync(localFilePath);
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": "video/webm",
        },
        body: fullVideoBuffer,
      });

      console.log(`[Server Chunk Upload] Firebase Storage REST Response Status: ${response.status} ${response.statusText}`);
      const responseData = await response.json() as any;
      
      if (response.ok) {
        firebaseUploadSucceeded = true;
        const downloadToken = responseData.downloadTokens || (responseData.metadata && responseData.metadata.downloadTokens);
        videoUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${objectPath}?alt=media${downloadToken ? `&token=${downloadToken}` : ""}`;
        console.log(`[Server Chunk Upload] Uploaded to real Firebase Storage. URL: ${videoUrl}`);
      } else {
        fallbackReason = `Firebase REST returned status ${response.status}: ${JSON.stringify(responseData)}`;
        console.error(`[Server Chunk Upload] FELL BACK to local disk — reason: ${fallbackReason}`);
      }
    } catch (firebaseErr: any) {
      fallbackReason = `Firebase REST request threw exception: ${firebaseErr?.message || firebaseErr}`;
      console.error(`[Server Chunk Upload] FELL BACK to local disk — reason: ${fallbackReason}`);
    }
  } else {
    fallbackReason = "Firebase storageBucket or apiKey not configured";
    console.warn(`[Server Chunk Upload] FELL BACK to local disk — reason: ${fallbackReason}`);
  }

  // Update Firestore with the final videoUrl and appropriate recordingStatus ('ready' or 'local_only')
  const finalStatus = firebaseUploadSucceeded ? "ready" : "local_only";
  try {
    console.log(`[Server Chunk Upload] Updating Firestore document interviews/${interviewId} with recordingUrl: ${videoUrl}, recordingStatus: ${finalStatus}`);
    const docRef = doc(db, "interviews", interviewId);
    await updateDoc(docRef, {
      recordingUrl: videoUrl,
      recordingStatus: finalStatus
    });
    console.log(`[Server Chunk Upload] Firestore document successfully updated to ${finalStatus}!`);
  } catch (dbErr) {
    console.error(`[Server Chunk Upload] Failed to update Firestore with recording details:`, dbErr);
  }

  // Clean up reassembling guard
  reassemblingInterviews.delete(interviewId);

  res.json({ success: true, url: videoUrl, fallbackUsed: !firebaseUploadSucceeded });
});

// WebSocket proxy logic
wss.on("connection", (ws, request) => {
  const sessionId = Math.random().toString(36).substring(2, 10).toUpperCase();
  console.log(`[Proxy Server] [Session ${sessionId}] Client connected to Live proxy WebSocket successfully!`);

  if (!apiKey) {
    console.error(`[Proxy Server] [Session ${sessionId}] GEMINI_API_KEY is not defined in env variables`);
    safeClose(ws, 1011, "Server Gemini API key missing");
    return;
  }

  // Connect to Gemini Multimodal Live API endpoint
  // Using the standard WebSockets URL for BidiGenerateContent
  const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
  console.log(`[Proxy Server] [Session ${sessionId}] Connecting to Gemini Live API at: wss://generativelanguage.googleapis.com/...key_len=${apiKey.length}`);
  const geminiWs = new WebSocket(geminiUrl);

  // Queue to buffer messages sent by the frontend before Gemini connection is OPEN
  const messageQueue: any[] = [];

  geminiWs.on("open", () => {
    // If client disconnected while Gemini was connecting, discard everything and close upstream
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`[Proxy Server] [Session ${sessionId}] Gemini WS opened but client WS is not open (state: ${ws.readyState}). Discarding queue and closing Gemini WS.`);
      try { geminiWs.close(); } catch (e) {}
      return;
    }

    console.log(`[Proxy Server] [Session ${sessionId}] Proxy successfully connected to Gemini Live API. Flushing ${messageQueue.length} queued messages...`);
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      if (geminiWs.readyState === WebSocket.OPEN) {
        console.log(`[Proxy Server] [Session ${sessionId}] Flushing queued message to Gemini...`);
        geminiWs.send(msg);
      }
    }
  });

  geminiWs.on("message", (data) => {
    const text = data.toString("utf-8");
    try {
      const parsed = JSON.parse(text);
      if (parsed.setupComplete) {
        console.log(`[Proxy Server] [Session ${sessionId}] >>> RECEIVED SETUPCOMPLETE FROM GEMINI:`, JSON.stringify(parsed, null, 2));
      }
      if (parsed.serverContent) {
        if (parsed.serverContent.inputTranscription) {
          console.log(`[Proxy Server] [Session ${sessionId}] >>> RECEIVED INPUT TRANSCRIPTION:`, JSON.stringify(parsed.serverContent.inputTranscription));
        }
        if (parsed.serverContent.outputTranscription) {
          console.log(`[Proxy Server] [Session ${sessionId}] >>> RECEIVED OUTPUT TRANSCRIPTION:`, JSON.stringify(parsed.serverContent.outputTranscription));
        }
      }
    } catch (e) {
      // Ignored
    }

    // Forward message from Gemini back to the frontend Client
    if (ws.readyState === WebSocket.OPEN) {
      // Ensure text is sent as a text frame to the browser
      ws.send(text);
    } else {
      console.log(`[Proxy Server] [Session ${sessionId}] Dropping Gemini message because client WS is closed.`);
    }
  });

  geminiWs.on("close", (code, reason) => {
    console.log(`[Proxy Server] [Session ${sessionId}] Gemini Live API WS closed: code=${code}, reason=${reason}`);
    safeClose(ws, code, reason);
  });

  geminiWs.on("error", (error) => {
    console.error(`[Proxy Server] [Session ${sessionId}] Gemini Live API WS connection error:`, error);
    safeClose(ws, 1011, "Gemini Live API connection error");
  });

  ws.on("message", (data) => {
    const text = data.toString("utf-8");
    try {
      const parsed = JSON.parse(text);
      if (parsed.setup) {
        console.log(`[Proxy Server] [Session ${sessionId}] <<< INTERCEPTED SETUP MESSAGE BEING SENT TO GEMINI:`, JSON.stringify(parsed, null, 2));
      }
    } catch (e) {
      // Ignored
    }

    // Forward message from the frontend Client to Gemini Live API
    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(text);
    } else {
      console.log(`[Proxy Server] [Session ${sessionId}] Proxy: Gemini WebSocket not open yet. Queueing client message...`);
      messageQueue.push(text);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[Proxy Server] [Session ${sessionId}] Frontend Client WS closed: code=${code}, reason=${reason}`);
    safeClose(geminiWs, code, reason);
  });

  ws.on("error", (error) => {
    console.error(`[Proxy Server] [Session ${sessionId}] Frontend Client WS error:`, error);
    safeClose(geminiWs, 1011, "Frontend Client connection error");
  });
});

// Mount Vite middleware / Static handlers
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const PORT = 3000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Express server with WebSocket running on http://localhost:${PORT}`);
  });
}

startServer();
