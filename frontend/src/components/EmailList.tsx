import React from 'react';
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Mail,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import type { EmailRecord, EmailStatus } from '../types';

interface EmailListProps {
  emails: EmailRecord[];
  isLoading: boolean;
  onSelectEmail: (email: EmailRecord) => void;
  pagination: {
    page: number;
    totalPages: number;
    total: number;
    limit: number;
  };
  onPageChange: (newPage: number) => void;
}

export const EmailList: React.FC<EmailListProps> = ({
  emails,
  isLoading,
  onSelectEmail,
  pagination,
  onPageChange,
}) => {
  const getStatusBadge = (status: EmailStatus) => {
    switch (status) {
      case 'SCHEDULED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
            <Clock className="w-3 h-3 text-blue-500" />
            <span>Scheduled</span>
          </span>
        );
      case 'PROCESSING':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping" />
            <span>Processing</span>
          </span>
        );
      case 'SENT':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
            <span>Sent</span>
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">
            <AlertTriangle className="w-3 h-3 text-rose-500" />
            <span>Failed</span>
          </span>
        );
    }
  };

  const formatTimestamp = (dateStr?: string | null) => {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return dateStr;
    }
  };

  // Strip HTML tags for clean snippet preview
  const stripHtml = (html?: string) => {
    if (!html) return '';
    return html.replace(/<[^>]*>?/gm, '').trim();
  };

  if (isLoading && emails.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-slate-400">
        <Loader2 className="w-8 h-8 animate-spin text-purple-600 mb-3" />
        <p className="text-sm font-medium text-slate-600">Loading mailbox records...</p>
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-16 text-center">
        <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 mb-4 border border-slate-200">
          <Mail className="w-6 h-6" />
        </div>
        <h3 className="text-base font-semibold text-slate-800">No email records found</h3>
        <p className="text-sm text-slate-500 max-w-sm mt-1">
          There are no messages matching the current mailbox view or search parameters.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden">
      {/* Table Header */}
      <div className="grid grid-cols-12 gap-4 px-6 py-3 border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold tracking-wider text-slate-500 uppercase select-none">
        <div className="col-span-3">Recipient</div>
        <div className="col-span-5">Subject & Snippet</div>
        <div className="col-span-2 text-center">Status</div>
        <div className="col-span-2 text-right">Scheduled / Sent Time</div>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
        {emails.map((email) => {
          const plainSnippet = stripHtml(email.body);
          const displayDate = email.status === 'SENT' ? email.sentAt : email.scheduledAt;

          return (
            <div
              key={email.id}
              onClick={() => onSelectEmail(email)}
              className="grid grid-cols-12 gap-4 px-6 py-3.5 items-center hover:bg-purple-50/30 transition-colors cursor-pointer group"
            >
              {/* Recipient */}
              <div className="col-span-3 min-w-0 pr-2">
                <p className="text-sm font-semibold text-slate-900 truncate group-hover:text-purple-900">
                  {email.recipient}
                </p>
                {email.sender && (
                  <p className="text-[11px] text-slate-400 truncate font-mono">
                    via {email.sender.name || email.sender.email}
                  </p>
                )}
              </div>

              {/* Subject & Preview */}
              <div className="col-span-5 min-w-0 pr-4">
                <p className="text-sm font-medium text-slate-800 truncate">
                  {email.subject || '(No subject)'}
                  <span className="font-normal text-slate-400 ml-2">
                    — {plainSnippet.slice(0, 80) || 'Empty message content'}
                  </span>
                </p>
                {email.previewUrl && (
                  <a
                    href={email.previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 text-[11px] text-purple-600 hover:text-purple-800 hover:underline mt-0.5 font-mono"
                  >
                    <span>Ethereal Preview</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                )}
              </div>

              {/* Status Badge */}
              <div className="col-span-2 flex justify-center">
                {getStatusBadge(email.status)}
              </div>

              {/* Timestamp */}
              <div className="col-span-2 text-right">
                <span className="text-xs text-slate-500 font-mono">
                  {formatTimestamp(displayDate)}
                </span>
                {email.attemptsMade > 1 && (
                  <p className="text-[10px] text-amber-600 font-mono">
                    Attempt {email.attemptsMade}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination Footer */}
      <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between text-xs text-slate-600">
        <div>
          Showing page <span className="font-semibold text-slate-900">{pagination.page}</span> of{' '}
          <span className="font-semibold text-slate-900">{pagination.totalPages || 1}</span> ({pagination.total} total)
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onPageChange(pagination.page - 1)}
            disabled={pagination.page <= 1 || isLoading}
            className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed text-slate-700"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="px-2 font-mono font-medium">{pagination.page}</span>
          <button
            onClick={() => onPageChange(pagination.page + 1)}
            disabled={pagination.page >= pagination.totalPages || isLoading}
            className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed text-slate-700"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default EmailList;
