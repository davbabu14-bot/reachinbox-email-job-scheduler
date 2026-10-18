import React from 'react';
import { X, ExternalLink, Calendar, User, Clock, AlertTriangle } from 'lucide-react';
import type { EmailRecord } from '../types';

interface EmailDetailModalProps {
  email: EmailRecord | null;
  onClose: () => void;
}

export const EmailDetailModal: React.FC<EmailDetailModalProps> = ({ email, onClose }) => {
  if (!email) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4 bg-slate-50/60">
          <div>
            <h3 className="text-lg font-bold text-slate-900 leading-snug">
              {email.subject || '(No Subject)'}
            </h3>
            <p className="text-xs text-slate-500 font-mono mt-0.5">ID: {email.id}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Metadata grid */}
        <div className="px-6 py-3.5 border-b border-slate-100 bg-white grid grid-cols-2 gap-3 text-xs text-slate-600">
          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-slate-400 shrink-0" />
            <span className="truncate">
              <strong className="text-slate-800">To:</strong> {email.recipient}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-purple-400 shrink-0" />
            <span className="truncate">
              <strong className="text-slate-800">From:</strong> {email.sender?.name} ({email.sender?.email})
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
            <span>
              <strong className="text-slate-800">Scheduled:</strong>{' '}
              {new Date(email.scheduledAt).toLocaleString()}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400 shrink-0" />
            <span>
              <strong className="text-slate-800">Status:</strong>{' '}
              <span className="font-semibold uppercase text-xs">{email.status}</span>
              {email.sentAt && ` (Sent: ${new Date(email.sentAt).toLocaleTimeString()})`}
            </span>
          </div>
        </div>

        {/* Error Callout (if failed) */}
        {email.errorMessage && (
          <div className="mx-6 mt-4 p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-3 text-xs text-rose-800">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Delivery Error ({email.attemptsMade} attempts made)</p>
              <p className="font-mono mt-0.5 text-[11px] break-all">{email.errorMessage}</p>
            </div>
          </div>
        )}

        {/* Body content */}
        <div className="p-6 flex-1 overflow-y-auto">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
            Message Body
          </p>
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-800 whitespace-pre-wrap font-sans leading-relaxed">
            {email.body.replace(/<[^>]*>?/gm, '')}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between">
          <span className="text-[11px] text-slate-400 font-mono">
            Idempotency: {email.idempotencyKey.slice(0, 24)}...
          </span>

          <div className="flex items-center gap-2.5">
            {email.previewUrl && (
              <a
                href={email.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-purple-200 bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-medium transition-colors"
              >
                <span>View in Ethereal</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EmailDetailModal;
