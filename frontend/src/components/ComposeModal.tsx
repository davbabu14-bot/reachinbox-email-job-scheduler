import React, { useState, useRef } from 'react';
import {
  X,
  Upload,
  Sparkles,
  AlertCircle,
  CheckCircle,
  FileText,
  Send,
  Sliders,
  Bold,
  Italic,
  Link2,
  List,
  Paperclip,
} from 'lucide-react';
import type { Sender } from '../types';
import api from '../api/client';

interface ComposeModalProps {
  isOpen: boolean;
  onClose: () => void;
  senders: Sender[];
  onScheduledSuccess: (count: number) => void;
}

export const ComposeModal: React.FC<ComposeModalProps> = ({
  isOpen,
  onClose,
  senders,
  onScheduledSuccess,
}) => {
  const [selectedSenderId, setSelectedSenderId] = useState<string>('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [currentInput, setCurrentInput] = useState<string>('');
  const [subject, setSubject] = useState<string>('');
  const [body, setBody] = useState<string>('');

  // Delivery options
  const [scheduledAt, setScheduledAt] = useState<string>(() => {
    // Default to 5 minutes in future for demonstration
    const d = new Date(Date.now() + 5 * 60 * 1000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  });
  const [delaySeconds, setDelaySeconds] = useState<number>(2);
  const [hourlyLimit, setHourlyLimit] = useState<number>(50);

  // Status & feedback
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadStats, setUploadStats] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [attachments, setAttachments] = useState<{ name: string; size: string }[]>([]);

  if (!isOpen) return null;

  // Initialize selected sender if not chosen
  const effectiveSenderId = selectedSenderId || (senders.length > 0 ? senders[0].id : '');

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Recipient chip addition
  const addRecipient = (email: string) => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    if (!emailRegex.test(trimmed)) {
      setErrorMsg(`"${trimmed}" is not a valid email address.`);
      return;
    }
    if (recipients.includes(trimmed)) {
      setErrorMsg(`"${trimmed}" is already in the recipient list.`);
      return;
    }
    setErrorMsg(null);
    setRecipients([...recipients, trimmed]);
    setCurrentInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addRecipient(currentInput);
    } else if (e.key === 'Backspace' && !currentInput && recipients.length > 0) {
      setRecipients(recipients.slice(0, -1));
    }
  };

  const removeRecipient = (indexToRemove: number) => {
    setRecipients(recipients.filter((_, i) => i !== indexToRemove));
  };

  // CSV / TXT File Upload Handler
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (!content) return;

      // Extract emails using regex across the file
      const matches = content.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi) || [];
      if (matches.length === 0) {
        setErrorMsg('No valid email addresses found in the uploaded file. Please select a CSV or TXT file.');
        setUploadStats(null);
        return;
      }

      const cleaned = matches.map((m) => m.trim().toLowerCase());
      const unique = Array.from(new Set(cleaned));
      const newlyAdded = unique.filter((addr) => !recipients.includes(addr));
      const duplicateCount = cleaned.length - newlyAdded.length;

      if (newlyAdded.length === 0) {
        setUploadStats(`All ${duplicateCount} addresses in the file were already in your recipient list.`);
        return;
      }

      setRecipients((prev) => [...prev, ...newlyAdded]);
      setUploadStats(
        `Added ${newlyAdded.length} recipients (${duplicateCount} duplicate/existing addresses omitted).`
      );
      setErrorMsg(null);
    };

    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Formatting toolbar action
  const applyFormatting = (prefix: string, suffix: string = prefix) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = body.slice(start, end);
    const replacement = `${prefix}${selected || 'text'}${suffix}`;
    const newBody = body.slice(0, start) + replacement + body.slice(end);
    setBody(newBody);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + prefix.length, start + prefix.length + (selected.length || 4));
    }, 0);
  };

  const handleAttachmentUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const newFiles = Array.from(files).map((f) => ({
      name: f.name,
      size: `${(f.size / 1024).toFixed(1)} KB`,
    }));
    setAttachments((prev) => [...prev, ...newFiles]);
    if (attachmentInputRef.current) attachmentInputRef.current.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  // Form Submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    // If there is pending text in recipient input, add it first
    let allRecipients = [...recipients];
    if (currentInput.trim()) {
      const trimmed = currentInput.trim().toLowerCase();
      if (emailRegex.test(trimmed) && !allRecipients.includes(trimmed)) {
        allRecipients.push(trimmed);
        setRecipients(allRecipients);
        setCurrentInput('');
      }
    }

    if (allRecipients.length === 0) {
      setErrorMsg('Please specify at least one recipient email.');
      return;
    }

    if (!subject.trim()) {
      setErrorMsg('Please enter an email subject.');
      return;
    }

    if (!body.trim()) {
      setErrorMsg('Please enter an email body.');
      return;
    }

    setIsSubmitting(true);

    try {
      const scheduledDate = new Date(scheduledAt);

      if (allRecipients.length === 1) {
        // Single recipient
        await api.emails.scheduleSingle({
          recipient: allRecipients[0],
          subject: subject.trim(),
          body: body.trim(),
          scheduledAt: scheduledDate.toISOString(),
          senderId: effectiveSenderId || undefined,
        });
        onScheduledSuccess(1);
      } else {
        // Bulk recipients
        await api.emails.scheduleBulk({
          recipients: allRecipients,
          subject: subject.trim(),
          body: body.trim(),
          startTime: scheduledDate.toISOString(),
          delayBetweenSeconds: delaySeconds,
          senderId: effectiveSenderId || undefined,
        });
        onScheduledSuccess(allRecipients.length);
      }

      onClose();
    } catch (err: any) {
      console.error('Scheduling error:', err);
      setErrorMsg(err.message || 'Failed to schedule email job');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Preset time helpers
  const setPresetTime = (minutesAhead: number) => {
    const d = new Date(Date.now() + minutesAhead * 60 * 1000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    setScheduledAt(d.toISOString().slice(0, 16));
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[92vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">Compose New Email</h3>
              <p className="text-xs text-slate-500">Configure delivery schedule and throttling</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
          {errorMsg && (
            <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-xs text-rose-800 animate-in fade-in">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {uploadStats && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-2 text-xs text-emerald-800">
              <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <span>{uploadStats}</span>
            </div>
          )}

          {/* From: Sender Dropdown */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">From Sender</label>
            <select
              value={effectiveSenderId}
              onChange={(e) => setSelectedSenderId(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
            >
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.email}) — Limit: {s.hourlyLimit || 50}/hr
                </option>
              ))}
            </select>
          </div>

          {/* To: Recipients Chips Input & File Upload */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-slate-700">
                To Recipients {recipients.length > 0 && `(${recipients.length})`}
              </label>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-800 font-medium transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload CSV / TXT</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt"
                onChange={handleFileUpload}
                className="hidden"
              />
            </div>

            <div className="min-h-[46px] p-2 bg-slate-50 border border-slate-200 rounded-xl flex flex-wrap items-center gap-1.5 focus-within:ring-2 focus-within:ring-purple-500/20 focus-within:border-purple-500 focus-within:bg-white transition-all">
              {recipients.map((email, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs bg-purple-50 text-purple-800 border border-purple-200 font-mono"
                >
                  <span>{email}</span>
                  <button
                    type="button"
                    onClick={() => removeRecipient(idx)}
                    className="hover:text-purple-950 p-0.5 rounded"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}

              <input
                type="email"
                value={currentInput}
                onChange={(e) => setCurrentInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={() => {
                  if (currentInput) addRecipient(currentInput);
                }}
                placeholder={recipients.length === 0 ? 'Type email and press Enter or comma...' : 'Add more...'}
                className="flex-1 min-w-[200px] bg-transparent text-sm text-slate-900 focus:outline-none placeholder:text-slate-400 px-1 py-0.5"
              />
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Separate multiple recipients with commas, spaces, or upload a CSV file with an email column.
            </p>
          </div>

          {/* Subject */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Catching up regarding Q4 engineering goals"
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
            />
          </div>

          {/* Body */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-slate-700">Message Body</label>
              <div className="flex items-center gap-1 text-[11px] text-slate-400">
                <FileText className="w-3.5 h-3.5" />
                <span>Text / Markdown supported</span>
              </div>
            </div>

            <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50 focus-within:border-purple-500 focus-within:ring-2 focus-within:ring-purple-500/20 transition-all">
              {/* Rich-Text Toolbar */}
              <div className="px-3 py-1.5 bg-slate-100/80 border-b border-slate-200 flex items-center justify-between text-slate-600 text-xs">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => applyFormatting('**', '**')}
                    title="Bold"
                    className="p-1.5 rounded hover:bg-slate-200/70 text-slate-700 hover:text-slate-900 transition-colors"
                  >
                    <Bold className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => applyFormatting('*', '*')}
                    title="Italic"
                    className="p-1.5 rounded hover:bg-slate-200/70 text-slate-700 hover:text-slate-900 transition-colors"
                  >
                    <Italic className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => applyFormatting('[', '](https://example.com)')}
                    title="Insert Link"
                    className="p-1.5 rounded hover:bg-slate-200/70 text-slate-700 hover:text-slate-900 transition-colors"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => applyFormatting('\n- ', '')}
                    title="Bullet List"
                    className="p-1.5 rounded hover:bg-slate-200/70 text-slate-700 hover:text-slate-900 transition-colors"
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => attachmentInputRef.current?.click()}
                    title="Add attachment"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-200/70 text-slate-600 hover:text-slate-800 text-[11px] font-medium transition-colors"
                  >
                    <Paperclip className="w-3.5 h-3.5" />
                    <span>Attach File</span>
                  </button>
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    multiple
                    onChange={handleAttachmentUpload}
                    className="hidden"
                  />
                </div>
              </div>

              <textarea
                ref={textareaRef}
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={'Hi there,\n\nI wanted to follow up on our previous conversation regarding the email scheduler platform...'}
                className="w-full bg-transparent p-3.5 text-sm text-slate-900 focus:outline-none font-sans leading-relaxed resize-none"
              />

              {/* Attachments list */}
              {attachments.length > 0 && (
                <div className="px-3 pb-2.5 pt-1 flex flex-wrap gap-1.5 border-t border-slate-200/60 bg-white">
                  {attachments.map((att, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-slate-100 text-slate-700 border border-slate-200"
                    >
                      <Paperclip className="w-3 h-3 text-slate-400" />
                      <span className="font-mono text-[11px] truncate max-w-[160px]">{att.name}</span>
                      <span className="text-[10px] text-slate-400">({att.size})</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(i)}
                        className="text-slate-400 hover:text-slate-600 p-0.5 rounded"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Scheduling & Rate Limits Box */}
          <div className="p-4 bg-slate-50/80 border border-slate-200 rounded-xl space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
              <Sliders className="w-4 h-4 text-purple-600" />
              <span>Delivery Timing & Throttling Parameters</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
              {/* Start Date & Time */}
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Start Delivery At
                </label>
                <div className="relative">
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
                  />
                </div>
                {/* Presets */}
                <div className="flex items-center gap-1.5 mt-1.5 text-[10px]">
                  <button
                    type="button"
                    onClick={() => setPresetTime(0)}
                    className="px-2 py-0.5 rounded bg-white border border-slate-200 hover:bg-slate-100 text-slate-600"
                  >
                    Send now
                  </button>
                  <button
                    type="button"
                    onClick={() => setPresetTime(15)}
                    className="px-2 py-0.5 rounded bg-white border border-slate-200 hover:bg-slate-100 text-slate-600"
                  >
                    +15m
                  </button>
                  <button
                    type="button"
                    onClick={() => setPresetTime(60)}
                    className="px-2 py-0.5 rounded bg-white border border-slate-200 hover:bg-slate-100 text-slate-600"
                  >
                    +1hr
                  </button>
                  <button
                    type="button"
                    onClick={() => setPresetTime(1440)}
                    className="px-2 py-0.5 rounded bg-white border border-slate-200 hover:bg-slate-100 text-slate-600"
                  >
                    Tomorrow
                  </button>
                </div>
              </div>

              {/* Inter-email Delay & Quota */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Spacing (sec)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={600}
                    value={delaySeconds}
                    onChange={(e) => setDelaySeconds(Math.max(0, Number(e.target.value)))}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-purple-500/20 font-mono"
                  />
                  <p className="text-[10px] text-slate-400 mt-1">Min gap between sends</p>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Hourly Limit
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={hourlyLimit}
                    onChange={(e) => setHourlyLimit(Math.max(1, Number(e.target.value)))}
                    className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-purple-500/20 font-mono"
                  />
                  <p className="text-[10px] text-slate-400 mt-1">Sender hourly cap</p>
                </div>
              </div>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="pt-2 flex items-center justify-between border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-800 transition-colors"
            >
              Discard
            </button>

            <button
              type="submit"
              disabled={isSubmitting}
              className="bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white px-5 py-2.5 rounded-xl font-medium text-xs shadow-md shadow-emerald-700/20 flex items-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Enqueuing...</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>
                    Schedule {recipients.length > 1 ? `(${recipients.length} Emails)` : 'Delivery'}
                  </span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ComposeModal;
