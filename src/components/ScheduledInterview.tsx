import { FormEvent, useCallback, useEffect, useState } from 'react';
import InterviewComplete from './InterviewComplete';

type Booking = {
  booked: boolean; applicantName?: string; jobTitle?: string; scheduledAt?: number;
  bookingStatus?: string; cvStatus?: string; status?: string; canStart?: boolean;
};

export default function ScheduledInterview({ interviewId, onReady }: { interviewId: string; onReady: () => void }) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadBooking = useCallback(async () => {
    try {
      const response = await fetch(`/api/invitations/${interviewId}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load your booking.');
      setBooking(result);
      setError(null);
    } catch (error: any) { setError(error.message); }
  }, [interviewId]);

  useEffect(() => {
    loadBooking();
    const interval = setInterval(loadBooking, 15000);
    return () => clearInterval(interval);
  }, [loadBooking]);

  useEffect(() => {
    if (booking?.status === 'in_progress') onReady();
  }, [booking?.status, onReady]);

  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || uploading) return;
    if (file.size > 10 * 1024 * 1024) { setError('Please choose a CV smaller than 10 MB.'); return; }
    setUploading(true); setError(null);
    try {
      const data = new FormData(); data.append('cv', file);
      const response = await fetch(`/api/invitations/${interviewId}/cv`, { method: 'POST', body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not process your CV.');
      await loadBooking();
    } catch (error: any) { setError(error.message); }
    finally { setUploading(false); }
  };

  if (booking?.status === 'completed' || booking?.status === 'processing') return <InterviewComplete />;
  return <div className="min-h-screen bg-neutral-bg flex items-center justify-center p-5">
    <div className="w-full max-w-lg rounded-2xl border border-neutral-200 bg-white p-8 space-y-6 shadow-sm">
      <div><p className="text-xs font-semibold uppercase tracking-wider text-ink/50">WorkPodd · InterviewAI</p><h1 className="font-display text-2xl font-bold mt-2">Your interview</h1></div>
      {!booking && !error && <p className="text-sm text-ink/60">Checking your booking...</p>}
      {booking && !booking.booked && <div className="space-y-3"><p className="text-sm text-ink/70">Your booking has not been confirmed yet. If you have just booked, this page will update shortly.</p><a href={`/book/${interviewId}`} className="inline-block underline text-sm font-semibold">Open Cal.com booking</a></div>}
      {booking?.booked && <>
        <div className="space-y-2 text-sm"><p className="font-semibold">{booking.applicantName}</p><p>{booking.jobTitle}</p><p className="text-ink/70">{booking.scheduledAt && new Date(booking.scheduledAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}</p><p className="text-xs text-ink/50">Times are shown in your local time zone.</p></div>
        {booking.bookingStatus === 'cancelled' ? <p className="text-sm">This booking has been cancelled. Please contact your recruiter.</p> : booking.cvStatus !== 'ready' ? (
          <form onSubmit={upload} className="space-y-4">
            <div><label htmlFor="scheduled-cv" className="block text-sm font-semibold mb-2">Upload your CV</label><p className="text-sm text-ink/60 mb-3">Your interviewer will use your CV to ask relevant questions about your experience.</p><input id="scheduled-cv" type="file" accept=".pdf,.docx" required disabled={uploading} onChange={e => setFile(e.target.files?.[0] || null)} className="w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-100 file:px-3 file:py-2 file:font-semibold" /><p className="text-xs text-ink/50 mt-2">PDF or DOCX, up to 10 MB.</p></div>
            <button disabled={uploading || !file} className="w-full rounded-lg bg-ink text-white px-4 py-3 text-sm font-semibold cursor-pointer disabled:opacity-50">{uploading ? 'Reading your CV...' : 'Upload CV'}</button>
          </form>
        ) : <div className="space-y-4"><p className="rounded-lg bg-neutral-100 p-3 text-sm">Your CV is ready for the interviewer.</p>{booking.canStart ? <button onClick={onReady} className="w-full rounded-lg bg-ink text-white px-4 py-3 text-sm font-semibold cursor-pointer">Continue to waiting room</button> : <p className="text-sm text-ink/70">Your interview will open at the scheduled time. Use this same link when you return.</p>}</div>}
      </>}
      {error && <p role="alert" className="rounded-lg border border-neutral-300 p-3 text-sm">{error}</p>}
      <button type="button" onClick={loadBooking} disabled={uploading} className="text-sm underline text-ink/60 cursor-pointer">Refresh booking status</button>
    </div>
  </div>;
}
