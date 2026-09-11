import express from "express";
import path from "path";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";
import { doc, getDoc, updateDoc, deleteDoc, collection, addDoc, runTransaction } from "firebase/firestore";
import { db } from "./src/firebase.js";
import { google } from "googleapis";
import { exec } from "child_process";
import { promisify } from "util";
import multer from "multer";
import { Readable } from "stream";
import { createRequire } from "module";
import { assertInterviewCanStart, getBookingUrl, getDriveConnection, integrationsRouter, syncScheduledInterview } from './integrations.js';

let pdf: any;
let mammoth: any;

try {
  // @ts-ignore
  const req = createRequire(import.meta.url);
  pdf = req("pdf-parse");
  mammoth = req("mammoth");
} catch (e) {
  try {
    // @ts-ignore
    pdf = require("pdf-parse");
    // @ts-ignore
    mammoth = require("mammoth");
  } catch (err) {
    console.error("Failed to load pdf-parse or mammoth libraries:", err);
  }
}

const execPromise = promisify(exec);

function isTransientDriveError(err: any): boolean {
  if (!err) return false;
  
  // Check HTTP status code
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (status === 503 || status === 502 || status === 504 || status === 429 || status === 408) {
    return true;
  }
  
  // Check specific Google API error reasons
  if (err.errors && Array.isArray(err.errors)) {
    for (const e of err.errors) {
      if (e.reason === 'transientError' || e.reason === 'rateLimitExceeded' || e.reason === 'userRateLimitExceeded') {
        return true;
      }
    }
  }
  
  // Inspect message text for indications of a transient failure
  const msg = (err.message || String(err)).toLowerCase();
  if (msg.includes('transient') || msg.includes('rate limit') || msg.includes('timeout') || msg.includes('503') || msg.includes('502') || msg.includes('504')) {
    return true;
  }
  
  return false;
}

dotenv.config({ path: '.env.local' });
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
app.use(express.json({ limit: '2mb' }));
app.use('/api', integrationsRouter);

app.get('/book/:token', async (req, res) => {
  try { res.redirect(await getBookingUrl(req.params.token)); }
  catch (error: any) { res.status(400).type('text').send(error.message); }
});

