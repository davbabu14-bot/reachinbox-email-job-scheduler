import React, { useState } from 'react';
import {
  Inbox,
  Clock,
  Send,
  AlertCircle,
  Plus,
  Hash,
  ExternalLink,
  LogOut,
  ChevronUp,
  Radio,
} from 'lucide-react';
import type { User, ViewSection } from '../types';

interface SidebarProps {
  currentView: ViewSection;
  onSelectView: (view: ViewSection) => void;
  onOpenCompose: () => void;
  onOpenSlack: () => void;
  counts: {
    all: number;
    scheduled: number;
    sent: number;
    failed: number;
  };
  currentUser: User | null;
  slackConnected: boolean;
  onLogout: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onSelectView,
  onOpenCompose,
  onOpenSlack,
  counts,
  currentUser,
  slackConnected,
  onLogout,
}) => {
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  const navItems = [
    { id: 'all' as ViewSection, label: 'All Messages', icon: Inbox, count: counts.all, color: 'text-slate-300' },
    { id: 'scheduled' as ViewSection, label: 'Scheduled', icon: Clock, count: counts.scheduled, badgeColor: 'bg-indigo-500/20 text-indigo-300' },
    { id: 'sent' as ViewSection, label: 'Sent', icon: Send, count: counts.sent, badgeColor: 'bg-emerald-500/20 text-emerald-300' },
    { id: 'failed' as ViewSection, label: 'Failed', icon: AlertCircle, count: counts.failed, badgeColor: 'bg-rose-500/20 text-rose-300' },
  ];

  return (
    <aside className="w-64 bg-[#14121f] text-slate-200 flex flex-col h-screen border-r border-[#262338] select-none shrink-0">
      {/* Brand Header */}
      <div className="p-5 pb-4 flex items-center gap-3 border-b border-[#262338]">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-purple-600 via-indigo-600 to-violet-400 flex items-center justify-center font-bold text-white tracking-wider text-sm shadow-md shadow-purple-900/30">
          ONB
        </div>
        <div>
          <h1 className="font-semibold text-white text-base tracking-tight leading-none">ReachInbox</h1>
          <p className="text-[11px] text-slate-400 mt-1 font-mono">Job Scheduler v2</p>
        </div>
      </div>

      {/* Primary Green-Outlined Compose Action */}
      <div className="p-4">
        <button
          onClick={onOpenCompose}
          className="w-full border-2 border-emerald-500 hover:bg-emerald-500/10 active:scale-[0.98] text-emerald-400 transition-all duration-150 py-2.5 px-4 rounded-xl flex items-center justify-center gap-2 font-medium text-sm shadow-sm group"
        >
          <Plus className="w-4 h-4 transition-transform group-hover:rotate-90 duration-200" />
          <span>Compose New Email</span>
        </button>
      </div>

      {/* Main Navigation */}
      <div className="flex-1 px-3 space-y-1 overflow-y-auto">
        <div className="px-3 py-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
          Mailbox
        </div>

        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectView(item.id)}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-purple-600/20 text-purple-200 border border-purple-500/30'
                  : 'text-slate-300 hover:bg-[#1f1b30] hover:text-white'
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon className={`w-4 h-4 ${isActive ? 'text-purple-400' : 'text-slate-400'}`} />
                <span>{item.label}</span>
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-mono font-medium ${
                  item.badgeColor || 'bg-slate-800 text-slate-400'
                }`}
              >
                {item.count}
              </span>
            </button>
          );
        })}

        {/* Integrations & Ops Section */}
        <div className="pt-6 px-3 py-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
          Integrations & Ops
        </div>

        {/* Slack Connection Widget */}
        <button
          onClick={onOpenSlack}
          className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium text-slate-300 hover:bg-[#1f1b30] hover:text-white transition-colors"
        >
          <div className="flex items-center gap-3">
            <Hash className="w-4 h-4 text-emerald-400" />
            <span>Slack Alerts</span>
          </div>
          <span className="flex items-center gap-1.5 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                slackConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
              }`}
            />
            <span className="text-[11px] text-slate-400 font-mono">
              {slackConnected ? 'Active' : 'Connect'}
            </span>
          </span>
        </button>

        {/* Bull Board Queues Link */}
        <a
          href="/admin/queues"
          target="_blank"
          rel="noopener noreferrer"
          className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium text-slate-300 hover:bg-[#1f1b30] hover:text-white transition-colors"
        >
          <div className="flex items-center gap-3">
            <Radio className="w-4 h-4 text-indigo-400" />
            <span>Bull Board</span>
          </div>
          <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
        </a>
      </div>

      {/* User Profile Footer */}
      <div className="p-3 border-t border-[#262338] relative">
        {showProfileMenu && (
          <div className="absolute bottom-16 left-3 right-3 bg-[#1e1a2e] border border-[#342f4c] rounded-xl shadow-xl overflow-hidden py-1 z-20 animate-in fade-in slide-in-from-bottom-2 duration-150">
            <div className="px-3.5 py-2 border-b border-[#2d2944] text-xs">
              <p className="font-medium text-white">{currentUser?.name}</p>
              <p className="text-slate-400 text-[11px] truncate font-mono">{currentUser?.email}</p>
            </div>
            <button
              onClick={() => {
                setShowProfileMenu(false);
                onLogout();
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-rose-300 hover:bg-rose-500/10 transition-colors text-left"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign out</span>
            </button>
          </div>
        )}

        <button
          onClick={() => setShowProfileMenu(!showProfileMenu)}
          className="w-full flex items-center justify-between p-2 rounded-xl hover:bg-[#1f1b30] transition-colors text-left"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {currentUser?.avatarUrl ? (
              <img
                src={currentUser.avatarUrl}
                alt={currentUser.name}
                className="w-8 h-8 rounded-full border border-purple-400/30 object-cover"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-purple-700/60 border border-purple-400/40 flex items-center justify-center font-bold text-xs text-purple-200">
                {currentUser?.name ? currentUser.name.charAt(0).toUpperCase() : 'U'}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-white truncate leading-tight">
                {currentUser?.name || 'Authorized User'}
              </p>
              <p className="text-[11px] text-slate-400 truncate font-mono">
                {currentUser?.email || 'authenticated'}
              </p>
            </div>
          </div>
          <ChevronUp
            className={`w-4 h-4 text-slate-400 transition-transform duration-150 ${
              showProfileMenu ? 'rotate-180' : ''
            }`}
          />
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
