<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/8c2a3b00-8d1c-4052-9862-9c10f4636ec7

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## WorkPodd test version

This version uses WorkPodd as the test company, with no recruiter login. The
Dashboard and Create New pages remain available; Jobs adds a reusable job library
and an invitation panel. The interface is black, white, and neutral gray.

Interviews now use the saved start time and configured duration, with no question
quota. The AI receives time notices and a closing instruction in the last 30
seconds (a smaller window for one-minute interviews). The timer remains the final
cutoff, and the candidate can still end early.

### Google Drive

Set `APP_URL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in the server
environment. Enable the Google Drive API and configure the OAuth consent screen
for the app. Register this exact redirect URI in the OAuth web client:

`<APP_URL>/api/google/callback`

The recruiter clicks **Connect Google Drive** on the dashboard and grants access.
InterviewAI creates an **InterviewAI** folder using the limited `drive.file`
permission. Recordings and CVs inherit that folder's access; there is no hardcoded
company-domain sharing rule. Existing service-account variables remain supported
as a fallback until a Google account is connected.

The app stores the connection and invitation records in the private `.local`
directory (or `INTERVIEWAI_DATA_DIR`). Preserve this directory across server
restarts. Do not publish it, serve it, or include it when sharing project files.
Vite explicitly blocks `.local`. If using a custom data directory, place it
outside the project and all public/static directories.

### Shared Cal.com account and invitation email

1. In the shared Cal.com account, connect Google Calendar and set the desired
   availability. Set `CAL_API_KEY` and `CAL_USERNAME` on the server. Optionally
   set `CAL_SCHEDULE_ID` to a specific availability schedule.
2. Configure a verified sender in Brevo and set `BREVO_API_KEY` and `EMAIL_FROM`
   (for example, `InterviewAI <interviews@your-verified-domain>`).
3. Set `APP_URL` to the actual app URL, including `https://`. This is used for
   email links and Cal.com's interview location and success redirect.
4. Apply the updated `firestore.rules` to the **named database** configured in
   `src/firebase.ts`, including the new Jobs rules. A rule update against only
   the default database will not update this app's database.
5. Add jobs, then select **Invite for Interview**. The subject and body are
   editable. Keep `{{booking_link}}` in the body. Type and duration configure
   the interview internally. Up to 20 recipients can be sent at a time.

Each invitation creates a hidden Cal.com event type with its own duration and
InterviewAI URL, using the shared account's availability. These event types are
visible to the owner in Cal.com's settings and can be cleaned up after testing.
Opening an invitation refreshes its job choices from the Jobs page. Once a
booking is confirmed, the selected job description is saved on the interview.

Candidates book on **Cal.com itself**, enter their name, and choose a job. Cal.com
then redirects them to InterviewAI to upload their CV. The app checks the booking
through Cal.com's API; it does not trust dates or job titles in redirect query
parameters. A readable CV is required before a scheduled interview can start.
Scanned/image-only PDFs show a retry message. CV extraction completes before the
interview becomes ready, using the same `cvText` field as manual interviews.

The calendar location is the candidate's InterviewAI URL, without a Google Meet
or Cal Video meeting. Cal.com handles calendar invitations and reminders according
to that account's configuration. Candidates' calendar settings may require them
to accept an invitation. Booking status is rechecked when the candidate returns
and starts, including cancellation and rescheduling. No webhook setup is needed.

Live connections and start requests check the scheduled time on the server.
The no-login test workspace deliberately retains shared recruiter access; this
is not company-account isolation.

### Completion and checks

The candidate page waits for recorded chunks to finish sending and for the server
to accept the final transcript. The server then finalizes the recording and runs
the assessment independently of the browser. Failed saves show a retry action.
An incomplete recording is marked unavailable instead of reported as uploaded.
The recording conversion still requires `ffmpeg` on the server, as before.
Background processing requires the server process to remain running.

Run `npm run lint`, `npm run build`, and
`node --experimental-strip-types --test tests/interviewClock.test.mjs` (Node 22.6+).
The Google OAuth consent, real Cal.com booking/calendar event, delivered email,
Gemini audio, and recording upload must also be checked with configured accounts.
No external service credentials are included in the project.

Integration references: [Google Drive permissions](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[Cal.com event types](https://cal.com/docs/api-reference/v2/event-types/create-an-event-type),
[Cal.com bookings](https://cal.com/docs/api-reference/v2/bookings/get-all-bookings),
[Brevo transactional email API](https://developers.brevo.com/reference/sendtransacemail).
