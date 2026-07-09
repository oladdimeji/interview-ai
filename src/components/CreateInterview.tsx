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
    <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-sm" id="create-interview-view">
      <div className="flex items-center gap-2 mb-6">
        <div className="p-1.5 bg-emerald-accent/10 rounded-lg">
          <PlusCircle className="h-5 w-5 text-emerald-accent" />
        </div>
        <div>
          <h2 className="font-display text-base font-bold text-ink">Create New Interview</h2>
          <p className="text-[10px] text-ink/40 font-mono uppercase tracking-wider leading-none mt-0.5">Setup Candidate Assessment</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] font-bold text-ink/50 uppercase tracking-widest mb-1.5 font-mono">
              Applicant Name
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-ink/40">
                <User className="h-4 w-4" />
              </span>
              <input
                type="text"
                required
                value={applicantName}
                onChange={(e) => setApplicantName(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 pl-10 pr-4 py-2.5 text-sm text-ink placeholder-ink/30 focus:border-emerald-accent focus:outline-none focus:ring-1 focus:ring-emerald-accent transition-colors bg-neutral-bg/20"
                placeholder="Sarah Jenkins"
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-ink/50 uppercase tracking-widest mb-1.5 font-mono">
              Job Title
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-ink/40">
                <Briefcase className="h-4 w-4" />
              </span>
              <input
                type="text"
                required
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 pl-10 pr-4 py-2.5 text-sm text-ink placeholder-ink/30 focus:border-emerald-accent focus:outline-none focus:ring-1 focus:ring-emerald-accent transition-colors bg-neutral-bg/20"
                placeholder="Senior Lead Product Designer"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-bold text-ink/50 uppercase tracking-widest mb-1.5 font-mono">
            Job Description
          </label>
          <div className="relative">
            <span className="absolute top-3 left-3 text-ink/40">
              <FileText className="h-4 w-4" />
            </span>
            <textarea
              required
              rows={3}
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              className="w-full rounded-lg border border-neutral-200 pl-10 pr-4 py-2.5 text-sm text-ink placeholder-ink/30 focus:border-emerald-accent focus:outline-none focus:ring-1 focus:ring-emerald-accent transition-colors bg-neutral-bg/20"
              placeholder="Outline role scope, stack expectations, and required candidate competencies..."
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] font-bold text-ink/50 uppercase tracking-widest mb-1.5 font-mono">
              Interview Type
            </label>
            <select
              value={interviewType}
              onChange={(e) => setInterviewType(e.target.value as any)}
              className="w-full rounded-lg border border-neutral-200 px-4 py-2.5 text-sm text-ink focus:border-emerald-accent focus:outline-none focus:ring-1 focus:ring-emerald-accent transition-colors bg-white cursor-pointer"
            >
              <option value="Technical">Technical Interview</option>
              <option value="Behavioral">Behavioral Interview</option>
              <option value="Screening">General Screening</option>
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-bold text-ink/50 uppercase tracking-widest mb-1.5 font-mono">
              Duration (minutes)
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-ink/40">
                <Calendar className="h-4 w-4" />
              </span>
              <input
                type="number"
                required
                min={1}
                max={60}
                value={duration}
                onChange={(e) => setDuration(parseInt(e.target.value) || 10)}
                className="w-full rounded-lg border border-neutral-200 pl-10 pr-4 py-2.5 text-sm text-ink focus:border-emerald-accent focus:outline-none focus:ring-1 focus:ring-emerald-accent transition-colors bg-neutral-bg/20"
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-bold text-ink/50 uppercase tracking-widest mb-1.5 font-mono">
            Candidate CV/Resume (optional)
          </label>
          <div 
            className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-all duration-200 ${
              cvFile 
                ? 'border-emerald-accent bg-emerald-accent/5' 
                : 'border-neutral-200 hover:border-emerald-accent hover:bg-neutral-bg/30'
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
              <div className="flex items-center justify-center gap-2.5 text-emerald-accent font-semibold text-sm">
                <FileText className="h-5 w-5 shrink-0 text-emerald-accent" />
                <span className="truncate max-w-[200px] sm:max-w-xs">{cvFile.name}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCvFile(null);
                    const fileInput = document.getElementById('cv-file-input') as HTMLInputElement;
                    if (fileInput) fileInput.value = '';
                  }}
                  className="ml-2 text-xs bg-ink/10 hover:bg-ink/20 text-ink px-2 py-1 rounded-md transition-colors font-mono"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="text-ink/60 text-xs">
                <p className="font-semibold">Drag & drop candidate CV/Resume here, or <span className="text-emerald-accent hover:underline">browse</span></p>
                <p className="text-ink/40 mt-1">Accepts only .pdf and .docx files (max 10MB)</p>
              </div>
            )}
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-emerald-accent px-4 py-2.5 text-sm font-semibold text-ink hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-emerald-accent/50 disabled:opacity-50 transition-all duration-200 cursor-pointer flex justify-center items-center shadow-md shadow-emerald-accent/15"
        >
          {loading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink border-t-transparent" />
          ) : (
            'Generate Shareable Interview Link'
          )}
        </button>
      </form>

      {/* Sharing Link Box */}
      {createdLink && (
        <div className="mt-6 p-4 rounded-lg bg-emerald-accent/5 border border-emerald-accent/20 flex flex-col md:flex-row md:items-center justify-between gap-3 animate-fade-in">
          <div className="min-w-0 flex-1">
            <span className="text-[10px] font-bold text-emerald-accent uppercase tracking-wider block mb-1 font-mono">
              Interview Shareable Link
            </span>
            <div className="flex items-center gap-1.5 text-ink font-mono text-xs truncate bg-white p-2 rounded-lg border border-neutral-200">
              <LinkIcon className="h-3.5 w-3.5 shrink-0 text-emerald-accent" />
              <span className="truncate">{createdLink}</span>
            </div>
          </div>
          <button
            onClick={copyToClipboard}
            className="shrink-0 flex items-center justify-center gap-2 rounded-lg bg-ink text-neutral-bg px-4 py-2.5 text-xs font-semibold hover:opacity-95 transition-colors cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4 text-emerald-accent" /> Copied!
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
