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
  const [cvFile, setCvFile] = useState<File | null>(null);
  
  const [loading, setLoading] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setCreatedLink(null);

    try {
      const formData = new FormData();
      formData.append('applicantName', applicantName);
      formData.append('jobTitle', jobTitle);
      formData.append('jobDescription', jobDescription);
      formData.append('interviewType', interviewType);
      formData.append('duration', String(duration));
      if (cvFile) {
        formData.append('cv', cvFile);
      }

      console.log('[CreateInterview] Sending creation request to server...');
      const res = await fetch('/api/interviews', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Unknown server error' }));
        throw new Error(errData.error || 'Failed to create interview');
      }

      const data = await res.json();
      const interviewId = data.interviewId;

      // 2. Generate sharing link
      const origin = window.location.origin;
      const shareLink = `${origin}/interview/${interviewId}`;
      setCreatedLink(shareLink);

      // Reset form fields
      setApplicantName('');
      setJobTitle('');
      setJobDescription('');
      setInterviewType('Technical');
      setDuration(10);
      setCvFile(null);

      // Trigger list update
      onInterviewCreated();
    } catch (err: any) {
      console.error('Error creating interview:', err);
      alert(err.message || 'Failed to create interview. Please try again.');
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

        <div>
          <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-1.5">
            Candidate CV/Resume (optional)
          </label>
          <div 
            className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors ${
              cvFile 
                ? 'border-indigo-500 bg-indigo-50/20' 
                : 'border-slate-200 hover:border-indigo-300 hover:bg-slate-50/50'
            }`}
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) {
                const ext = file.name.split('.').pop()?.toLowerCase();
                if (ext === 'pdf' || ext === 'docx') {
                  setCvFile(file);
                } else {
                  alert('Only .pdf and .docx files are accepted.');
                }
              }
            }}
            onClick={() => {
              const fileInput = document.getElementById('cv-file-input');
              if (fileInput) fileInput.click();
            }}
          >
            <input 
              id="cv-file-input"
              type="file"
              accept=".pdf,.docx"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0] || null;
                if (file) {
                  const ext = file.name.split('.').pop()?.toLowerCase();
                  if (ext === 'pdf' || ext === 'docx') {
                    setCvFile(file);
                  } else {
                    alert('Only .pdf and .docx files are accepted.');
                  }
                }
              }}
            />
            {cvFile ? (
              <div className="flex items-center justify-center gap-2.5 text-indigo-700 font-medium text-sm">
                <FileText className="h-5 w-5 shrink-0 text-indigo-500" />
                <span className="truncate max-w-[200px] sm:max-w-xs">{cvFile.name}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCvFile(null);
                    const fileInput = document.getElementById('cv-file-input') as HTMLInputElement;
                    if (fileInput) fileInput.value = '';
                  }}
                  className="ml-2 text-xs bg-indigo-100 hover:bg-indigo-200 text-indigo-700 px-2 py-1 rounded-md transition-colors"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="text-slate-500 text-xs">
                <p className="font-semibold">Drag & drop candidate CV/Resume here, or <span className="text-indigo-600 hover:underline">browse</span></p>
                <p className="text-slate-400 mt-1">Accepts only .pdf and .docx files (max 10MB)</p>
              </div>
            )}
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
