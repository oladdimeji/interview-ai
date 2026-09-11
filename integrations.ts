import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { google } from 'googleapis';
import { Router } from 'express';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './src/firebase.js';

// Small, server-only store for the no-login test workspace. Never serve this
// directory through Vite/static hosting or include it in an exported project.
type Invitation = {
  email: string; duration: number; interviewType: string; eventTypeId: number;
  bookingUrl: string; jobs: { title: string; description: string }[];
  createdAt: string; bookingUid?: string; lastCheckedAt?: number;
};
type State = {
  drive?: { refreshToken: string; folderId: string; email: string };
  invitations: Record<string, Invitation>;
};
const dataDir = () => path.resolve(process.env.INTERVIEWAI_DATA_DIR || '.local');
const statePath = () => path.join(dataDir(), 'integrations.json');
let state: State | undefined;
function readState(): State {
  if (!state) state = fs.existsSync(statePath())
    ? JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    : { invitations: {} };
  return state!;
}
function saveState() {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(`${statePath()}.tmp`, JSON.stringify(readState()), { mode: 0o600 });
  fs.renameSync(`${statePath()}.tmp`, statePath());
}
function publicOrigin() {
  const value = process.env.APP_URL;
  if (!value) throw new Error('The app URL has not been configured yet.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid app URL.');
  return url.origin;
}
function oauthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google Drive connection has not been configured yet.');
  }
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${publicOrigin()}/api/google/callback`);
}

export async function getDriveConnection() {
  const connection = readState().drive;
  if (connection) {
    const auth = oauthClient();
    auth.setCredentials({ refresh_token: connection.refreshToken });
    return { drive: google.drive({ version: 'v3', auth }), folderId: connection.folderId, legacy: false };
  }
  // Existing manually-created interviews can continue using their original setup.
  const key = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY;
  const folderId = process.env.DRIVE_RECORDINGS_FOLDER_ID;
  if (key && folderId) {
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(key), scopes: ['https://www.googleapis.com/auth/drive'] });
    return { drive: google.drive({ version: 'v3', auth }), folderId, legacy: true };
  }
  throw new Error('Connect Google Drive before creating interviews.');
}

async function calRequest(endpoint: string, method = 'GET', body?: unknown) {
  if (!process.env.CAL_API_KEY) throw new Error('Cal.com has not been connected yet.');
  const response = await fetch(`https://api.cal.com/v2/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.CAL_API_KEY}`,
      'Content-Type': 'application/json',
      'cal-api-version': endpoint.startsWith('bookings') ? '2026-05-01' : '2026-06-12',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok || result.status === 'error') throw new Error(result.error?.message || result.message || `Cal.com request failed (${response.status}).`);
  return result.data;
}

async function sendInvitation(email: string, subject: string, body: string, token: string) {
  if (!process.env.BREVO_API_KEY || !process.env.EMAIL_FROM) throw new Error('The InterviewAI email sender has not been configured yet.');
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: parseEmailFrom(process.env.EMAIL_FROM), to: [{ email }], subject, textContent: body, tags: [token] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.message || 'Could not send the invitation email.');
  }
}

// EMAIL_FROM is stored as "Name <email@domain>" (matching the old Resend format);
// Brevo's API wants the name and address as separate fields.
function parseEmailFrom(value: string) {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return match ? { name: match[1] || undefined, email: match[2] } : { email: value.trim() };
}

async function currentJobs() {
  const snapshot = await getDocs(collection(db, 'jobs'));
  return snapshot.docs.map(item => ({ title: String(item.data().title), description: String(item.data().description) }));
}
function bookingFields(jobs: Invitation['jobs'], email: string) {
  return [
    { field: 'name', variant: 'fullName' },
    { field: 'email', disableOnPrefill: true, requireEmails: [email] },
    { field: 'custom', type: 'select', slug: 'job-title', label: 'Job title', required: true, options: [...new Set(jobs.map(job => job.title))] },
  ];
}

