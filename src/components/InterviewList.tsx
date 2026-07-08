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
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700 border border-green-200">
            <CheckCircle2 className="h-3 w-3" /> Completed
          </span>
        );
      case 'processing':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 border border-amber-200 animate-pulse">
            <svg className="animate-spin h-3 w-3 text-amber-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Processing
          </span>
        );
      case 'in_progress':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 border border-blue-200 animate-pulse">
            <Video className="h-3 w-3" /> In Progress
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700 border border-gray-200">
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
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm" id="interview-list-view">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-2">
          <ListFilter className="h-5 w-5 text-slate-500" />
          <h2 className="font-display text-lg font-bold text-slate-900">Interviews Directory</h2>
        </div>
        
        {/* Status filters */}
        <div className="flex rounded-lg bg-[#F8FAFC] border border-slate-200 p-1 text-xs">
          {(['all', 'pending', 'in_progress', 'completed'] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => setFilter(opt)}
              className={`rounded px-3 py-1.5 font-semibold transition-colors cursor-pointer capitalize ${
                filter === opt 
                  ? 'bg-indigo-600 text-white shadow-sm' 
                  : 'text-slate-500 hover:text-slate-950'
              }`}
            >
              {opt === 'in_progress' ? 'Active' : opt}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
        </div>
      ) : filteredInterviews.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-slate-200 rounded-xl">
          <p className="text-sm text-slate-500">No interviews found for the selected filter.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {filteredInterviews.map((interview) => {
            const isSelected = selectedInterviewId === interview.id;
            return (
              <div
                key={interview.id}
                onClick={() => onSelectInterview(interview)}
                className={`flex items-center justify-between py-4 px-3 -mx-3 rounded-lg transition-all cursor-pointer ${
                  isSelected 
                    ? 'bg-indigo-50/40 border border-indigo-100 border-l-4 border-l-indigo-600 pl-4 shadow-sm' 
                    : 'hover:bg-[#F8FAFC]'
                }`}
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="h-10 w-10 shrink-0 rounded-full bg-indigo-50 text-indigo-700 flex items-center justify-center font-display font-semibold text-sm">
                    {getInitials(interview.applicantName)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">
                      {interview.applicantName}
                    </p>
                    <p className="text-xs text-slate-500 truncate mt-0.5">
                      {interview.jobTitle} • <span className="font-semibold text-slate-700">{interview.interviewType}</span>
                    </p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="inline-flex items-center gap-1 text-[10px] text-slate-400 font-semibold uppercase tracking-wider">
                        <Calendar className="h-3 w-3" />
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
                    className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <ChevronRight className={`h-5 w-5 text-slate-400 transition-transform ${isSelected ? 'translate-x-1 text-indigo-600' : ''}`} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {deletingId && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-6 max-w-md w-full animate-in fade-in zoom-in duration-150">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Delete this interview?</h3>
                <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                  This will permanently remove the interview, its transcript, and its recording. This cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                disabled={isDeleting}
                onClick={() => setDeletingId(null)}
                className="px-4 py-2 text-xs font-semibold border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-700 cursor-pointer transition-colors disabled:opacity-50"
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
                className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white rounded-lg cursor-pointer transition-colors flex items-center gap-1.5 disabled:opacity-50"
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