app.post('/api/interviews/:id/start', async (req, res) => {
  try {
    await assertInterviewCanStart(req.params.id);
    const startedAt = await runTransaction(db, async transaction => {
      const ref = doc(db, 'interviews', req.params.id);
      const snapshot = await transaction.get(ref);
      const interview = snapshot.data();
      if (!interview || !['pending', 'in_progress'].includes(interview.status)) throw new Error('This interview is no longer available.');
      if (interview.status === 'in_progress') return interview.startedAt;
      const start = Date.now();
      transaction.update(ref, { status: 'in_progress', startedAt: start });
      return start;
    });
    res.json({ startedAt });
  } catch (error: any) { res.status(403).json({ error: error.message }); }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/api/live" });

const apiKey = process.env.GEMINI_API_KEY;

// Helper to lazily initialize the Gemini API client
function getGeminiClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// API routes
app.get("/api/health", (req, res) => {
  const aiClient = getGeminiClient();
  res.json({ status: "ok", geminiConfigured: !!aiClient });
});

async function assessInterview(interviewId: string) {
  const aiClient = getGeminiClient();
  if (!aiClient) throw new Error('Gemini API client is not configured');
  const docRef = doc(db, 'interviews', interviewId);
  const snapshot = await getDoc(docRef);
  if (!snapshot.exists()) throw new Error('Interview not found');
  const interview = snapshot.data();
  const transcript = interview.transcript || [];
  let assessment: any;
  if (!transcript.length) {
    assessment = {
      summary: 'No interview conversation occurred.',
      scoreBreakdown: [{ criteria: 'Engagement', score: 1, feedback: 'Candidate did not speak during the session.' }],
      decision: 'no_hire', decisionReasoning: 'The candidate did not provide any answers during the session.',
    };
  } else {
    const response = await aiClient.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [
        'You are an expert recruiter. Assess the interview objectively using evidence from the transcript.',
        'Role: ' + interview.jobTitle + ' (' + interview.interviewType + ')',
        'Job description: ' + interview.jobDescription,
        'Transcript:', ...transcript.map((entry: any) => '[' + entry.sender + ']: ' + entry.text),
        'Return JSON with summary (2-3 sentences), scoreBreakdown (array of { criteria, score: integer 1-10, feedback }), decision (hire or no_hire), and decisionReasoning (evidence-based explanation).',
      ].join('\n'),
      config: { responseMimeType: 'application/json' },
    });
    const text = (response.text || '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    assessment = JSON.parse(text);
    if (typeof assessment.summary !== 'string' || typeof assessment.decisionReasoning !== 'string' ||
        !['hire', 'no_hire'].includes(assessment.decision) || !Array.isArray(assessment.scoreBreakdown) ||
        !assessment.scoreBreakdown.length || assessment.scoreBreakdown.some((item: any) =>
          typeof item.criteria !== 'string' || typeof item.feedback !== 'string' || !Number.isInteger(item.score) || item.score < 1 || item.score > 10)) {
      throw new Error('The assessment response was incomplete.');
    }
  }
  await updateDoc(docRef, { status: 'completed', assessmentStatus: 'ready',
    summary: assessment.summary, scoreBreakdown: assessment.scoreBreakdown,
    decision: assessment.decision, decisionReasoning: assessment.decisionReasoning });
  return assessment;
}

app.post('/api/assess', async (req, res) => {
  if (!req.body.interviewId) return res.status(400).json({ error: 'interviewId is required' });
  try { res.json({ success: true, assessment: await assessInterview(req.body.interviewId) }); }
  catch (error: any) { res.status(500).json({ error: error.message || 'Assessment failed.' }); }
});

// Multer setup for handling CV upload
const multerStorage = multer.memoryStorage();
const upload = multer({
  storage: multerStorage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Helper for extracting text from PDF/DOCX buffer
async function extractTextFromBuffer(buffer: Buffer, originalname: string, mimetype: string): Promise<string | null> {
  const ext = path.extname(originalname).toLowerCase();
  
  let pdfParser = pdf;
  if (typeof pdfParser !== 'function' && pdfParser?.default) {
    pdfParser = (pdfParser as any).default;
  }

  let mammothExtractor = mammoth;
  if (!mammothExtractor?.extractRawText && mammothExtractor?.default) {
    mammothExtractor = (mammothExtractor as any).default;
  }

  try {
    if (ext === ".pdf" || mimetype === "application/pdf") {
      console.log(`[CV Text Extraction] Extracting text from PDF of length ${buffer.length}`);
      let text = "";
      if (typeof pdfParser === 'function') {
        const data = await pdfParser(buffer);
        text = data.text;
      } else if (pdfParser && typeof pdfParser.PDFParse === 'function') {
        const parserInstance = new pdfParser.PDFParse({ data: buffer });
        try {
          const result = await parserInstance.getText();
          text = result.text;
        } finally { await parserInstance.destroy(); }
      } else {
        throw new Error("No suitable PDF parser found in the pdf-parse module.");
      }
      console.log(`[CV Text Extraction] Extracted ${text ? text.length : 0} characters from PDF.`);
      return text || null;
    } else if (ext === ".docx" || mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === ".doc") {
      console.log(`[CV Text Extraction] Extracting text from DOCX of length ${buffer.length}`);
      const result = await mammothExtractor.extractRawText({ buffer });
      const text = result.value;
      console.log(`[CV Text Extraction] Extracted ${text ? text.length : 0} characters from DOCX.`);
      return text || null;
    } else {
      console.log(`[CV Text Extraction] Unsupported extension or mimetype for extraction: ${ext} / ${mimetype}`);
      return null;
    }
  } catch (err: any) {
    console.error(`[CV Text Extraction] Error during text extraction for ${originalname}:`, err);
    return null;
  }
}

// Helper for uploading CV to Google Drive
async function uploadCvToDrive(interviewId: string, fileBuffer: Buffer, fileName: string, mimeType: string): Promise<string | null> {
  try {
    const { drive, folderId } = await getDriveConnection();
    const uploaded = await drive.files.create({
      supportsAllDrives: true,
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: Readable.from(fileBuffer) },
      fields: 'id',
    });
    return uploaded.data.id ? 'https://drive.google.com/file/d/' + uploaded.data.id + '/preview' : null;
  } catch (error: any) {
    console.error('[CV Upload]', error.message);
    return null;
  }
}

// Helper for asynchronous background CV extraction, Drive upload, and Firestore updating
async function processCvAndDriveInBackground(interviewId: string, file: Express.Multer.File): Promise<void> {
  console.log(`[Background CV Processing] Starting for interview ${interviewId}: ${file.originalname} (${file.size} bytes)`);
  let cvText: string | null = null;
  let cvFileUrl: string | null = null;

  // 1. Text Extraction
  try {
    const extracted = await extractTextFromBuffer(file.buffer, file.originalname, file.mimetype);
    if (extracted && extracted.trim()) {
      cvText = extracted.trim();
      console.log(`[Background CV Processing] Successfully extracted CV text. Length: ${cvText.length} chars.`);
    } else {
      console.warn(`[Background CV Processing] Text extraction returned empty/null for: ${file.originalname}`);
    }
  } catch (extractErr: any) {
    console.error(`[Background CV Processing] Text extraction failed with raw error:`, extractErr);
  }

  // 2. Google Drive upload
  try {
    const fileExtension = path.extname(file.originalname).toLowerCase() || (file.mimetype === "application/pdf" ? ".pdf" : ".docx");
    const driveFileName = `${interviewId}${fileExtension}`;
    cvFileUrl = await uploadCvToDrive(interviewId, file.buffer, driveFileName, file.mimetype);
    if (cvFileUrl) {
      console.log(`[Background CV Processing] CV uploaded to Google Drive. URL: ${cvFileUrl}`);
    } else {
      console.warn(`[Background CV Processing] Google Drive CV upload skipped or returned null.`);
    }
  } catch (driveErr: any) {
    console.error(`[Background CV Processing] Google Drive upload error:`, driveErr);
  }

  // 3. Update Firestore with cvText and cvFileUrl
  if (cvText !== null || cvFileUrl !== null) {
    try {
      console.log(`[Background CV Processing] Updating Firestore interviews/${interviewId} with cvText/cvFileUrl...`);
      await updateDoc(doc(db, "interviews", interviewId), {
        cvText,
        cvFileUrl,
      });
      console.log(`[Background CV Processing] Firestore updated successfully for interview ${interviewId}.`);
    } catch (updateErr: any) {
      console.error(`[Background CV Processing] Failed to update Firestore with CV details:`, updateErr);
    }
  }
}

app.post('/api/invitations/:id/cv', upload.single('cv'), async (req, res) => {
  try {
    await syncScheduledInterview(req.params.id, true);
    const ref = doc(db, 'interviews', req.params.id);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists() || snapshot.data().status !== 'pending' || snapshot.data().bookingStatus !== 'confirmed') {
      return res.status(409).json({ error: 'A confirmed, upcoming interview is required before uploading your CV.' });
    }
    const file = req.file;
    if (!file || !['.pdf', '.docx'].includes(path.extname(file.originalname).toLowerCase())) {
      return res.status(400).json({ error: 'Upload a PDF or DOCX CV (up to 10 MB).' });
    }
    const text = (await extractTextFromBuffer(file.buffer, file.originalname, file.mimetype))?.trim();
    if (!text || text.length < 20) return res.status(422).json({ error: 'We could not read the text in this CV. Please upload a text-based PDF or DOCX file instead of a scanned image.' });
    if (text.length > 100000) return res.status(422).json({ error: 'This document is too long. Please upload a shorter CV.' });
    const cvFileUrl = await uploadCvToDrive(req.params.id, file.buffer, `${req.params.id}${path.extname(file.originalname).toLowerCase()}`, file.mimetype);
    await updateDoc(ref, { cvText: text, cvFileUrl, cvStatus: 'ready' });
    res.json({ success: true });
  } catch (error: any) { res.status(400).json({ error: error.message || 'Could not process the CV. Please try again.' }); }
});

// POST /api/interviews - Create new interview with immediate response and background processing
app.post(
  "/api/interviews",
  (req, res, next) => {
    (upload.single("cv") as any)(req, res, (err: any) => {
      if (err) {
        console.error("[Server Create Interview] Multer upload error:", err);
        return res.status(400).type("json").json({ error: err.message || "File upload error" });
      }
      next();
    });
  },
  async (req, res) => {
    res.type("json");
    try {
      console.log("[Server Create Interview] Received request body:", req.body);
      const { applicantName, jobTitle, jobDescription, interviewType, duration } = req.body;

      if (!applicantName || !jobTitle || !jobDescription || !interviewType || !duration) {
        return res.status(400).type("json").json({ error: "Missing required fields" });
      }

      // 1. Create document in Firestore
      console.log("[Server Create Interview] Creating initial document in Firestore...");
      const colRef = collection(db, "interviews");
      const docRef = await addDoc(colRef, {
        applicantName,
        jobTitle,
        jobDescription,
        interviewType,
        duration: parseInt(duration, 10),
        status: "pending",
        createdAt: new Date().toISOString(),
        transcript: [],
        cvText: null,
        cvFileUrl: null,
      });

      const interviewId = docRef.id;
      console.log(`[Server Create Interview] Created Firestore interview doc ID: ${interviewId}`);

      // 2. Send immediate response to client
      res.status(200).type("json").json({ success: true, interviewId });

      // 3. Process CV / Drive uploads asynchronously in the background without blocking the HTTP response
      if (req.file) {
        processCvAndDriveInBackground(interviewId, req.file).catch((err) => {
          console.error("[Background Processing Error]", err);
        });
      } else {
        console.log("[Server Create Interview] No CV file uploaded for this interview.");
      }
    } catch (err: any) {
      console.error("[Server Create Interview] Unexpected error creating interview:", err);
      return res.status(500).type("json").json({ error: err.message || "Failed to create interview" });
    }
  }
);

// DELETE /api/interviews/:id
app.delete("/api/interviews/:id", async (req, res) => {
  const interviewId = req.params.id;
  if (!interviewId) {
    return res.status(400).json({ error: "Interview ID is required" });
  }

  console.log(`[Server Delete Interview] Initiating deletion for interview ID: ${interviewId}`);

  let recordingUrl = "";
  let fileIdToDeleted: string | null = null;

  try {
    // 1. Fetch interview details from Firestore to get recordingUrl
    const docRef = doc(db, "interviews", interviewId);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      const interview = docSnap.data();
      recordingUrl = interview.recordingUrl || "";
    }

    // 2. Try to extract Google Drive file ID if recordingUrl exists
    if (recordingUrl && recordingUrl.includes("drive.google.com")) {
      console.log(`[Server Delete Interview] Found recording URL on Drive: ${recordingUrl}`);
      // Parse fileId from URL, e.g. https://drive.google.com/file/d/[FILE_ID]/preview
      const dMatch = recordingUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (dMatch && dMatch[1]) {
        fileIdToDeleted = dMatch[1];
        console.log(`[Server Delete Interview] Extracted Google Drive file ID: ${fileIdToDeleted}`);
      }
    }

    // 3. Delete from Google Drive if fileId was found
    if (fileIdToDeleted) {
      try {
        const { drive } = await getDriveConnection();
        console.log(`[Server Delete Interview] Deleting file from Google Drive: ${fileIdToDeleted}`);
        await drive.files.delete({
          fileId: fileIdToDeleted,
          supportsAllDrives: true,
        });
        console.log(`[Server Delete Interview] Google Drive file deleted successfully.`);
      } catch (driveErr: any) {
        // Log the failure clearly but don't block the Firestore deletion
        console.error(`[Server Delete Interview] Failed to delete file from Google Drive (non-blocking):`, driveErr?.message || driveErr);
      }
    }

    // 4. Delete Firestore document
    console.log(`[Server Delete Interview] Deleting Firestore document interviews/${interviewId}`);
    await deleteDoc(docRef);
    console.log(`[Server Delete Interview] Firestore document deleted successfully.`);

    return res.json({ success: true });

  } catch (err: any) {
    console.error(`[Server Delete Interview] CRITICAL ERROR during deletion:`, err);
    return res.status(500).json({
      error: `Failed to delete interview: ${err.message || err}`,
      details: err.stack || String(err)
    });
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

// Progressive sequential chunk uploading state and mapping
interface ProgressiveState {
  nextExpectedIndex: number;
  lastActivity: number;
}
const progressiveStates = new Map<string, ProgressiveState>();

// Server-side Video Chunked Upload Endpoint (append chunks progressively as they arrive)
app.post("/api/upload-video-chunk", express.raw({ type: "*/*", limit: "15mb" }), async (req, res) => {
  const interviewId = req.query.interviewId as string;
  const chunkIndexStr = req.query.chunkIndex as string;

  if (!interviewId || !/^[a-zA-Z0-9_-]{1,128}$/.test(interviewId)) {
    return res.status(400).json({ error: "interviewId query parameter is required" });
  }
  if (!chunkIndexStr) {
    return res.status(400).json({ error: "chunkIndex query parameter is required" });
  }

  const chunkIndex = Number(chunkIndexStr);
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    return res.status(400).json({ error: "chunkIndex must be a valid integer" });
  }

  const chunkBuffer = req.body;
  const bufferLength = chunkBuffer ? chunkBuffer.length : 0;

  console.log(`[Server Chunk Upload] Received chunk ${chunkIndex} for interview ${interviewId}, size: ${bufferLength} bytes`);

  if (!chunkBuffer || bufferLength === 0) {
    return res.status(400).json({ error: "No chunk data received or buffer is empty" });
  }

  // Create temporary directory for chunks of this interview
  const tempDir = path.join(recordingsDir, `temp_progressive_${interviewId}`);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Initialize/retrieve progressive state
  let state = progressiveStates.get(interviewId);
  if (!state) {
    state = { nextExpectedIndex: 0, lastActivity: Date.now() };
    progressiveStates.set(interviewId, state);

    // Clean up any stale partial files from a previous crashed run of the same interview ID
    const completeFile = path.join(tempDir, "complete.webm");
    if (fs.existsSync(completeFile)) {
      try { fs.unlinkSync(completeFile); } catch (e) {}
    }
  }
  state.lastActivity = Date.now();

  // Write this chunk to disk
  const chunkFilePath = path.join(tempDir, `chunk_${chunkIndex}`);
  try {
    fs.writeFileSync(chunkFilePath, chunkBuffer);
    console.log(`[Server Chunk Upload] Saved chunk file: ${chunkFilePath}`);
  } catch (err: any) {
    console.error(`[Server Chunk Upload] Failed to write chunk ${chunkIndex} to disk:`, err);
    return res.status(500).json({ error: `Failed to write chunk to disk: ${err.message}` });
  }

  // Sequentially append any consecutive completed chunks that are ready
  const completeFilePath = path.join(tempDir, "complete.webm");
  try {
    while (true) {
      const nextChunkPath = path.join(tempDir, `chunk_${state.nextExpectedIndex}`);
      if (fs.existsSync(nextChunkPath)) {
        const buf = fs.readFileSync(nextChunkPath);
        fs.appendFileSync(completeFilePath, buf);
        console.log(`[Server Chunk Upload] Appended chunk_${state.nextExpectedIndex} to complete.webm`);
        
        state.nextExpectedIndex++;
        
        // Clean up individual chunk file after successfully appending to free up disk space
        try {
          fs.unlinkSync(nextChunkPath);
        } catch (unlinkErr) {
          console.warn(`[Server Chunk Upload] Failed to remove merged chunk file:`, unlinkErr);
        }
      } else {
        break;
      }
    }
  } catch (appendErr: any) {
    console.error(`[Server Chunk Upload] Progressive append failure:`, appendErr);
    return res.status(500).json({ error: `Progressive video assembly failed: ${appendErr.message}` });
  }

  return res.json({ success: true, chunkReceived: chunkIndex });
});

// Server-side Video Finalizer Helper Function (to be called by API or Safeguard check)
async function finalizeVideo(interviewId: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(interviewId)) throw new Error('Invalid interview ID.');
  if (reassemblingInterviews.has(interviewId)) {
    console.log(`[Server Finalize] Finalization or reassembly already in progress for interview ${interviewId}`);
    return "";
  }
  reassemblingInterviews.add(interviewId);

  const tempDir = path.join(recordingsDir, `temp_progressive_${interviewId}`);
  const completeFilePath = path.join(tempDir, "complete.webm");

  try {
    if (!fs.existsSync(completeFilePath)) {
      console.error(`[Server Finalize] No complete.webm found for interview ${interviewId} at ${completeFilePath}`);
      throw new Error("No recorded video segments found on server.");
    }

    const localFileName = `${interviewId}.webm`;
    const localFilePath = path.join(recordingsDir, localFileName);

    // Move progressive assembled webm to final place
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }
    fs.renameSync(completeFilePath, localFilePath);
    console.log(`[Server Finalize] Progressive assembled video moved to: ${localFilePath}`);

    // Clean up progressive state and temporary directories
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      progressiveStates.delete(interviewId);
      console.log(`[Server Finalize] Progressive state and directory cleaned up for interview: ${interviewId}`);
    } catch (cleanupErr) {
      console.warn(`[Server Finalize] Failed to clean up temp dir:`, cleanupErr);
    }

    // Transcode reassembled WebM file to MP4 (H.264/AAC) using ffmpeg
    const localMp4Name = `${interviewId}.mp4`;
    const localMp4Path = path.join(recordingsDir, localMp4Name);
    
    console.log(`[Server Finalize] Transcoding reassembled WebM to MP4: ${localFilePath} -> ${localMp4Path}`);
    
    let finalUploadFilePath = localFilePath;
    let finalMimeType = "video/webm";
    let finalFileName = `recordings/${interviewId}.webm`;
    let isTranscoded = false;

    try {
      const startTime = Date.now();
      const cmd = `ffmpeg -i "${localFilePath}" -vcodec libx264 -acodec aac -preset fast -y "${localMp4Path}"`;
      
      await execPromise(cmd);
      const durationMs = Date.now() - startTime;
      console.log(`[Server Finalize] ffmpeg conversion completed in ${durationMs}ms.`);

      // Log the resulting file size and duration on success
      const stats = fs.statSync(localMp4Path);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      
      // Get duration via ffprobe
      let durationSeconds = 0;
      try {
        const probeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${localMp4Path}"`;
        const { stdout: probeStdout } = await execPromise(probeCmd);
        durationSeconds = parseFloat(probeStdout.trim());
        console.log(`[Server Finalize] Converted MP4 metadata: Size = ${fileSizeMB} MB, Duration = ${durationSeconds} seconds.`);
      } catch (probeErr: any) {
        console.warn(`[Server Finalize] Failed to extract duration via ffprobe:`, probeErr?.message || probeErr);
      }

      finalUploadFilePath = localMp4Path;
      finalMimeType = "video/mp4";
      finalFileName = `recordings/${interviewId}.mp4`;
      isTranscoded = true;

    } catch (ffmpegErr: any) {
      console.error(`[Server Finalize] FFmpeg conversion failed. Raw error:`, ffmpegErr);
      if (ffmpegErr.stderr) {
        console.error(`[Server Finalize] FFmpeg stderr:`, ffmpegErr.stderr);
      }
      // Set status to failed in Firestore if transcoding fails
      try {
        const docRef = doc(db, "interviews", interviewId);
        await updateDoc(docRef, {
          recordingStatus: "failed"
        });
      } catch (dbErr) {
        console.error(`[Server Finalize] Failed to set status to failed in Firestore:`, dbErr);
      }
      throw new Error(`FFmpeg transcoding failed: ${ffmpegErr.message || ffmpegErr}`);
    }

    // Upload complete reassembled/transcoded file to Google Drive Shared Drive
    console.log(`[Server Finalize] Starting Google Drive upload for interview: ${interviewId}`);
    let recordingUrl = "";
    try {
      const { drive, folderId } = await getDriveConnection();

      // 1. Create file in Google Drive Shared Folder with retry logic
      console.log(`[Server Finalize] Uploading file to Google Drive Shared Folder ID: ${folderId}`);
      const fileMetadata = {
        name: finalFileName,
        parents: [folderId],
      };

      let fileId: string | undefined;
      const maxDriveRetries = 3;
      let driveAttempt = 0;

      while (driveAttempt <= maxDriveRetries) {
        try {
          console.log(`[Server Finalize] Drive files.create (Attempt ${driveAttempt + 1}/${maxDriveRetries + 1})...`);
          const media = {
            mimeType: finalMimeType,
            body: fs.createReadStream(finalUploadFilePath),
          };
          const createResponse = await drive.files.create({
            supportsAllDrives: true, // Crucial for Shared Drives!
            requestBody: fileMetadata,
            media: media,
            fields: "id",
          });

          fileId = createResponse.data.id ?? undefined;
          if (!fileId) {
            throw new Error("Failed to get file ID from Drive files.create response");
          }

          if (driveAttempt > 0) {
            console.log(`[Server Finalize] Google Drive file creation succeeded on retry attempt ${driveAttempt}! File ID: ${fileId}`);
          } else {
            console.log(`[Server Finalize] Successfully created file on Drive. File ID: ${fileId}`);
          }
          break; // Success
        } catch (err: any) {
          const isTransient = isTransientDriveError(err);
          console.error(`[Server Finalize] Drive files.create Attempt ${driveAttempt + 1} failed (Transient? ${isTransient}). Error:`, err.message || err);

          if (isTransient && driveAttempt < maxDriveRetries) {
            driveAttempt++;
            const backoffMs = Math.pow(2, driveAttempt) * 1000; // 2s, 4s, 8s
            console.log(`[Server Finalize] Retrying Drive files.create in ${backoffMs}ms...`);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          } else {
            console.error(`[Server Finalize] Drive files.create permanently failed or retries exhausted.`);
            throw err;
          }
        }
      }

      // Files inherit access from the connected account and its InterviewAI folder.
      recordingUrl = `https://drive.google.com/file/d/${fileId}/preview`;
      console.log(`[Server Finalize] Generated Drive preview URL: ${recordingUrl}`);

      // Clean up local files (both original webm and converted mp4)
      try {
        if (fs.existsSync(localFilePath)) {
          fs.unlinkSync(localFilePath);
          console.log(`[Server Finalize] Cleaned up local WebM file: ${localFilePath}`);
        }
        if (isTranscoded && fs.existsSync(localMp4Path)) {
          fs.unlinkSync(localMp4Path);
          console.log(`[Server Finalize] Cleaned up local transcoded MP4 file: ${localMp4Path}`);
        }
      } catch (cleanupErr) {
        console.warn(`[Server Finalize] Failed to clean up local files:`, cleanupErr);
      }

      // Update Firestore document with recordingUrl and recordingStatus 'ready'
      console.log(`[Server Finalize] Updating Firestore document interviews/${interviewId} with recordingUrl: ${recordingUrl}, recordingStatus: ready`);
      const docRef = doc(db, "interviews", interviewId);
      await updateDoc(docRef, {
        recordingUrl: recordingUrl,
        recordingStatus: "ready"
      });
      console.log(`[Server Finalize] Firestore document successfully updated to ready!`);

      return recordingUrl;

    } catch (driveErr: any) {
      console.error(`[Server Finalize] Error uploading recording to Google Drive:`, driveErr);
      if (driveErr.response) {
        console.error(`[Server Finalize] Google API Error Response Data:`, JSON.stringify(driveErr.response.data || driveErr.response));
      }

      const status = driveErr.status || driveErr.statusCode || driveErr.response?.status;
      if (status === 403) {
        console.warn(`[Server Finalize] Google Drive API returned 403 PERMISSION_DENIED (API disabled or permissions missing). Handled safely.`);
      }

      // Clean up local files (both original webm and converted mp4)
      try {
        if (fs.existsSync(localFilePath)) {
          fs.unlinkSync(localFilePath);
          console.log(`[Server Finalize] Cleaned up local WebM file: ${localFilePath}`);
        }
        if (isTranscoded && fs.existsSync(localMp4Path)) {
          fs.unlinkSync(localMp4Path);
          console.log(`[Server Finalize] Cleaned up local transcoded MP4 file: ${localMp4Path}`);
        }
      } catch (cleanupErr) {
        console.warn(`[Server Finalize] Failed to clean up local files:`, cleanupErr);
      }

      // Update Firestore to let the admin know the recording failed
      try {
        console.log(`[Server Finalize] Updating Firestore document interviews/${interviewId} with recordingStatus: failed`);
        const docRef = doc(db, "interviews", interviewId);
        await updateDoc(docRef, {
          recordingStatus: "failed"
        });
      } catch (dbErr) {
        console.error(`[Server Finalize] Failed to set status to failed in Firestore:`, dbErr);
      }

      // Return empty string safely instead of crashing or throwing
      return "";
    }
  } finally {
    reassemblingInterviews.delete(interviewId);
  }
}

