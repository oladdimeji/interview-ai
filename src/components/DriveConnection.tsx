import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';

export default function DriveConnection() {
  const [status, setStatus] = useState<{ driveConnected: boolean; driveConfigured: boolean; driveEmail: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/integrations').then(async response => {
      if (!response.ok) throw new Error('Could not check Google Drive.');
      const result = await response.json();
      if (!cancelled) setStatus(result);
    }).catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, []);
  return <div className="rounded-xl border border-neutral-200 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
    <div className="flex items-center gap-3"><HardDrive className="h-5 w-5 shrink-0" /><div><p className="text-sm font-semibold">Google Drive</p><p className="text-xs text-ink/60 mt-1">{error || (status?.driveConnected ? `Connected: ${status.driveEmail}` : 'Save recordings and CVs in your InterviewAI folder.')}</p></div></div>
    {status?.driveConfigured ? <a href="/api/google/connect" target="_top" className="rounded-lg bg-ink text-white px-4 py-2 text-xs font-semibold">{status.driveConnected ? 'Change account' : 'Connect Google Drive'}</a> : <button type="button" onClick={() => setError('Google Drive connection is awaiting the one-time app setup.')} className="rounded-lg border border-neutral-300 px-4 py-2 text-xs font-semibold cursor-pointer">Connect Google Drive</button>}
  </div>;
}
