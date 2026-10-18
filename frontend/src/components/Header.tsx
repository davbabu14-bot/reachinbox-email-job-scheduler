import React from 'react';
import { Search, RefreshCw, X, ShieldCheck } from 'lucide-react';
import type { ViewSection } from '../types';

interface HeaderProps {
  currentView: ViewSection;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
  totalResults?: number;
  isSearching: boolean;
  backendHealth: { postgres: string; redis: string; elasticsearch: string } | null;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  searchQuery,
  onSearchChange,
  onRefresh,
  isLoading,
  totalResults,
  isSearching,
  backendHealth,
}) => {
  const titles: Record<ViewSection, { title: string; subtitle: string }> = {
    all: {
      title: 'All Messages',
      subtitle: 'Complete registry of scheduled, active, and completed email outreach jobs',
    },
    scheduled: {
      title: 'Scheduled Emails',
      subtitle: 'Jobs queued in BullMQ delayed sets awaiting future delivery dispatch',
    },
    sent: {
      title: 'Sent Emails',
      subtitle: 'Successfully delivered emails verified with SMTP transmission receipts',
    },
    failed: {
      title: 'Failed Emails',
      subtitle: 'Jobs that exceeded maximum retry attempts or encountered permanent errors',
    },
  };

  const currentMeta = titles[currentView] || titles.all;
  const isHealthy =
    backendHealth &&
    backendHealth.postgres === 'connected' &&
    backendHealth.redis === 'connected' &&
    backendHealth.elasticsearch === 'connected';

  return (
    <header className="bg-white border-b border-slate-200 px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 sticky top-0 z-10">
      {/* Title & Description */}
      <div>
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">{currentMeta.title}</h2>
          {typeof totalResults === 'number' && (
            <span className="text-xs font-mono font-medium bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-full border border-slate-200">
              {totalResults} {totalResults === 1 ? 'record' : 'records'}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 mt-0.5">{currentMeta.subtitle}</p>
      </div>

      {/* Search Bar & Actions */}
      <div className="flex items-center gap-3">
        {/* Elasticsearch Search Input */}
        <div className="relative min-w-[280px] md:min-w-[340px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search subject, body, recipient..."
            className="w-full bg-slate-50 hover:bg-slate-100/70 focus:bg-white text-slate-900 pl-10 pr-9 py-2 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all placeholder:text-slate-400"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded-md"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {isSearching && (
            <span className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] text-purple-600 font-mono font-medium animate-pulse">
              Elastic...
            </span>
          )}
        </div>

        {/* Refresh Action */}
        <button
          onClick={onRefresh}
          disabled={isLoading}
          title="Refresh emails"
          className="p-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 hover:text-slate-900 active:scale-95 transition-all disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-purple-600' : ''}`} />
        </button>

        {/* Service Health Indicator */}
        <div
          title={`Cluster Health: Postgres (${backendHealth?.postgres || '?'}), Redis (${backendHealth?.redis || '?'}), ES (${backendHealth?.elasticsearch || '?'})`}
          className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-xs text-slate-600 font-mono"
        >
          <ShieldCheck className={`w-3.5 h-3.5 ${isHealthy ? 'text-emerald-500' : 'text-amber-500'}`} />
          <span>{isHealthy ? 'Services Live' : 'Connecting...'}</span>
        </div>
      </div>
    </header>
  );
};

export default Header;