const processingInterviews = new Set<string>();
app.post('/api/finish-interview', async (req, res) => {
  const { interviewId, hasRecording, totalChunks, transcript } = req.body;
  if (typeof interviewId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(interviewId) ||
      !Number.isInteger(totalChunks) || totalChunks < 0 || typeof hasRecording !== 'boolean' ||
      !Array.isArray(transcript) || transcript.length > 1000 || transcript.some((entry: any) =>
        !entry || !['AI', 'Candidate'].includes(entry.sender) || typeof entry.text !== 'string' || !Number.isFinite(entry.timestamp))) {
    return res.status(400).json({ error: 'Invalid interview completion data.' });
  }
  try {
    const ref = doc(db, 'interviews', interviewId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) return res.status(404).json({ error: 'Interview not found.' });
    if (processingInterviews.has(interviewId) || snapshot.data().status === 'completed') return res.json({ success: true });
    if (!['in_progress', 'processing'].includes(snapshot.data().status)) return res.status(409).json({ error: 'This interview has not started.' });
    processingInterviews.add(interviewId);
    const recordingComplete = hasRecording && totalChunks > 0 && progressiveStates.get(interviewId)?.nextExpectedIndex === totalChunks;
    await updateDoc(ref, { transcript, status: 'processing', recordingStatus: recordingComplete ? 'uploading' : 'failed' });
    // Everything needed is now on the server; closing the candidate's tab is safe.
    res.status(202).json({ success: true });
    const record = async () => {
      if (!recordingComplete) return;
      try { await finalizeVideo(interviewId); }
      catch (error) {
        console.error('[Recording finalization]', error);
        await updateDoc(ref, { recordingStatus: 'failed' });
      }
    };
    const assess = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await assessInterview(interviewId); return; }
        catch (error) {
          console.error('[Assessment attempt]', attempt + 1, error);
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt));
        }
      }
      await updateDoc(ref, { status: 'completed', assessmentStatus: 'failed' });
    };
    Promise.allSettled([record(), assess()]).finally(() => processingInterviews.delete(interviewId));
  } catch (error: any) {
    processingInterviews.delete(interviewId);
    if (!res.headersSent) res.status(500).json({ error: error.message || 'Could not save the interview.' });
  }
});