const syncs = new Map<string, Promise<void>>();
export async function syncScheduledInterview(token: string, force = false): Promise<void> {
  const invite = readState().invitations[token];
  if (!invite) throw new Error('This interview invitation was not found.');
  if (syncs.has(token)) return syncs.get(token)!;
  if (!force && invite.lastCheckedAt && Date.now() - invite.lastCheckedAt < 10000) return;
  const task = (async () => {
    const ref = doc(db, 'interviews', token);
    const existing = await getDoc(ref);
    // Preserve active and completed interviews, even if the calendar later changes.
    if (existing.exists() && existing.data().status !== 'pending') return;
    const bookings = await calRequest(`bookings?eventTypeId=${invite.eventTypeId}&take=100`);
    const matching = (bookings as any[]).filter(booking =>
      (booking.eventType?.id || booking.eventTypeId) === invite.eventTypeId &&
      booking.attendees?.some((attendee: any) => attendee.email?.toLowerCase() === invite.email));
    const accepted = matching.filter(booking => booking.status === 'accepted');
    if (accepted.length > 1) throw new Error('More than one booking exists for this invitation. Please contact the recruiter.');
    const booking = accepted[0];
    if (!booking) {
      if (existing.exists()) await updateDoc(ref, { bookingStatus: 'cancelled' });
      invite.lastCheckedAt = Date.now();
      return;
    }
    const title = booking.bookingFieldsResponses?.['job-title'];
    const job = invite.jobs.find(item => item.title === title);
    const candidate = booking.attendees.find((attendee: any) => attendee.email?.toLowerCase() === invite.email);
    const scheduledAt = Date.parse(booking.start);
    if (!job || !candidate?.name || !Number.isFinite(scheduledAt)) throw new Error('The booking is missing the candidate name, job, or scheduled time.');
    if (booking.duration !== invite.duration) throw new Error('The booking duration does not match the invitation. Please contact the recruiter.');
    if (!existing.exists()) {
      await setDoc(ref, {
        applicantName: candidate.name, jobTitle: job.title, jobDescription: job.description,
        interviewType: invite.interviewType, duration: invite.duration,
        status: 'pending', createdAt: new Date().toISOString(), transcript: [],
        scheduledAt, bookingStatus: 'confirmed', cvRequired: true, cvStatus: 'pending', cvText: null, cvFileUrl: null,
      });
    } else {
      await updateDoc(ref, { scheduledAt, bookingStatus: 'confirmed' });
    }
    invite.bookingUid = booking.uid;
    invite.lastCheckedAt = Date.now();
    saveState();
  })();
  syncs.set(token, task);
  try { await task; } finally { syncs.delete(token); }
}

export async function assertInterviewCanStart(id: string) {
  if (id.startsWith('inv_')) await syncScheduledInterview(id, true);
  const snapshot = await getDoc(doc(db, 'interviews', id));
  if (!snapshot.exists()) throw new Error('Interview not found.');
  const interview = snapshot.data();
  if (!['pending', 'in_progress'].includes(interview.status)) throw new Error('This interview has already finished.');
  if (interview.bookingStatus === 'cancelled') throw new Error('This booking has been cancelled.');
  if (interview.scheduledAt && Date.now() < interview.scheduledAt) throw new Error('Your interview is not open yet. Please return at the scheduled time.');
  if (interview.cvRequired && (interview.cvStatus !== 'ready' || !interview.cvText?.trim())) throw new Error('Upload a readable CV before starting your interview.');
  return interview;
}

export const integrationsRouter = Router();
const pendingOAuth = new Map<string, number>();

integrationsRouter.get('/integrations', (_req, res) => {
  const drive = readState().drive;
  res.json({ companyName: 'WorkPodd', driveConnected: !!drive, driveEmail: drive?.email || null,
    driveConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.APP_URL),
    invitationsConfigured: !!(process.env.CAL_API_KEY && process.env.CAL_USERNAME && process.env.BREVO_API_KEY && process.env.EMAIL_FROM && process.env.APP_URL),
  });
});
integrationsRouter.get('/google/connect', (_req, res) => {
  try {
    const auth = oauthClient();
    const nonce = randomBytes(24).toString('hex');
    for (const [key, expiry] of pendingOAuth) if (expiry < Date.now()) pendingOAuth.delete(key);
    pendingOAuth.set(nonce, Date.now() + 10 * 60 * 1000);
    res.cookie('drive_oauth_state', nonce, { httpOnly: true, sameSite: 'lax', secure: publicOrigin().startsWith('https:'), path: '/api/google', maxAge: 600000 });
    res.redirect(auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/drive.file'], state: nonce }));
  } catch (error: any) { res.status(503).send(error.message); }
});
integrationsRouter.get('/google/callback', async (req, res) => {
  try {
    const nonce = String(req.query.state || '');
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('drive_oauth_state='))?.slice('drive_oauth_state='.length);
    if (!nonce || cookie !== nonce || (pendingOAuth.get(nonce) || 0) < Date.now()) throw new Error('The connection request expired. Please try again.');
    pendingOAuth.delete(nonce);
    res.clearCookie('drive_oauth_state', { path: '/api/google' });
    if (req.query.error || !req.query.code) throw new Error('Google Drive access was not granted.');
    const auth = oauthClient();
    const { tokens } = await auth.getToken(String(req.query.code));
    if (!tokens.refresh_token) throw new Error('Google did not grant ongoing access. Please reconnect.');
    auth.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const folders = await drive.files.list({ q: "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='interviewai' and value='recordings' }", fields: 'files(id)' });
    let folderId = folders.data.files?.[0]?.id;
    if (!folderId) {
      const folder = await drive.files.create({ requestBody: { name: 'InterviewAI', mimeType: 'application/vnd.google-apps.folder', appProperties: { interviewai: 'recordings' } }, fields: 'id' });
      folderId = folder.data.id;
    }
    if (!folderId) throw new Error('Could not create the InterviewAI folder.');
    const about = await drive.about.get({ fields: 'user(emailAddress)' });
    readState().drive = { refreshToken: tokens.refresh_token, folderId, email: about.data.user?.emailAddress || 'Connected Google account' };
    saveState();
    res.redirect(`${publicOrigin()}/?drive=connected`);
  } catch (error: any) {
    res.status(400).type('text').send(`${error.message} Return to InterviewAI and try connecting again.`);
  }
});

