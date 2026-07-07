import { useState, FormEvent } from 'react';
import { db } from '../firebase';
import { collection, addDoc, updateDoc, doc } from 'firebase/firestore';
import { Briefcase, User, Calendar, FileText, Check, Copy, Link as LinkIcon, PlusCircle } from 'lucide-react';

interface CreateInterviewProps {
  onInterviewCreated: () => void;
}

export default function CreateInterview({ onInterviewCreated }: CreateInterviewProps) {
  const [applicantName, setApplicantName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [interviewType, setInterviewType] = useState<'Technical' | 'Behavioral' | 'Screening'>('Technical');
  const [duration, setDuration] = useState<number>(10);
  
  const [loading, setLoading] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setCreatedLink(null);

    try {
      // 1. Create initial pending record
      const docRef = await addDoc(collection(db, 'interviews'), {
        applicantName,
        jobTitle,
        jobDescription,
        interviewType,
        duration,
        status: 'pending',
        createdAt: new Date().toISOString(),
        transcript: []
      });

      // 2. Generate sharing link
      const origin = window.location.origin;
      const shareLink = `${origin}/interview/${docRef.id}`;
      setCreatedLink(shareLink);

      // Reset form fields
      setApplicantName('');
      setJobTitle('');
      setJobDescription('');
      setInterviewType('Technical');
      setDuration(10);

      // Trigger list update
      onInterviewCreated();
    } catch (err) {
      console.error('Error creating interview:', err);
      alert('Failed to create interview. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    if (!createdLink) return;
    navigator.clipboard.writeText(createdLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm" id="create-interview-view">
      <div className="flex items-center gap-2 mb-6">
        <PlusCircle className="h-5 w-5 text-indigo-600" />
        <h2 className="font-display text-lg font-bold text-slate-900">Create New Interview</h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">
              Applicant Name
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
                <User className="h-4 w-4" />
              </span>
              <input
                type="text"
                required
                value={applicantName}
                onChange={(e) => setApplicantName(e.target.value)}
                className="w-full rounded-lg border border-slate-200 pl-10 pr-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-600 focus:outline-none focus:ring-1 focus:ring-indigo-600 transition-colors bg-[#F8FAFC]/50"
                placeholder="Sarah Jenkins"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">
              Job Title
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
                <Briefcase className="h-4 w-4" />
              </span>
              <input
                type="text"
                required
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-200 pl-10 pr-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-600 focus:outline-none focus:ring-1 focus:ring-indigo-600 transition-colors bg-[#F8FAFC]/50"
                placeholder="Senior Lead Product Designer"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">
            Job Description
          </label>
          <div className="relative">
            <span className="absolute top-3 left-3 text-slate-400">
              <FileText className="h-4 w-4" />
            </span>
            <textarea
              required
              rows={3}
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              className="w-full rounded-lg border border-slate-200 pl-10 pr-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-600 focus:outline-none focus:ring-1 focus:ring-indigo-600 transition-colors bg-[#F8FAFC]/50"
              placeholder="Outline role scope, stack expectations, and required candidate competencies..."
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">
              Interview Type
            </label>
            <select
              value={interviewType}
              onChange={(e) => setInterviewType(e.target.value as any)}
              className="w-full rounded-lg border border-slate-200 px-4 py-2.5 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none focus:ring-1 focus:ring-indigo-600 transition-colors bg-white cursor-pointer"
            >
              <option value="Technical">Technical Interview</option>
              <option value="Behavioral">Behavioral Interview</option>
              <option value="Screening">General Screening</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">
              Duration (minutes)
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
                <Calendar className="h-4 w-4" />
              </span>
              <input
                type="number"
                required
                min={1}
                max={60}
                value={duration}
                onChange={(e) => setDuration(parseInt(e.target.value) || 10)}
                className="w-full rounded-lg border border-slate-200 pl-10 pr-4 py-2.5 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none focus:ring-1 focus:ring-indigo-600 transition-colors bg-[#F8FAFC]/50"
              />
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-indigo-400 transition-colors cursor-pointer flex justify-center items-center"
        >
          {loading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
          ) : (
            'Generate Shareable Interview Link'
          )}
        </button>
      </form>

      {/* Sharing Link Box */}
      {createdLink && (
        <div className="mt-6 p-4 rounded-lg bg-indigo-50/50 border border-indigo-100 flex flex-col md:flex-row md:items-center justify-between gap-3 animate-fade-in">
          <div className="min-w-0 flex-1">
            <span className="text-xs font-semibold text-indigo-700 uppercase tracking-wider block mb-1">
              Interview Shareable Link
            </span>
            <div className="flex items-center gap-1.5 text-indigo-900 font-mono text-xs truncate bg-white/80 p-2 rounded-lg border border-indigo-100/50">
              <LinkIcon className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
              <span className="truncate">{createdLink}</span>
            </div>
          </div>
          <button
            onClick={copyToClipboard}
            className="shrink-0 flex items-center justify-center gap-2 rounded-lg bg-white border border-indigo-200 text-indigo-600 px-4 py-2.5 text-xs font-semibold hover:bg-indigo-50 transition-colors cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4 text-green-500" /> Copied!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" /> Copy Link
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