// Server-side Finalize Video Endpoint
app.post("/api/finalize-video", express.json(), async (req, res) => {
  res.type("json");
  const { interviewId } = req.body;
  if (!interviewId) {
    return res.status(400).type("json").json({ error: "interviewId is required" });
  }

  console.log(`[Server Finalize] Finalize request received for interview ${interviewId}`);
  try {
    const url = await finalizeVideo(interviewId);
    return res.status(200).type("json").json({ success: true, url: url || null });
  } catch (err: any) {
    console.error(`[Server Finalize] Finalize video error handled safely:`, err);
    return res.status(200).type("json").json({
      success: true,
      url: null,
      warning: `Video finalization completed with upload error: ${err.message || err}`,
    });
  }
});

// Safeguard check every 15 seconds for abandoned or ended sessions
setInterval(async () => {
  const now = Date.now();
  
  // Check in-memory maps
  for (const [interviewId, state] of progressiveStates.entries()) {
    // 1. Check for abandoned or crashed sessions (inactive for 45 minutes)
    if (now - state.lastActivity > 45 * 60 * 1000) {
      console.warn(`[Safeguard] In-memory session ${interviewId} inactive for over 45 minutes. Forcing fail and cleaning up.`);
      progressiveStates.delete(interviewId);

      try {
        const docRef = doc(db, "interviews", interviewId);
        await updateDoc(docRef, {
          recordingStatus: "failed"
        });
        console.log(`[Safeguard] Updated Firestore interviews/${interviewId} recordingStatus to 'failed'`);
      } catch (err) {
        console.error(`[Safeguard] Failed to update Firestore for in-memory session ${interviewId}:`, err);
      }

      const tempDir = path.join(recordingsDir, `temp_progressive_${interviewId}`);
      if (fs.existsSync(tempDir)) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
          console.log(`[Safeguard] Deleted inactive session temp folder: ${tempDir}`);
        } catch (err) {
          console.error(`[Safeguard] Failed to delete temp folder ${tempDir}:`, err);
        }
      }
      continue;
    }

    // 2. Autocomplete check for ended sessions whose chunk uploads stopped for over 45 seconds
    if (now - state.lastActivity > 45 * 1000) {
      try {
        const docRef = doc(db, "interviews", interviewId);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data();
          const interviewEnded = data.status === "completed" || data.status === "processing" || data.status === "failed";
          const needsFinalize = data.recordingStatus === "uploading";
          if (interviewEnded && needsFinalize) {
            console.log(`[Safeguard Autocomplete] Interview ${interviewId} has ended in Firestore, and chunks stopped arriving for 45s. Automatically finalising now.`);
            try {
              await finalizeVideo(interviewId);
              console.log(`[Safeguard Autocomplete] Autocomplete video finalize succeeded for interview ${interviewId}`);
            } catch (err: any) {
              console.error(`[Safeguard Autocomplete] Failed to autocomplete video finalize for ${interviewId}:`, err);
            }
          }
        }
      } catch (dbErr) {
        console.error(`[Safeguard Autocomplete] Error checking Firestore for ended in-memory session ${interviewId}:`, dbErr);
      }
    }
  }

  // Scan recordings physical directory for lingering folders
  try {
    const files = fs.readdirSync(recordingsDir);
    for (const file of files) {
      if (file.startsWith("temp_progressive_")) {
        const folderPath = path.join(recordingsDir, file);
        const stats = fs.statSync(folderPath);
        const ageMs = now - stats.mtimeMs;

        if (ageMs > 45 * 1000) {
          const interviewId = file.replace("temp_progressive_", "");
          
          // Skip if already checked via in-memory map
          if (progressiveStates.has(interviewId)) {
            continue;
          }

          try {
            const docRef = doc(db, "interviews", interviewId);
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
              const data = docSnap.data();
              const interviewEnded = data.status === "completed" || data.status === "processing" || data.status === "failed";
              const needsFinalize = data.recordingStatus === "uploading";
              if (interviewEnded && needsFinalize) {
                console.log(`[Safeguard Autocomplete] Lingering physical folder ${file} found. Interview has ended but status is still 'uploading'. Finalizing.`);
                try {
                  await finalizeVideo(interviewId);
                } catch (err) {
                  console.error(`[Safeguard Autocomplete] Failed to finalize lingering physical folder ${file}:`, err);
                }
              } else if (ageMs > 45 * 60 * 1000) {
                // If it's more than 45 minutes old, clean it up as abandoned
                console.warn(`[Safeguard] Cleaning up physically abandoned temp folder ${file} (over 45 minutes old)`);
                try {
                  fs.rmSync(folderPath, { recursive: true, force: true });
                } catch (err) {
                  console.error(`[Safeguard] Failed to remove physically abandoned temp folder ${file}:`, err);
                }
              }
            } else {
              // No Firestore doc. If folder is old (over 45 minutes), let's clean it up
              if (ageMs > 45 * 60 * 1000) {
                console.warn(`[Safeguard] Lingering physical folder ${file} has no Firestore doc and is over 45 minutes old. Deleting.`);
                try {
                  fs.rmSync(folderPath, { recursive: true, force: true });
                } catch (err) {
                  console.error(`[Safeguard] Failed to delete folder ${folderPath}:`, err);
                }
              }
            }
          } catch (dbErr) {
            console.error(`[Safeguard] Error checking Firestore for lingering folder ${file}:`, dbErr);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[Safeguard] Error scanning physical recordingsDir:`, err);
  }
}, 15 * 1000);

// WebSocket proxy logic
wss.on("connection", async (ws, request) => {
  ws.pause();
  try {
    const id = new URL(request.url || "", "http://localhost").searchParams.get("interviewId");
    if (!id) throw new Error("Interview ID is required");
    const interview = await assertInterviewCanStart(id);
    if (interview.status !== "in_progress") throw new Error("Start the interview from the waiting room first.");
    if (ws.readyState !== WebSocket.OPEN) return;
  } catch (error: any) {
    ws.resume();
    safeClose(ws, 1008, "Interview is not available. Return to the waiting room.");
    return;
  }
  const sessionId = Math.random().toString(36).substring(2, 10).toUpperCase();
  console.log(`[Proxy Server] [Session ${sessionId}] Client connected to Live proxy WebSocket successfully!`);

  if (!apiKey) {
    ws.resume();
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
  ws.resume();
});

// Explicit 404 handler for unmatched /api routes so they NEVER fall through to HTML / Vite SPA fallback
app.all("/api/*", (req, res) => {
  res.status(404).type("json").json({
    error: `API route not found: ${req.method} ${req.originalUrl}`,
  });
});

// Explicit API error handling middleware to guarantee JSON response on errors
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.path.startsWith("/api") || req.originalUrl.startsWith("/api")) {
    console.error("[API Error Handler]", err);
    return res.status(err.status || 500).type("json").json({
      error: err.message || "Internal Server Error",
      details: process.env.NODE_ENV !== "production" ? err.stack : undefined,
    });
  }
  next(err);
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
