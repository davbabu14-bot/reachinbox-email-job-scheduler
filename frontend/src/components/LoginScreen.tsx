import React, { useEffect, useState, useRef } from 'react';
import { AlertCircle, Shield } from 'lucide-react';
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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

  useEffect(() => {
    // If Google Identity Services script is loaded and client ID exists, render official GIS button
    if (window.google && googleClientId && googleBtnRef.current) {
      try {
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (response: any) => {
            if (response.credential) {
              setIsLoading(true);
              setErrorMsg(null);
              try {
                const res = await api.auth.verifyGoogleToken(response.credential);
                onLoginSuccess(res.user);
              } catch (err: any) {
                setErrorMsg(err.message || 'Google authentication failed');
              } finally {
                setIsLoading(false);
              }
            }
          },
        });

        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme: 'outline',
          size: 'large',
          width: 320,
          text: 'continue_with',
          shape: 'rectangular',
        });
      } catch (err: any) {
        console.warn('GIS initialization error:', err);
      }
    }
  }, [googleClientId, onLoginSuccess]);

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl p-8 border border-slate-200 text-center relative overflow-hidden">
        {/* Decorative Top Accent */}
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-purple-600 via-indigo-600 to-emerald-500" />

        {/* ONB Brand Logo */}
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-purple-700 via-indigo-600 to-violet-500 flex items-center justify-center font-bold text-white tracking-wider text-xl shadow-lg shadow-purple-900/20 mx-auto mb-4">
          ONB
        </div>

        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Sign in to ReachInbox</h2>
        <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
          Database-backed email job scheduler with distributed rate limiting, outbox persistence, and
          Elasticsearch search.
        </p>

        {errorMsg && (
          <div className="my-4 p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-xs text-rose-800 text-left">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Official Google Identity Services Button Container */}
        <div className="mt-6 flex flex-col items-center justify-center min-h-[48px]">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-purple-600 font-medium">
              <span className="w-4 h-4 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
              <span>Verifying Google credential...</span>
            </div>
          ) : googleClientId ? (
            <div ref={googleBtnRef} className="flex justify-center" />
          ) : (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-left space-y-2">
              <div className="flex items-center gap-2 text-amber-800 font-semibold text-xs">
                <AlertCircle className="w-4 h-4 text-amber-600" />
                <span>Google Client ID Pending Configuration</span>
              </div>
              <p className="text-[11px] text-amber-700 leading-relaxed">
                To enable live Google Sign-In, configure <code className="bg-amber-100 px-1 py-0.5 rounded font-mono">VITE_GOOGLE_CLIENT_ID</code> in your frontend environment.
              </p>
            </div>
          )}
        </div>

        {/* Backend Session Authority Banner */}
        <div className="mt-8 pt-6 border-t border-slate-100 flex items-center justify-center gap-2 text-xs text-slate-400">
          <Shield className="w-3.5 h-3.5 text-emerald-500" />
          <span>Protected by AES-256-GCM & Redis HTTP-only sessions</span>
        </div>
      </div>
    </div>
  );
};

export default LoginScreen;
