import express from "express";
import path from "path";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";
import { doc, getDoc, updateDoc, deleteDoc, collection, addDoc } from "firebase/firestore";
import { db } from "./src/firebase.js";
import { google } from "googleapis";
import { exec } from "child_process";
import { promisify } from "util";
import multer from "multer";
import { Readable } from "stream";
import { createRequire } from "module";

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

// AI Assessment Endpoint
app.post("/api/assess", async (req, res) => {
  const { interviewId } = req.body;
  if (!interviewId) {
    return res.status(400).json({ error: "interviewId is required" });
  }

  const aiClient = getGeminiClient();
  if (!aiClient) {
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
    const response = await aiClient.models.generateContent({
      model: "gemini-3.5-flash",
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
    if (error instanceof Error) {
      console.error("Error Name:", error.name);
      console.error("Error Message:", error.message);
      console.error("Error Stack:", error.stack);
    }
    res.status(500).json({
      error: error.message || "Failed to complete AI assessment",
      details: error.stack || String(error)
    });
  }
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
  if (typeof pdfParser !== 'function' && (pdfParser as any).default) {
    pdfParser = (pdfParser as any).default;
  }

  let mammothExtractor = mammoth;
  if (!mammothExtractor.extractRawText && (mammothExtractor as any).default) {
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
        const result = await parserInstance.getText();
        text = result.text;
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
async function uploadCvToDrive(interviewId: string, fileBuffer: Buffer, fileName: string, mimeType: string): Promise<string> {
  const serviceAccountKeyRaw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY;
  const folderId = process.env.DRIVE_RECORDINGS_FOLDER_ID;

  if (!serviceAccountKeyRaw) {
    throw new Error("GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY environment variable is not defined");
  }
  if (!folderId) {
    throw new Error("DRIVE_RECORDINGS_FOLDER_ID environment variable is not defined");
  }

  const credentials = JSON.parse(serviceAccountKeyRaw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  const drive = google.drive({ version: "v3", auth });

  const fileMetadata = {
    name: `cvs/${fileName}`,
    parents: [folderId],
  };

  const media = {
    mimeType: mimeType,
    body: Readable.from(fileBuffer),
  };

  console.log(`[Server CV Upload] Uploading CV file to Google Drive Shared Folder ID: ${folderId}, filename: cvs/${fileName}`);
  const createResponse = await drive.files.create({
    supportsAllDrives: true,
    requestBody: fileMetadata,
    media: media,
    fields: "id",
  });

  const fileId = createResponse.data.id;
  if (!fileId) {
    throw new Error("Failed to get file ID from Drive files.create response for CV");
  }

  console.log(`[Server CV Upload] Successfully uploaded CV to Drive. File ID: ${fileId}`);

  // Set domain-level permissions (same as recordings)
  console.log(`[Server CV Upload] Setting domain-level 'reader' permissions for workpodd.com on CV file: ${fileId}`);
  await drive.permissions.create({
    fileId: fileId,
    supportsAllDrives: true,
    requestBody: {
      role: "reader",
      type: "domain",
      domain: "workpodd.com",
    },
  });

  const cvFileUrl = `https://drive.google.com/file/d/${fileId}/preview`;
  console.log(`[Server CV Upload] Generated CV Drive preview URL: ${cvFileUrl}`);
  return cvFileUrl;
}

// POST /api/interviews - Create new interview with optional CV upload
app.post("/api/interviews", upload.single("cv"), async (req, res) => {
  console.log("[Server Create Interview] Received request body:", req.body);
  const { applicantName, jobTitle, jobDescription, interviewType, duration } = req.body;

  if (!applicantName || !jobTitle || !jobDescription || !interviewType || !duration) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // 1. Create document in Firestore first to get the interview ID
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

    let cvText: string | null = null;
    let cvFileUrl: string | null = null;

    // 2. Process file if uploaded
    if (req.file) {
      const file = req.file;
      console.log(`[Server Create Interview] CV File uploaded: ${file.originalname} (${file.size} bytes)`);

      // 2a. Text Extraction
      try {
        const extracted = await extractTextFromBuffer(file.buffer, file.originalname, file.mimetype);
        if (extracted && extracted.trim()) {
          cvText = extracted.trim();
          console.log(`[Server Create Interview] Successfully extracted CV text. Length: ${cvText.length} chars.`);
        } else {
          console.warn(`[Server Create Interview] Text extraction returned empty/null for: ${file.originalname}`);
        }
      } catch (extractErr: any) {
        console.error(`[Server Create Interview] Text extraction failed with raw error:`, extractErr);
      }

      // 2b. File Storage to Google Drive
      try {
        const fileExtension = path.extname(file.originalname).toLowerCase() || (file.mimetype === "application/pdf" ? ".pdf" : ".docx");
        const driveFileName = `${interviewId}${fileExtension}`;
        cvFileUrl = await uploadCvToDrive(interviewId, file.buffer, driveFileName, file.mimetype);
        console.log(`[Server Create Interview] CV uploaded to Google Drive. URL: ${cvFileUrl}`);
      } catch (driveErr: any) {
        console.error(`[Server Create Interview] Google Drive upload failed with raw error:`, driveErr);
      }

      // 2c. Update Firestore with cvText and cvFileUrl
      if (cvText !== null || cvFileUrl !== null) {
        console.log(`[Server Create Interview] Updating Firestore interviews/${interviewId} with cvText/cvFileUrl...`);
        await updateDoc(docRef, {
          cvText,
          cvFileUrl,
        });
        console.log(`[Server Create Interview] Firestore updated successfully with CV details.`);
      }
    } else {
      console.log("[Server Create Interview] No CV file uploaded for this interview.");
    }

    return res.json({
      success: true,
      interviewId,
      cvTextLength: cvText ? cvText.length : 0,
      cvFileUrl,
    });

  } catch (err: any) {
    console.error("[Server Create Interview] CRITICAL ERROR during creation:", err);
    return res.status(500).json({
      error: `Failed to create interview: ${err.message || err}`,
      details: err.stack || String(err),
    });
  }
});

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
        const serviceAccountKeyRaw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY;
        if (!serviceAccountKeyRaw) {
          throw new Error("GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY is missing from environment variables");
        }

        const credentials = JSON.parse(serviceAccountKeyRaw);
        const auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ["https://www.googleapis.com/auth/drive"],
        });

        const drive = google.drive({ version: "v3", auth });
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

  // Transcode reassembled WebM file to MP4 (H.264/AAC) using ffmpeg
  const localMp4Name = `${interviewId}.mp4`;
  const localMp4Path = path.join(recordingsDir, localMp4Name);
  
  console.log(`[Server Chunk Upload] Transcoding reassembled WebM to MP4: ${localFilePath} -> ${localMp4Path}`);
  
  let finalUploadFilePath = localFilePath;
  let finalMimeType = "video/webm";
  let finalFileName = `recordings/${interviewId}.webm`;
  let isTranscoded = false;

  try {
    const startTime = Date.now();
    const cmd = `ffmpeg -i "${localFilePath}" -vcodec libx264 -acodec aac -preset fast -y "${localMp4Path}"`;
    
    await execPromise(cmd);
    const durationMs = Date.now() - startTime;
    console.log(`[Server Chunk Upload] ffmpeg conversion completed in ${durationMs}ms.`);

    // Log the resulting file size and duration on success
    const stats = fs.statSync(localMp4Path);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    // Get duration via ffprobe
    let durationSeconds = 0;
    try {
      const probeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${localMp4Path}"`;
      const { stdout: probeStdout } = await execPromise(probeCmd);
      durationSeconds = parseFloat(probeStdout.trim());
      console.log(`[Server Chunk Upload] Converted MP4 metadata: Size = ${fileSizeMB} MB, Duration = ${durationSeconds} seconds.`);
    } catch (probeErr: any) {
      console.warn(`[Server Chunk Upload] Failed to extract duration via ffprobe:`, probeErr?.message || probeErr);
    }

    finalUploadFilePath = localMp4Path;
    finalMimeType = "video/mp4";
    finalFileName = `recordings/${interviewId}.mp4`;
    isTranscoded = true;

  } catch (ffmpegErr: any) {
    console.error(`[Server Chunk Upload] FFmpeg conversion failed. Raw error:`, ffmpegErr);
    if (ffmpegErr.stderr) {
      console.error(`[Server Chunk Upload] FFmpeg stderr:`, ffmpegErr.stderr);
    }
    // Set status to failed in Firestore if reassembly or transcoding fails
    try {
      const docRef = doc(db, "interviews", interviewId);
      await updateDoc(docRef, {
        recordingStatus: "failed"
      });
    } catch (dbErr) {
      console.error(`[Server Chunk Upload] Failed to set status to failed in Firestore:`, dbErr);
    }
    reassemblingInterviews.delete(interviewId);
    return res.status(500).json({ error: `FFmpeg transcoding failed: ${ffmpegErr.message || ffmpegErr}` });
  }

  // Upload complete reassembled/transcoded file to Google Drive Shared Drive
  console.log(`[Server Chunk Upload] Starting Google Drive upload for interview: ${interviewId}`);
  let recordingUrl = "";
  try {
    const serviceAccountKeyRaw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY;
    const folderId = process.env.DRIVE_RECORDINGS_FOLDER_ID;

    if (!serviceAccountKeyRaw) {
      throw new Error("GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY environment variable is not defined");
    }
    if (!folderId) {
      throw new Error("DRIVE_RECORDINGS_FOLDER_ID environment variable is not defined");
    }

    const credentials = JSON.parse(serviceAccountKeyRaw);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });

    const drive = google.drive({ version: "v3", auth });

    // 1. Create file in Google Drive Shared Folder
    console.log(`[Server Chunk Upload] Uploading file to Google Drive Shared Folder ID: ${folderId}`);
    const fileMetadata = {
      name: finalFileName,
      parents: [folderId],
    };

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

    const fileId = createResponse.data.id;
    if (!fileId) {
      throw new Error("Failed to get file ID from Drive files.create response");
    }

    console.log(`[Server Chunk Upload] Successfully created file on Drive. File ID: ${fileId}`);

    // 2. Set domain-level permissions
    console.log(`[Server Chunk Upload] Setting domain-level 'reader' permissions for workpodd.com on file: ${fileId}`);
    await drive.permissions.create({
      fileId: fileId,
      supportsAllDrives: true,
      requestBody: {
        role: "reader",
        type: "domain",
        domain: "workpodd.com",
      },
    });
    console.log(`[Server Chunk Upload] Successfully configured permissions for workpodd.com`);

    recordingUrl = `https://drive.google.com/file/d/${fileId}/preview`;
    console.log(`[Server Chunk Upload] Generated Drive preview URL: ${recordingUrl}`);

    // Clean up local files (both original webm and converted mp4)
    try {
      if (fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
        console.log(`[Server Chunk Upload] Cleaned up local reassembled WebM file: ${localFilePath}`);
      }
      if (isTranscoded && fs.existsSync(localMp4Path)) {
        fs.unlinkSync(localMp4Path);
        console.log(`[Server Chunk Upload] Cleaned up local transcoded MP4 file: ${localMp4Path}`);
      }
    } catch (cleanupErr) {
      console.warn(`[Server Chunk Upload] Failed to clean up local files:`, cleanupErr);
    }

    // Update Firestore document with recordingUrl and recordingStatus 'ready'
    console.log(`[Server Chunk Upload] Updating Firestore document interviews/${interviewId} with recordingUrl: ${recordingUrl}, recordingStatus: ready`);
    const docRef = doc(db, "interviews", interviewId);
    await updateDoc(docRef, {
      recordingUrl: recordingUrl,
      recordingStatus: "ready"
    });
    console.log(`[Server Chunk Upload] Firestore document successfully updated to ready!`);

    // Clean up reassembling guard
    reassemblingInterviews.delete(interviewId);

    return res.json({ success: true, url: recordingUrl });

  } catch (driveErr: any) {
    // Clean up reassembling guard
    reassemblingInterviews.delete(interviewId);

    console.error(`[Server Chunk Upload] CRITICAL ERROR uploading to Google Drive:`, driveErr);
    if (driveErr.response) {
      console.error(`[Server Chunk Upload] Google API Error Response Data:`, JSON.stringify(driveErr.response.data || driveErr.response));
    }

    // Update Firestore to let the admin know the recording failed
    try {
      console.log(`[Server Chunk Upload] Updating Firestore document interviews/${interviewId} with recordingStatus: failed`);
      const docRef = doc(db, "interviews", interviewId);
      await updateDoc(docRef, {
        recordingStatus: "failed"
      });
    } catch (dbErr) {
      console.error(`[Server Chunk Upload] Failed to set status to failed in Firestore:`, dbErr);
    }

    return res.status(500).json({
      error: `Google Drive upload failed: ${driveErr.message || driveErr}`,
      details: driveErr.stack || String(driveErr),
      rawError: driveErr.response?.data || driveErr
    });
  }
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
