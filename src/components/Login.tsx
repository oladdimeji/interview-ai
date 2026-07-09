import { useState, FormEvent } from 'react';
import { auth } from '../firebase';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import { Lock, Mail, Loader2, AlertCircle, Sparkles } from 'lucide-react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setInfoMessage(null);

    const targetEmail = 'admin@workpodd.com';
    const targetPassword = 'Q7#mL9@Xp';

    try {
      // 1. Try to sign in first
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      console.warn("Sign-in failed with error code:", err?.code, err?.message);
      
      const isTargetCredentials = email.trim() === targetEmail && password === targetPassword;
      const isUserNotFoundOrInvalid = err?.code === 'auth/user-not-found' || err?.code === 'auth/invalid-credential';

      // 2. If it is the correct bootstrapping credentials, and the user wasn't found or got invalid credentials (perhaps not yet created),
      // we attempt to create the account automatically as requested.
      if (isTargetCredentials && isUserNotFoundOrInvalid) {
        try {
          setInfoMessage("Initializing admin account for first-time setup...");
          await createUserWithEmailAndPassword(auth, targetEmail, targetPassword);
          setInfoMessage("Admin account created and authenticated successfully.");
        } catch (createErr: any) {
          console.error("Auto-bootstrapping failed:", createErr);
          setError(`Account initialization failed: ${createErr?.message || 'Unknown error'}`);
        }
      } else {
        // Fallback friendly error
        if (err?.code === 'auth/invalid-email') {
          setError("Please enter a valid email address.");
        } else if (err?.code === 'auth/wrong-password' || err?.code === 'auth/invalid-credential' || err?.code === 'auth/user-not-found') {
          setError("Invalid credentials. Please verify your email and password.");
        } else {
          setError(err?.message || "An unexpected error occurred during authentication.");
        }
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-bg flex items-center justify-center p-4 sm:p-6 font-sans text-ink">
      <div className="w-full max-w-md bg-white border border-neutral-200 rounded-xl shadow-lg overflow-hidden flex flex-col p-8 space-y-6">
        
        {/* Header Title */}
        <div className="text-center space-y-2">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-slate text-emerald-accent shadow-[0_0_12px_rgba(16,185,129,0.2)] mb-2">
            <span className="text-2xl font-bold font-display">I</span>
          </div>
          <h2 className="font-display text-2xl font-bold tracking-tight text-ink">Admin Dashboard</h2>
          <p className="text-xs text-ink/60">Authentication required for recruiter console access</p>
        </div>

        {/* Form */}
        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-ink/80 block font-sans" htmlFor="email-input">
              Email Address
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-ink/40">
                <Mail className="h-4 w-4" />
              </span>
              <input
                id="email-input"
                type="email"
                required
                placeholder="recruiter@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                className="w-full pl-9 pr-4 py-2.5 rounded-lg border border-neutral-300 text-xs text-ink placeholder-ink/30 focus:border-emerald-accent focus:ring-1 focus:ring-emerald-accent/30 focus:outline-none transition-colors bg-[#FDFDFD]"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-ink/80 block font-sans" htmlFor="password-input">
              Password
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-ink/40">
                <Lock className="h-4 w-4" />
              </span>
              <input
                id="password-input"
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                className="w-full pl-9 pr-4 py-2.5 rounded-lg border border-neutral-300 text-xs text-ink placeholder-ink/30 focus:border-emerald-accent focus:ring-1 focus:ring-emerald-accent/30 focus:outline-none transition-colors bg-[#FDFDFD]"
              />
            </div>
          </div>

          {/* Feedback states */}
          {error && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 p-3.5 flex items-start gap-2.5 text-xs text-rose-700 font-medium">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}

          {infoMessage && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3.5 flex items-start gap-2.5 text-xs text-emerald-800 font-medium">
              <Sparkles className="h-4 w-4 shrink-0 mt-0.5 text-emerald-500 animate-pulse" />
              <span className="leading-relaxed">{infoMessage}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-ink hover:bg-slate text-white px-4 py-3 text-xs font-semibold tracking-wide transition-colors cursor-pointer shadow-sm mt-2 disabled:opacity-75"
          >
            {loading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-accent" />
                <span>Verifying Credentials...</span>
              </>
            ) : (
              <span>Access Recruiter Dashboard</span>
            )}
          </button>
        </form>

        {/* Helpful instructions for the user (No-key / Bootstrap explanation) */}
        <div className="border-t border-neutral-100 pt-4 text-center">
          <p className="text-[10px] text-ink/40 leading-relaxed max-w-xs mx-auto">
            Note: Email/Password Authentication must be enabled in the Firebase Console settings for this login to connect.
          </p>
        </div>

      </div>
    </div>
  );
}
