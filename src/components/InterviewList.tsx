import { useEffect, useState } from 'react';
import { db } from '../firebase';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { Interview } from '../types';
import { ListFilter, Calendar, ChevronRight, Hourglass, Video, CheckCircle2, Trash2, AlertTriangle } from 'lucide-react';

interface InterviewListProps {
  onSelectInterview: (interview: Interview) => void;
  selectedInterviewId?: string;
  onDeleteSuccess?: () => void;
  key?: number | string;
}

export default function InterviewList({ onSelectInterview, selectedInterviewId, onDeleteSuccess }: InterviewListProps) {
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'in_progress' | 'completed'>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    // Live subscriber for interviews collection ordered by creation date desc
    const q = query(collection(db, 'interviews'), orderBy('createdAt', 'desc'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items: Interview[] = [];
      snapshot.forEach((doc) => {
        items.push({ id: doc.id, ...doc.data() } as Interview);
      });
      setInterviews(items);
      setLoading(false);
    }, (error) => {
      console.error('Error in onSnapshot listener:', error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const filteredInterviews = interviews.filter((item) => {
    if (filter === 'all') return true;
    if (filter === 'completed') {
      return item.status === 'completed' || item.status === 'processing';
    }
    return item.status === filter;
  });

  const getStatusBadge = (status: Interview['status']) => {
    switch (status) {
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-accent/10 px-2.5 py-1 text-xs font-semibold text-emerald-accent border border-emerald-accent/25">
            <CheckCircle2 className="h-3 w-3" /> Completed
          </span>
        );
      case 'processing':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-accent/10 px-2.5 py-1 text-xs font-semibold text-amber-accent border border-amber-accent/25 animate-pulse">
            <svg className="animate-spin h-3 w-3 text-amber-accent" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Processing
          </span>
        );
      case 'in_progress':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate px-2.5 py-1 text-xs font-semibold text-neutral-bg border border-graphite animate-pulse">
            <Video className="h-3 w-3 text-emerald-accent" /> In Progress
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-bg px-2.5 py-1 text-xs font-semibold text-ink/60 border border-neutral-200">
            <Hourglass className="h-3 w-3" /> Pending
          </span>
        );
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-sm" id="interview-list-view">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-2">
          <div>
            <h2 className="font-display text-lg sm:text-xl font-extrabold tracking-tight text-ink leading-none">Interviews</h2>
          </div>
        </div>
        
        {/* Status filters */}
        <div className="flex rounded-lg bg-neutral-bg border border-neutral-200 p-1 text-[10px] font-mono">
          {(['all', 'pending', 'in_progress', 'completed'] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => setFilter(opt)}
              className={`rounded px-2.5 py-1.5 font-bold transition-all duration-200 cursor-pointer capitalize ${
                filter === opt 
                  ? 'bg-emerald-accent text-ink shadow-sm' 
                  : 'text-ink/60 hover:text-ink hover:bg-neutral-bg/40'
              }`}
            >
              {opt === 'in_progress' ? 'Active' : opt}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-accent border-t-transparent" />
        </div>
      ) : filteredInterviews.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-neutral-200 rounded-xl">
          <p className="text-sm text-ink/40 font-mono">No interviews found for the selected filter.</p>
        </div>
      ) : (
        <div className="divide-y divide-neutral-100">
          {filteredInterviews.map((interview) => {
            const isSelected = selectedInterviewId === interview.id;
            return (
              <div
                key={interview.id}
                onClick={() => onSelectInterview(interview)}
                className={`flex items-center justify-between py-4 px-3 -mx-3 rounded-lg transition-all duration-200 cursor-pointer ${
                  isSelected 
                    ? 'bg-emerald-accent/5 border border-emerald-accent/15 border-l-4 border-l-emerald-accent pl-4 shadow-sm' 
                    : 'hover:bg-neutral-bg/30'
                }`}
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="h-10 w-10 shrink-0 rounded-full bg-slate text-neutral-bg border border-graphite flex items-center justify-center font-display font-bold text-sm">
                    {getInitials(interview.applicantName)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">
                      {interview.applicantName}
                    </p>
                    <p className="text-xs text-ink/60 truncate mt-0.5 font-sans">
                      {interview.jobTitle} • <span className="font-semibold text-ink/80 font-mono text-[10px] uppercase tracking-wide">{interview.interviewType}</span>
                    </p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="inline-flex items-center gap-1 text-[10px] text-ink/40 font-semibold font-mono uppercase tracking-wider">
                        <Calendar className="h-3 w-3 text-emerald-accent" />
                        {new Date(interview.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {getStatusBadge(interview.status)}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletingId(interview.id);
                    }}
                    title="Delete Interview"
                    className="p-1.5 text-ink/40 hover:text-amber-accent hover:bg-amber-accent/5 rounded-lg transition-colors cursor-pointer"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <ChevronRight className={`h-5 w-5 text-ink/30 transition-transform ${isSelected ? 'translate-x-1 text-emerald-accent' : ''}`} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {deletingId && (
        <div className="fixed inset-0 bg-ink/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-white rounded-xl shadow-2xl border border-neutral-200 p-6 max-w-md w-full animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-full bg-amber-accent/10 text-amber-accent flex items-center justify-center shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-ink">Delete this interview?</h3>
                <p className="text-xs text-ink/60 mt-2 leading-relaxed">
                  This will permanently remove the interview, its transcript, and its recording. This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6 font-mono text-xs">
              <button
                disabled={isDeleting}
                onClick={() => setDeletingId(null)}
                className="px-4 py-2 font-bold border border-neutral-200 rounded-lg hover:bg-neutral-bg text-ink cursor-pointer transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                disabled={isDeleting}
                onClick={async () => {
                  setIsDeleting(true);
                  try {
                    const res = await fetch(`/api/interviews/${deletingId}`, {
                      method: 'DELETE',
                    });
                    if (!res.ok) {
                      throw new Error('Failed to delete interview');
                    }
                    if (selectedInterviewId === deletingId && onDeleteSuccess) {
                      onDeleteSuccess();
                    }
                  } catch (err) {
                    console.error('Error deleting interview:', err);
                    alert('Failed to delete interview. Please try again.');
                  } finally {
                    setIsDeleting(false);
                    setDeletingId(null);
                  }
                }}
                className="px-4 py-2 font-bold bg-ink hover:opacity-90 text-white rounded-lg cursor-pointer transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {isDeleting ? (
                  <>
                    <svg className="animate-spin -ml-0.5 mr-1.5 h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Deleting...
                  </>
                ) : (
                  'Delete'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
