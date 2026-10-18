import { useState, useEffect, useCallback } from 'react';
import type { ViewSection, EmailRecord, User, Sender, SlackStatus } from './types';
import api from './api/client';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import EmailList from './components/EmailList';
import ComposeModal from './components/ComposeModal';
import EmailDetailModal from './components/EmailDetailModal';
import SlackModal from './components/SlackModal';
import LoginScreen from './components/LoginScreen';

export function App() {
  // Auth state
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState<boolean>(false);

  // View & data state
  const [currentView, setCurrentView] = useState<ViewSection>('all');
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0, limit: 20 });

  // Counts
  const [counts, setCounts] = useState({ all: 0, scheduled: 0, sent: 0, failed: 0 });

  // Search
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Modals
  const [isComposeOpen, setIsComposeOpen] = useState<boolean>(false);
  const [isSlackOpen, setIsSlackOpen] = useState<boolean>(false);
  const [selectedEmail, setSelectedEmail] = useState<EmailRecord | null>(null);

  // Integrations & Health
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null);
  const [backendHealth, setBackendHealth] = useState<{
    postgres: string;
    redis: string;
    elasticsearch: string;
  } | null>(null);

  // Notification toast
  const [toast, setToast] = useState<string | null>(null);

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Authenticated User Initialization
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function checkSession() {
      try {
        const res = await api.auth.getCurrentUser();
        if (res.success && res.user) {
          setCurrentUser(res.user);
        }
      } catch {
        // Not authenticated or session expired
        setCurrentUser(null);
      } finally {
        setAuthChecked(true);
      }
    }
    checkSession();
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Fetch Senders, Slack Status, and Health
  // ─────────────────────────────────────────────────────────────────────────────
  const fetchAuxiliaryData = useCallback(async () => {
    if (!currentUser) return;

    try {
      const [sendersRes, slackRes, healthRes] = await Promise.allSettled([
        api.senders.list(),
        api.slack.getStatus(),
        api.health.check(),
      ]);

      if (sendersRes.status === 'fulfilled' && sendersRes.value.success) {
        setSenders(sendersRes.value.senders);
      }

      if (slackRes.status === 'fulfilled' && slackRes.value.success) {
        setSlackStatus(slackRes.value);
      }

      if (healthRes.status === 'fulfilled') {
        setBackendHealth(healthRes.value.services);
      }
    } catch (err) {
      console.warn('Auxiliary data fetch warning:', err);
    }
  }, [currentUser]);

  useEffect(() => {
    if (currentUser) {
      fetchAuxiliaryData();
    }
  }, [currentUser, fetchAuxiliaryData]);

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Fetch Emails & Live Counts (Elasticsearch Search or Postgres List)
  // ─────────────────────────────────────────────────────────────────────────────
  const fetchEmails = useCallback(
    async (page: number = 1) => {
      if (!currentUser) return;
      setIsLoading(true);

      try {
        if (searchQuery.trim()) {
          // Use Elasticsearch search API
          setIsSearching(true);
          const searchStatus = currentView === 'all' ? undefined : (currentView.toUpperCase() as any);
          const res = await api.emails.search({
            query: searchQuery.trim(),
            status: searchStatus,
            page,
            pageSize: 20,
          });

          setEmails(res.results);
          setPagination({
            page: res.page,
            totalPages: res.totalPages,
            total: res.total,
            limit: res.pageSize,
          });
          setIsSearching(false);
        } else {
          // Use authoritative PostgreSQL listing
          const statusParam = currentView === 'all' ? undefined : (currentView.toUpperCase() as any);
          const res = await api.emails.list({
            status: statusParam,
            page,
            limit: 20,
          });

          if (res.success) {
            setEmails(res.items);
            setPagination(res.pagination);
          }
        }

        // Update live counts across all tabs
        const [allC, schedC, sentC, failC] = await Promise.all([
          api.emails.list({ limit: 1 }),
          api.emails.list({ status: 'SCHEDULED', limit: 1 }),
          api.emails.list({ status: 'SENT', limit: 1 }),
          api.emails.list({ status: 'FAILED', limit: 1 }),
        ]);

        setCounts({
          all: allC.pagination?.total || 0,
          scheduled: schedC.pagination?.total || 0,
          sent: sentC.pagination?.total || 0,
          failed: failC.pagination?.total || 0,
        });
      } catch (err: any) {
        console.error('Fetch emails error:', err);
      } finally {
        setIsLoading(false);
      }
    },
    [currentUser, currentView, searchQuery]
  );

  useEffect(() => {
    if (currentUser) {
      fetchEmails(1);
    }
  }, [currentUser, currentView, searchQuery, fetchEmails]);

  // Debounced search trigger
  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
  };

  const handleLogout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // Ignored
    }
    setCurrentUser(null);
    setEmails([]);
  };

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 4000);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-slate-400">
        <div className="flex items-center gap-2.5">
          <span className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-medium">Verifying session...</span>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginScreen
        onLoginSuccess={(user) => {
          setCurrentUser(user);
        }}
      />
    );
  }

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden text-slate-900 font-sans">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-900 text-white px-4 py-3 rounded-xl shadow-2xl border border-slate-800 text-xs font-medium animate-in fade-in slide-in-from-bottom-2 duration-150 flex items-center gap-2">
          <span>{toast}</span>
        </div>
      )}

      {/* Left Sidebar */}
      <Sidebar
        currentView={currentView}
        onSelectView={(v) => {
          setCurrentView(v);
          setSearchQuery('');
        }}
        onOpenCompose={() => setIsComposeOpen(true)}
        onOpenSlack={() => setIsSlackOpen(true)}
        counts={counts}
        currentUser={currentUser}
        slackConnected={slackStatus?.connected || false}
        onLogout={handleLogout}
      />

      {/* Main Mailbox Content */}
      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        <Header
          currentView={currentView}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          onRefresh={() => fetchEmails(pagination.page)}
          isLoading={isLoading}
          totalResults={pagination.total}
          isSearching={isSearching}
          backendHealth={backendHealth}
        />

        <EmailList
          emails={emails}
          isLoading={isLoading}
          onSelectEmail={(email) => setSelectedEmail(email)}
          pagination={pagination}
          onPageChange={(page) => fetchEmails(page)}
        />
      </div>

      {/* Compose Modal */}
      <ComposeModal
        isOpen={isComposeOpen}
        onClose={() => setIsComposeOpen(false)}
        senders={senders}
        onScheduledSuccess={(count) => {
          showToast(`Successfully scheduled ${count} email ${count === 1 ? 'job' : 'jobs'}.`);
          fetchEmails(1);
        }}
      />

      {/* Email Detail Modal */}
      <EmailDetailModal
        email={selectedEmail}
        onClose={() => setSelectedEmail(null)}
      />

      {/* Slack Integration Modal */}
      <SlackModal
        isOpen={isSlackOpen}
        onClose={() => setIsSlackOpen(false)}
        status={slackStatus}
        onStatusUpdated={fetchAuxiliaryData}
      />
    </div>
  );
}

export default App;
