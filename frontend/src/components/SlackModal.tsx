import React, { useState } from 'react';
import { X, Hash, CheckCircle2, AlertCircle, ExternalLink, Trash2, Send, Edit3 } from 'lucide-react';
import type { SlackStatus } from '../types';
import api from '../api/client';

interface SlackModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: SlackStatus | null;
  onStatusUpdated: () => void;
}

export const SlackModal: React.FC<SlackModalProps> = ({
  isOpen,
  onClose,
  status,
  onStatusUpdated,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [isEditingChannel, setIsEditingChannel] = useState(false);
  const [channelInput, setChannelInput] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null
  );

  if (!isOpen) return null;

  const handleConnect = async () => {
    setIsLoading(true);
    setFeedback(null);
    try {
      const res = await api.slack.getAuthorizeUrl();
      if (res.authorizeUrl) {
        window.location.href = res.authorizeUrl;
      }
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Failed to initiate Slack authorization flow',
      });
      setIsLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect Slack rate limit notifications?')) return;
    setIsLoading(true);
    setFeedback(null);
    try {
      await api.slack.disconnect();
      setFeedback({ type: 'success', message: 'Slack workspace disconnected successfully' });
      onStatusUpdated();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Failed to disconnect Slack' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveChannel = async () => {
    if (!channelInput.trim()) return;
    setIsLoading(true);
    setFeedback(null);
    try {
      await api.slack.updateChannel(channelInput.trim());
      setFeedback({ type: 'success', message: `Alert channel updated to #${channelInput.trim().replace(/^#/, '')}` });
      setIsEditingChannel(false);
      onStatusUpdated();
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Failed to update channel' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendTest = async () => {
    setIsLoading(true);
    setFeedback(null);
    try {
      const res = await api.slack.sendTest();
      if (res.sent) {
        setFeedback({ type: 'success', message: 'Test alert successfully sent to Slack channel!' });
      } else {
        setFeedback({
          type: 'error',
          message: res.reason || 'Slack notification could not be delivered',
        });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Failed to dispatch test alert' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
              <Hash className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">Slack Integration</h3>
              <p className="text-xs text-slate-500">Hourly sender quota alert dispatch</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {feedback && (
            <div
              className={`p-3.5 rounded-xl text-xs flex items-start gap-2.5 border ${
                feedback.type === 'success'
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : 'bg-rose-50 text-rose-800 border-rose-200'
              }`}
            >
              {feedback.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 mt-0.5" />
              )}
              <span>{feedback.message}</span>
            </div>
          )}

          {status?.connected ? (
            <div className="space-y-4">
              <div className="p-4 bg-emerald-50/50 border border-emerald-200/70 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-emerald-800 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    Workspace Connected
                  </span>
                  <span className="text-xs font-mono font-medium text-slate-700">
                    {status.teamName || 'Slack Workspace'}
                  </span>
                </div>
                <div className="text-xs text-slate-600 pt-1 border-t border-emerald-200/40 flex items-center justify-between">
                  <span>Alert Channel:</span>
                  {isEditingChannel ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={channelInput}
                        onChange={(e) => setChannelInput(e.target.value)}
                        placeholder="channel-name"
                        className="px-2 py-0.5 text-xs font-mono border border-slate-300 rounded bg-white text-slate-800 w-36 focus:outline-emerald-500"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={handleSaveChannel}
                        disabled={isLoading}
                        className="px-2 py-0.5 text-[11px] font-semibold bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsEditingChannel(false)}
                        className="px-1.5 py-0.5 text-[11px] text-slate-500 hover:text-slate-800"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-semibold text-slate-800">
                        #{status.channelName || 'general'}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setChannelInput(status.channelName || '');
                          setIsEditingChannel(true);
                        }}
                        className="text-slate-400 hover:text-slate-600 p-0.5 rounded transition-colors"
                        title="Change channel"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <p className="text-xs text-slate-500 leading-relaxed">
                When any sender reaches their hourly rate limit, ReachInbox automatically posts an
                alert block to your channel with deduplication to prevent notification floods.
              </p>

              <div className="pt-2 flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleSendTest}
                  disabled={isLoading}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-medium shadow-sm transition-colors disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send Test Alert</span>
                </button>

                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-2 border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-xl text-xs font-medium transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Disconnect</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-center py-2">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 mx-auto flex items-center justify-center border border-slate-200">
                <Hash className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-900">Connect Slack for Live Alerts</h4>
                <p className="text-xs text-slate-500 max-w-xs mx-auto mt-1">
                  Receive instant notifications in your Slack channels when outbound sender quotas are
                  reached or throttling is applied.
                </p>
              </div>

              <button
                type="button"
                onClick={handleConnect}
                disabled={isLoading}
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white rounded-xl text-xs font-semibold shadow-md shadow-emerald-700/20 transition-all disabled:opacity-50"
              >
                <span>Connect Slack Workspace</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium rounded-xl transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default SlackModal;