integrationsRouter.post('/invitations', async (req, res) => {
  try {
    const { recipients, subject, body, interviewType, duration } = req.body;
    if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > 20 || recipients.some(email => typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Enter between 1 and 20 valid email addresses.');
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 200 || /[\r\n]/.test(subject)) throw new Error('Enter a valid subject (up to 200 characters).');
    if (typeof body !== 'string' || !body.includes('{{booking_link}}') || body.length > 10000) throw new Error('Keep {{booking_link}} in the invitation so candidates can schedule.');
    if (!['Technical', 'Behavioral', 'Screening'].includes(interviewType) || !Number.isInteger(duration) || duration < 1 || duration > 60) throw new Error('Choose a valid interview type and duration (1–60 minutes).');
    if (!process.env.BREVO_API_KEY || !process.env.EMAIL_FROM || !process.env.CAL_USERNAME) throw new Error('The shared calendar and email sender need to be configured before sending.');
    const origin = publicOrigin();
    const jobs = await currentJobs();
    if (!jobs.length) throw new Error('Add at least one job before sending invitations.');
    const results: { email: string; sent: boolean; error?: string }[] = [];
    for (const email of [...new Set<string>(recipients.map((email: string) => email.toLowerCase()))]) {
      const token = `inv_${randomBytes(16).toString('hex')}`;
      try {
        // A private event type gives each invitation its own duration and interview
        // URL without changing other candidates' bookings on the shared account.
        const event = await calRequest('event-types', 'POST', {
          title: 'WorkPodd interview', slug: token.replace('_', '-'), lengthInMinutes: duration,
          hidden: true, bookingRequiresAuthentication: false, disableGuests: true,
          minimumBookingNotice: 5, confirmationPolicy: { disabled: true },
          locations: [{ type: 'link', link: `${origin}/interview/${token}`, public: true }],
          successRedirectUrl: `${origin}/interview/${token}`,
          bookingFields: bookingFields(jobs, email),
          ...(process.env.CAL_SCHEDULE_ID ? { scheduleId: Number(process.env.CAL_SCHEDULE_ID) } : {}),
        });
        const bookingUrl = `https://cal.com/${encodeURIComponent(process.env.CAL_USERNAME)}/${event.slug}`;
        readState().invitations[token] = { email, duration, interviewType, eventTypeId: event.id, bookingUrl, jobs, createdAt: new Date().toISOString() };
        saveState();
        await sendInvitation(email, subject.trim(), body.replaceAll('{{booking_link}}', `${origin}/book/${token}`), token);
        results.push({ email, sent: true });
      } catch (error: any) { results.push({ email, sent: false, error: error.message }); }
    }
    res.json({ results });
  } catch (error: any) { res.status(400).json({ error: error.message }); }
});

// Called from the server's /book route, so every invitation opens native Cal.com.
export async function getBookingUrl(token: string) {
  const invite = readState().invitations[token];
  if (!invite) throw new Error('Invitation not found.');
  await syncScheduledInterview(token, true);
  if (invite.bookingUid) return `${publicOrigin()}/interview/${token}`;
  if (!invite.bookingUid) {
    const jobs = await currentJobs();
    if (!jobs.length) throw new Error('There are no available jobs. Please contact the recruiter.');
    await calRequest(`event-types/${invite.eventTypeId}`, 'PATCH', { bookingFields: bookingFields(jobs, invite.email) });
    invite.jobs = jobs;
    saveState();
  }
  const url = new URL(invite.bookingUrl);
  url.searchParams.set('email', invite.email);
  return url.toString();
}

integrationsRouter.get('/invitations/:token', async (req, res) => {
  try {
    await syncScheduledInterview(req.params.token);
    const snapshot = await getDoc(doc(db, 'interviews', req.params.token));
    if (!snapshot.exists()) return res.json({ booked: false, serverNow: Date.now() });
    const interview = snapshot.data();
    res.json({ booked: true, serverNow: Date.now(), applicantName: interview.applicantName, jobTitle: interview.jobTitle,
      scheduledAt: interview.scheduledAt, bookingStatus: interview.bookingStatus, cvStatus: interview.cvStatus,
      status: interview.status, canStart: interview.bookingStatus === 'confirmed' && Date.now() >= interview.scheduledAt && interview.cvStatus === 'ready',
    });
  } catch (error: any) { res.status(400).json({ error: error.message }); }
});
