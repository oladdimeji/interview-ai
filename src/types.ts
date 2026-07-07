export interface TranscriptEntry {
  sender: 'AI' | 'Candidate';
  text: string;
  timestamp: number;
}

export interface ScoreCriterion {
  criteria: string;
  score: number; // 1-10
  feedback: string;
}

export interface Interview {
  id: string;
  applicantName: string;
  jobTitle: string;
  jobDescription: string;
  interviewType: 'Technical' | 'Behavioral' | 'Screening';
  duration: number; // in minutes
  status: 'pending' | 'in_progress' | 'processing' | 'completed';
  createdAt: string;
  startedAt?: number;
  transcript: TranscriptEntry[];
  recordingUrl?: string;
  recordingStatus?: 'uploading' | 'ready' | 'failed' | 'local_only';
  summary?: string;
  scoreBreakdown?: ScoreCriterion[];
  decision?: 'hire' | 'no_hire';
  decisionReasoning?: string;
}
