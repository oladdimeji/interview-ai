import { FormEvent, useState } from 'react';

export default function InvitationPanel({ onClose }: { onClose: () => void }) {
  const [recipients, setRecipients] = useState('');
  const [subject, setSubject] = useState('You are invited to interview at WorkPodd');
  const [body, setBody] = useState('Hello,\n\nThank you for applying to WorkPodd. After reviewing your application, we would like to invite you to the next stage: an interview with InterviewAI.\n\nPlease choose a convenient interview date and time using the link below:\n\n{{booking_link}}\n\nAfter booking, you will be asked to upload your CV. Please have it ready as a PDF or DOCX file.\n\nWe look forward to learning more about you.\n\nThe WorkPodd Team');
  const [interviewType, setInterviewType] = useState('Technical');
  const [duration, setDuration] = useState('10');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ email: string; sent: boolean; error?: string }[]>([]);
  const input = 'w-full rounded-lg border border-neutral-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/20';

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setSending(true); setError(null); setResults([]);
    try {
      const response = await fetch('/api/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        recipients: [...new Set(recipients.split(/[\s,;]+/).filter(Boolean))], subject, body, interviewType, duration: Number(duration),
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not send invitations.');
      setResults(result.results);
      // A retry should only include recipients whose invitations failed.
      setRecipients(result.results.filter((item: any) => !item.sent).map((item: any) => item.email).join('\n'));
    } catch (error: any) { setError(error.message); }
    finally { setSending(false); }
  };

  return <form onSubmit={send} className="rounded-xl border border-neutral-200 bg-white p-6 space-y-4">
    <h3 className="font-display text-lg font-bold">Invite for Interview</h3>
    <div><label htmlFor="invite-recipients" className="block text-sm font-semibold mb-2">Recipients</label><textarea id="invite-recipients" required rows={2} value={recipients} onChange={e => setRecipients(e.target.value)} disabled={sending} className={input} placeholder="One email per line, or separate with commas" /></div>
    <div><label htmlFor="invite-subject" className="block text-sm font-semibold mb-2">Subject</label><input id="invite-subject" required maxLength={200} value={subject} onChange={e => setSubject(e.target.value)} disabled={sending} className={input} /></div>
    <div><label htmlFor="invite-body" className="block text-sm font-semibold mb-2">Message</label><textarea id="invite-body" required maxLength={10000} rows={12} value={body} onChange={e => setBody(e.target.value)} disabled={sending} className={input} /><p className="text-xs text-ink/60 mt-1">{'Keep {{booking_link}} where the candidate’s personal scheduling link should appear.'}</p></div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div><label htmlFor="invite-type" className="block text-sm font-semibold mb-2">Interview type</label><select id="invite-type" value={interviewType} onChange={e => setInterviewType(e.target.value)} disabled={sending} className={input}><option>Technical</option><option>Behavioral</option><option>Screening</option></select></div>
      <div><label htmlFor="invite-duration" className="block text-sm font-semibold mb-2">Duration (minutes)</label><input id="invite-duration" type="number" required min={1} max={60} value={duration} onChange={e => setDuration(e.target.value)} disabled={sending} className={input} /></div>
    </div>
    <p className="text-xs text-ink/60">The type and duration configure the interview. Each candidate receives a separate invitation.</p>
    {error && <p role="alert" className="text-sm border border-neutral-300 rounded-lg p-3">{error}</p>}
    {results.length > 0 && <ul aria-live="polite" className="text-sm space-y-2">{results.map(item => <li key={item.email}>{item.email}: {item.sent ? 'Invitation sent' : item.error || 'Not sent'}</li>)}</ul>}
    <div className="flex gap-3"><button disabled={sending || !recipients.trim()} className="rounded-lg bg-ink text-white px-4 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50">{sending ? 'Sending invitations...' : 'Send invitations'}</button><button type="button" onClick={onClose} disabled={sending} className="rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50">Close</button></div>
  </form>;
}
