import React, { useEffect, useState, useRef } from 'react';
import { AlertCircle, Shield, Lock, Mail, User as UserIcon } from 'lucide-react';
import api from '../api/client';
import type { User } from '../types';

interface LoginScreenProps {
  onLoginSuccess: (user: User) => void;
}

declare global {
  interface Window {
    google?: any;
  }
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const [isSignUp, setIsSignUp] = useState<boolean>(false);
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let isSubscribed = true;

    const initGsi = () => {
      if (window.google?.accounts?.id && googleClientId && googleBtnRef.current) {
        try {
          window.google.accounts.id.initialize({
            client_id: googleClientId,
            auto_select: false,
            callback: async (response: any) => {
              if (response.credential && isSubscribed) {
                setIsLoading(true);
                setErrorMsg(null);
                try {
                  const res = await api.auth.verifyGoogleToken(response.credential);
                  if (isSubscribed) {
                    onLoginSuccess(res.user);
                  }
                } catch (err: any) {
                  if (isSubscribed) {
                    setErrorMsg(err.message || 'Google authentication failed');
                  }
                } finally {
                  if (isSubscribed) {
                    setIsLoading(false);
                  }
                }
              }
            },
          });

          // Clear placeholder before rendering official GIS button
          if (googleBtnRef.current) {
            googleBtnRef.current.innerHTML = '';
          }

          window.google.accounts.id.renderButton(googleBtnRef.current, {
            theme: 'outline',
            size: 'large',
            width: 320,
            text: 'signin_with',
            shape: 'rectangular',
            logo_alignment: 'left',
          });
          return true;
        } catch (err: any) {
          console.warn('GIS initialization error:', err);
        }
      }
      return false;
    };

    if (!initGsi()) {
      interval = setInterval(() => {
        if (initGsi() && interval) {
          clearInterval(interval);
        }
      }, 100);
    }

    return () => {
      isSubscribed = false;
      if (interval) clearInterval(interval);
    };
  }, [googleClientId, onLoginSuccess]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!email.trim() || !password) {
      setErrorMsg('Please enter both email and password');
      return;
    }

    if (isSignUp && password.length < 8) {
      setErrorMsg('Password must be at least 8 characters long');
      return;
    }

    setIsSubmitting(true);
    try {
      if (isSignUp) {
        const res = await api.auth.registerWithPassword(email.trim(), password, name.trim());
        onLoginSuccess(res.user);
      } else {
        const res = await api.auth.loginWithPassword(email.trim(), password);
        onLoginSuccess(res.user);
      }
    } catch (err: any) {
      setErrorMsg(err.message || (isSignUp ? 'Registration failed' : 'Invalid email or password'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#14121f] flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl p-8 border border-slate-200 text-center relative overflow-hidden">
        {/* Decorative Top Accent */}
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-purple-600 via-indigo-600 to-emerald-500" />

        {/* ONB Brand Monogram */}
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-purple-700 via-indigo-600 to-violet-500 flex items-center justify-center font-bold text-white tracking-wider text-lg shadow-lg shadow-purple-900/20 mx-auto mb-3">
          ONB
        </div>

        {/* Heading matching Figma: "Login" */}
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">
          {isSignUp ? 'Create an Account' : 'Login'}
        </h2>
        <p className="text-xs text-slate-500 mt-1 leading-relaxed">
          {isSignUp
            ? 'Sign up with email and password to access your ReachInbox workspace.'
            : 'Sign in to access your ReachInbox email scheduler.'}
        </p>

        {errorMsg && (
          <div className="my-4 p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-xs text-rose-800 text-left">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Google Identity Services Sign-In Button */}
        <div className="mt-5 flex flex-col items-center justify-center min-h-[44px]">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-purple-600 font-medium">
              <span className="w-4 h-4 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
              <span>Verifying Google credential...</span>
            </div>
          ) : googleClientId ? (
            <div ref={googleBtnRef} className="flex justify-center min-h-[40px]">
              <div className="w-[320px] h-[40px] border border-slate-300 rounded-md flex items-center justify-center gap-3 bg-white shadow-sm hover:bg-slate-50 transition-colors">
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                <span className="text-sm font-medium text-slate-700">Login with Google</span>
              </div>
            </div>
          ) : (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-left space-y-1 w-full max-w-[320px]">
              <div className="flex items-center gap-1.5 text-amber-800 font-semibold text-xs">
                <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                <span>Google Client ID Pending Configuration</span>
              </div>
              <p className="text-[10px] text-amber-700 leading-relaxed">
                Configure <code className="bg-amber-100 px-1 py-0.5 rounded font-mono">VITE_GOOGLE_CLIENT_ID</code> for live Google sign-in.
              </p>
            </div>
          )}
        </div>

        {/* Divider matching Figma: "or sign up through email" */}
        <div className="relative my-5">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-200" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-white px-3 text-slate-400 font-medium lowercase">
              {isSignUp ? 'or register with details' : 'or sign up through email'}
            </span>
          </div>
        </div>

        {/* Functional Email/Password Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5 text-left">
          {isSignUp && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Full Name</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <UserIcon className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Doe"
                  className="w-full pl-9 pr-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder:text-slate-400"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Email ID</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Mail className="w-4 h-4" />
              </div>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="name@company.com"
                className="w-full pl-9 pr-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder:text-slate-400"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Lock className="w-4 h-4" />
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder={isSignUp ? 'Min 8 characters' : 'Enter your password'}
                className="w-full pl-9 pr-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all placeholder:text-slate-400"
              />
            </div>
          </div>

          {/* Green Login / Sign-up Button */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full mt-2 py-2.5 px-4 bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 text-white font-semibold rounded-xl text-sm shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500/30 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
          >
            {isSubmitting ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>{isSignUp ? 'Creating account...' : 'Logging in...'}</span>
              </>
            ) : (
              <span>{isSignUp ? 'Create Account' : 'Login'}</span>
            )}
          </button>
        </form>

        {/* Toggle between Login and Sign-Up */}
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setErrorMsg(null);
            }}
            className="text-xs text-purple-600 hover:text-purple-700 font-medium hover:underline focus:outline-none"
          >
            {isSignUp
              ? 'Already have an account? Login'
              : "Don't have an account? Sign up with email"}
          </button>
        </div>

        {/* Backend Session Authority Banner */}
        <div className="mt-6 pt-5 border-t border-slate-100 flex items-center justify-center gap-2 text-[11px] text-slate-400">
          <Shield className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
          <span>Protected by bcrypt & Redis HTTP-only sessions</span>
        </div>
      </div>
    </div>
  );
};

export default LoginScreen;
