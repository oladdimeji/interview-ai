import { FormEvent, useEffect, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } from 'firebase/firestore';
import { Briefcase, Pencil, Plus, Trash2 } from 'lucide-react';
import { db } from '../firebase';
import InvitationPanel from './InvitationPanel';

interface Job {
  id: string;
  title: string;
  description: string;
  createdAt: string;
}

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showInvitations, setShowInvitations] = useState(false);

  useEffect(() => onSnapshot(query(collection(db, 'jobs'), orderBy('createdAt', 'desc')), snapshot => {
    setJobs(snapshot.docs.map(item => ({ id: item.id, ...item.data() } as Job)));
    setLoading(false);
  }, () => {
    setError('Could not load jobs. Please refresh and try again.');
    setLoading(false);
  }), []);

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setTitle('');
    setDescription('');
  };

  const saveJob = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !title.trim() || !description.trim()) return;
    if (jobs.some(job => job.id !== editingId && job.title.toLowerCase() === title.trim().toLowerCase())) {
      setError('A job with this title already exists. Edit that job or use a different title.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const values = { title: title.trim(), description: description.trim() };
      if (editingId) await updateDoc(doc(db, 'jobs', editingId), values);
      else await addDoc(collection(db, 'jobs'), { ...values, createdAt: new Date().toISOString() });
      closeForm();
    } catch {
      setError('Could not save this job. Your changes are still here; please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold text-ink">Jobs</h2>
          <p className="text-sm text-ink/60 mt-1">Job titles and descriptions for WorkPodd.</p>
        </div>
        <button onClick={() => setShowInvitations(true)} disabled={!jobs.length} className="rounded-lg bg-ink text-white px-4 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50">Invite for Interview</button>
      </div>

      {showInvitations && <InvitationPanel onClose={() => setShowInvitations(false)} />}

      {error && <p role="alert" className="rounded-lg border border-neutral-300 bg-white p-4 text-sm text-ink">{error}</p>}

      {loading ? <p className="text-sm text-ink/60">Loading jobs...</p> : (
        <div className="space-y-3">
          {jobs.length === 0 && <div className="rounded-xl border border-dashed border-neutral-300 p-10 text-center text-sm text-ink/60">Add your first job title and description below.</div>}
          {jobs.map(job => (
            <details key={job.id} className="rounded-xl border border-neutral-200 bg-white group">
              <summary className="cursor-pointer p-5 font-semibold text-ink marker:text-neutral-500">{job.title}</summary>
              <div className="px-5 pb-5 space-y-4">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink/75">{job.description}</p>
                <div className="flex gap-3">
                  <button type="button" disabled={saving} onClick={() => {
                    setEditingId(job.id);
                    setTitle(job.title);
                    setDescription(job.description);
                    setShowForm(true);
                    setError(null);
                  }} className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-xs font-semibold hover:bg-neutral-100 cursor-pointer disabled:opacity-50"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                  <button type="button" disabled={saving} onClick={() => setDeletingId(job.id)} className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-xs font-semibold hover:bg-neutral-100 cursor-pointer disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}

      {showForm ? (
        <form onSubmit={saveJob} className="rounded-xl border border-neutral-200 bg-white p-6 space-y-4">
          <h3 className="font-display text-lg font-bold">{editingId ? 'Edit job' : 'Add job'}</h3>
          <div>
            <label htmlFor="job-title" className="block text-sm font-semibold mb-2">Job title</label>
            <input id="job-title" required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} disabled={saving} className="w-full rounded-lg border border-neutral-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/20" />
          </div>
          <div>
            <label htmlFor="job-description" className="block text-sm font-semibold mb-2">Job description</label>
            <textarea id="job-description" required maxLength={10000} rows={6} value={description} onChange={e => setDescription(e.target.value)} disabled={saving} className="w-full rounded-lg border border-neutral-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/20" />
          </div>
          <div className="flex gap-3">
            <button disabled={saving || !title.trim() || !description.trim()} className="rounded-lg bg-ink text-white px-4 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50">{saving ? 'Saving...' : 'Save job'}</button>
            <button type="button" onClick={closeForm} disabled={saving} className="rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-semibold cursor-pointer disabled:opacity-50">Cancel</button>
          </div>
        </form>
      ) : <button onClick={() => { closeForm(); setShowForm(true); }} className="flex items-center gap-2 rounded-lg bg-ink text-white px-4 py-3 text-sm font-semibold cursor-pointer"><Plus className="h-4 w-4" /> Add job</button>}

      {deletingId && <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
        <div role="dialog" aria-modal="true" aria-labelledby="delete-job-title" className="w-full max-w-sm rounded-xl bg-white p-6 space-y-4">
          <h3 id="delete-job-title" className="text-lg font-bold">Delete this job?</h3>
          <p className="text-sm text-ink/60">Existing interviews will keep their saved job details.</p>
          <div className="flex justify-end gap-3">
            <button disabled={busyDelete} onClick={() => setDeletingId(null)} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm cursor-pointer disabled:opacity-50">Cancel</button>
            <button disabled={busyDelete} onClick={async () => {
              setBusyDelete(true);
              setError(null);
              try {
                await deleteDoc(doc(db, 'jobs', deletingId));
                if (editingId === deletingId) closeForm();
                setDeletingId(null);
              } catch {
                setError('Could not delete the job. Please try again.');
                setDeletingId(null);
              } finally { setBusyDelete(false); }
            }} className="rounded-lg bg-ink text-white px-4 py-2 text-sm cursor-pointer disabled:opacity-50">{busyDelete ? 'Deleting...' : 'Delete'}</button>
          </div>
        </div>
      </div>}
    </div>
  );
}
