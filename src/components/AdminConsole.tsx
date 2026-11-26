import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Lock,
  LogOut,
  Radio,
  RefreshCw,
  Save,
  Send,
  Settings,
  Webhook,
} from 'lucide-react';
import {
  AdProvider,
  extractCleanAdsPlacementId,
  testCleanAdsPlacement,
} from '../lib/adNetworks';

interface AdminStats {
  totalUsers: number;
  totalVideos: number;
  activeToday: number;
}

interface AdminSettings {
  site_name: string;
  watermark_text: string;
  watermark_enabled: boolean;
  reward_ad_enabled: boolean;
  ad_provider: AdProvider;
  adsgram_block_id: string;
  monetag_zone_id: string;
  richads_pub_id: string;
  gigapub_id: string;
  cleanads_rewarded_enabled: boolean;
  cleanads_rewarded_placement_id: string;
  cleanads_interstitial_enabled: boolean;
  cleanads_interstitial_placement_id: string;
  cleanads_test_mode: boolean;
  bot_token_configured: boolean;
  bot_token_masked: string;
}

interface AdminConsoleProps {
  onExitToApp: () => void;
  onConfigUpdated: () => void;
}

type AdminTab = 'dashboard' | 'settings' | 'broadcast';

const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  site_name: 'ReelCraft',
  watermark_text: 'ReelCraft',
  watermark_enabled: true,
  reward_ad_enabled: false,
  ad_provider: 'adsgram',
  adsgram_block_id: '',
  monetag_zone_id: '',
  richads_pub_id: '',
  gigapub_id: '',
  cleanads_rewarded_enabled: false,
  cleanads_rewarded_placement_id: '',
  cleanads_interstitial_enabled: false,
  cleanads_interstitial_placement_id: '',
  cleanads_test_mode: false,
  bot_token_configured: false,
  bot_token_masked: '',
};

export function AdminConsole({ onExitToApp, onConfigUpdated }: AdminConsoleProps) {
  // Bearer token is stored strictly in React memory — never in localStorage or sessionStorage
  const [token, setToken] = useState<string | null>(null);
  const [authStatusLoading, setAuthStatusLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [envControlled, setEnvControlled] = useState(false);

  const [passwordInput, setPasswordInput] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');
  const [stats, setStats] = useState<AdminStats>({ totalUsers: 0, totalVideos: 0, activeToday: 0 });
  const [statsLoading, setStatsLoading] = useState(false);

  const [settings, setSettings] = useState<AdminSettings>(DEFAULT_ADMIN_SETTINGS);
  const [newBotToken, setNewBotToken] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [webhookLoading, setWebhookLoading] = useState(false);
  const [webhookMsg, setWebhookMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testingCleanAds, setTestingCleanAds] = useState<'rewarded' | 'interstitial' | null>(null);
  const [cleanAdsTestMsg, setCleanAdsTestMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastProgress, setBroadcastProgress] = useState({
    sent: 0,
    failed: 0,
    processed: 0,
    total: 0,
    done: false,
  });
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const stopBroadcastRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/auth', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { needsSetup?: boolean; envControlled?: boolean }) => {
        if (cancelled) return;
        setNeedsSetup(Boolean(data.needsSetup));
        setEnvControlled(Boolean(data.envControlled));
      })
      .catch(() => {
        if (!cancelled) setAuthError('Could not reach admin API.');
      })
      .finally(() => {
        if (!cancelled) setAuthStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const authHeaders = useCallback(
    (bearer: string) => ({
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    }),
    []
  );

  const loadDashboardData = useCallback(
    async (bearer: string) => {
      setStatsLoading(true);
      try {
        const [statsRes, settingsRes] = await Promise.all([
          fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${bearer}` } }),
          fetch('/api/admin/settings', { headers: { Authorization: `Bearer ${bearer}` } }),
        ]);

        if (statsRes.status === 401 || settingsRes.status === 401) {
          setToken(null);
          setAuthError('Session expired. Please sign in again.');
          return;
        }

        if (statsRes.ok) {
          const sData = (await statsRes.json()) as AdminStats;
          setStats(sData);
        }
        if (settingsRes.ok) {
          const cfgData = (await settingsRes.json()) as AdminSettings;
          setSettings(cfgData);
        }
      } finally {
        setStatsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (token) {
      loadDashboardData(token);
    }
  }, [token, loadDashboardData]);

  const handleAuthSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    if (needsSetup) {
      if (passwordInput.trim().length < 8) {
        setAuthError('Password must be at least 8 characters.');
        return;
      }
      if (passwordInput !== confirmPassword) {
        setAuthError('Passwords do not match.');
        return;
      }
    }

    setAuthSubmitting(true);
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: needsSetup ? 'bootstrap' : 'login',
          password: passwordInput,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        token?: string;
        error?: string;
      };
      if (!res.ok || !data.token) {
        setAuthError(data.error || 'Authentication failed.');
        return;
      }
      setNeedsSetup(false);
      setPasswordInput('');
      setConfirmPassword('');
      setToken(data.token);
    } catch {
      setAuthError('Network error while signing in.');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setSavingSettings(true);
    setSettingsMsg(null);
    try {
      const payload: Record<string, unknown> = {
        site_name: settings.site_name,
        watermark_text: settings.watermark_text,
        watermark_enabled: settings.watermark_enabled,
        reward_ad_enabled: settings.reward_ad_enabled,
        ad_provider: settings.ad_provider,
        adsgram_block_id: settings.adsgram_block_id,
        monetag_zone_id: settings.monetag_zone_id,
        richads_pub_id: settings.richads_pub_id,
        gigapub_id: settings.gigapub_id,
        cleanads_rewarded_enabled: settings.cleanads_rewarded_enabled,
        cleanads_rewarded_placement_id: extractCleanAdsPlacementId(
          settings.cleanads_rewarded_placement_id
        ),
        cleanads_interstitial_enabled: settings.cleanads_interstitial_enabled,
        cleanads_interstitial_placement_id: extractCleanAdsPlacementId(
          settings.cleanads_interstitial_placement_id
        ),
        cleanads_test_mode: settings.cleanads_test_mode,
      };
      if (newBotToken.trim()) {
        payload.bot_token = newBotToken.trim();
      }

      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSettingsMsg({ ok: false, text: data.error || 'Could not save settings.' });
        return;
      }
      setNewBotToken('');
      setSettingsMsg({ ok: true, text: 'Settings saved to database.' });
      await loadDashboardData(token);
      onConfigUpdated();
    } catch {
      setSettingsMsg({ ok: false, text: 'Network error while saving settings.' });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRegisterWebhook = async () => {
    if (!token) return;
    setWebhookLoading(true);
    setWebhookMsg(null);
    try {
      const res = await fetch('/api/admin/webhook', {
        method: 'POST',
        headers: authHeaders(token),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        webhookUrl?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setWebhookMsg({ ok: false, text: data.error || 'Webhook registration failed.' });
        return;
      }
      setWebhookMsg({
        ok: true,
        text: `Webhook active at ${data.webhookUrl}`,
      });
    } catch {
      setWebhookMsg({ ok: false, text: 'Network error while setting webhook.' });
    } finally {
      setWebhookLoading(false);
    }
  };

  const handleTestCleanAds = async (kind: 'rewarded' | 'interstitial') => {
    setTestingCleanAds(kind);
    setCleanAdsTestMsg(null);
    try {
      const placementId =
        kind === 'rewarded'
          ? settings.cleanads_rewarded_placement_id
          : settings.cleanads_interstitial_placement_id;
      const res = await testCleanAdsPlacement(
        placementId,
        settings.cleanads_test_mode,
        kind === 'rewarded'
      );
      setCleanAdsTestMsg({ ok: res.ok, text: res.message });
    } finally {
      setTestingCleanAds(null);
    }
  };

  const handleStartBroadcast = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !broadcastMessage.trim()) return;

    stopBroadcastRef.current = false;
    setBroadcasting(true);
    setBroadcastError(null);
    setBroadcastProgress({ sent: 0, failed: 0, processed: 0, total: 0, done: false });

    let offset = 0;
    let totalSent = 0;
    let totalFailed = 0;
    let totalProcessed = 0;
    let grandTotal = 0;

    try {
      while (!stopBroadcastRef.current) {
        const res = await fetch('/api/admin/broadcast', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ message: broadcastMessage.trim(), offset }),
        });

        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          sent?: number;
          failed?: number;
          processed?: number;
          total?: number;
          nextOffset?: number;
          done?: boolean;
          error?: string;
        };

        if (!res.ok || !data.ok) {
          setBroadcastError(data.error || 'Broadcast interrupted.');
          break;
        }

        totalSent += data.sent || 0;
        totalFailed += data.failed || 0;
        totalProcessed += data.processed || 0;
        grandTotal = data.total || totalProcessed;
        offset = data.nextOffset ?? offset + 25;

        setBroadcastProgress({
          sent: totalSent,
          failed: totalFailed,
          processed: totalProcessed,
          total: grandTotal,
          done: Boolean(data.done),
        });

        if (data.done) break;
        // Brief pause between 25-user batches to respect Telegram API limits
        await new Promise((r) => setTimeout(r, 350));
      }
    } catch {
      setBroadcastError('Network error during broadcast.');
    } finally {
      setBroadcasting(false);
    }
  };

  if (authStatusLoading) {
    return (
      <div className="min-h-screen bg-[#08080A] text-zinc-100 flex items-center justify-center p-6">
        <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
      </div>
    );
  }

  // Password Gate / First-Run Setup Form
  if (!token) {
    return (
      <div className="min-h-screen bg-[#08080A] text-zinc-100 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl bg-[#111114] border border-white/10 p-6 space-y-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-zinc-400 text-xs font-mono">
              <Lock className="w-3.5 h-3.5" />
              <span>Admin Console</span>
            </div>
            <h1 className="text-xl font-bold text-white">
              {needsSetup ? 'Set Admin Password' : 'Sign In'}
            </h1>
            <p className="text-xs text-zinc-400 leading-relaxed">
              {needsSetup
                ? 'First-run setup: create an admin password (or set ADMIN_PASSWORD in Cloudflare Pages Secrets).'
                : envControlled
                ? 'Enter your ADMIN_PASSWORD environment secret to manage ReelCraft.'
                : 'Enter your admin password to access stats, settings, and broadcasts.'}
            </p>
          </div>

          <form onSubmit={handleAuthSubmit} className="space-y-3.5">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-zinc-400">
                {needsSetup ? 'New Admin Password (min 8 chars)' : 'Password'}
              </span>
              <input
                type="password"
                autoComplete={needsSetup ? 'new-password' : 'current-password'}
                required
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                className="w-full min-h-[46px] px-3.5 py-2.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white focus:outline-none focus:border-white/40"
              />
            </label>

            {needsSetup && (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-zinc-400">Confirm Password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full min-h-[46px] px-3.5 py-2.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white focus:outline-none focus:border-white/40"
                />
              </label>
            )}

            {authError && (
              <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
                {authError}
              </p>
            )}

            <button
              type="submit"
              disabled={authSubmitting}
              className="min-h-[46px] w-full px-4 py-2.5 text-sm font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 disabled:opacity-50 flex items-center justify-center gap-2 transition"
            >
              {authSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{needsSetup ? 'Save & Open Console' : 'Unlock Console'}</span>
            </button>
          </form>

          <button
            type="button"
            onClick={onExitToApp}
            className="w-full min-h-[40px] text-xs text-zinc-400 hover:text-white flex items-center justify-center gap-1.5 transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Return to Studio</span>
          </button>
        </div>
      </div>
    );
  }

  const broadcastPct =
    broadcastProgress.total > 0
      ? Math.min(100, Math.round((broadcastProgress.processed / broadcastProgress.total) * 100))
      : broadcastProgress.done
      ? 100
      : 0;

  return (
    <div className="min-h-screen bg-[#08080A] text-zinc-100">
      <header className="border-b border-white/10 bg-[#08080A]/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-6">
          <span className="text-sm font-bold tracking-tight text-white whitespace-nowrap shrink-0">
            ReelCraft Admin
          </span>

          <nav className="flex items-center gap-1 bg-white/[0.04] p-1 rounded-xl border border-white/10">
            <button
              type="button"
              onClick={() => setActiveTab('dashboard')}
              className={`min-h-[34px] px-3 py-1 text-xs font-semibold rounded-lg whitespace-nowrap transition ${
                activeTab === 'dashboard' ? 'bg-white text-[#08080A]' : 'text-zinc-400 hover:text-white'
              }`}
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              className={`min-h-[34px] px-3 py-1 text-xs font-semibold rounded-lg whitespace-nowrap transition ${
                activeTab === 'settings' ? 'bg-white text-[#08080A]' : 'text-zinc-400 hover:text-white'
              }`}
            >
              Settings
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('broadcast')}
              className={`min-h-[34px] px-3 py-1 text-xs font-semibold rounded-lg whitespace-nowrap transition ${
                activeTab === 'broadcast' ? 'bg-white text-[#08080A]' : 'text-zinc-400 hover:text-white'
              }`}
            >
              Broadcast
            </button>
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onExitToApp}
              className="min-h-[36px] px-3 text-xs font-medium text-zinc-400 hover:text-white whitespace-nowrap"
            >
              Studio
            </button>
            <button
              type="button"
              onClick={() => setToken(null)}
              aria-label="Sign out"
              className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-white/[0.06] border border-white/10 text-zinc-300 hover:text-white"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <section className="space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold text-white">Overview</h1>
                <p className="text-xs text-zinc-400 mt-0.5">Live metrics from Cloudflare D1.</p>
              </div>
              <button
                type="button"
                onClick={() => loadDashboardData(token)}
                disabled={statsLoading}
                className="min-h-[42px] px-3.5 py-2 text-xs font-medium rounded-xl bg-white/[0.06] border border-white/10 text-zinc-200 hover:text-white flex items-center gap-1.5 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${statsLoading ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="rounded-2xl bg-[#111114] border border-white/10 p-5">
                <p className="text-xs text-zinc-400">Total Users</p>
                <p className="mt-2 text-3xl font-bold font-mono tabular-nums text-white">
                  {stats.totalUsers.toLocaleString()}
                </p>
              </div>
              <div className="rounded-2xl bg-[#111114] border border-white/10 p-5">
                <p className="text-xs text-zinc-400">Total Videos Exported</p>
                <p className="mt-2 text-3xl font-bold font-mono tabular-nums text-white">
                  {stats.totalVideos.toLocaleString()}
                </p>
              </div>
              <div className="rounded-2xl bg-[#111114] border border-white/10 p-5">
                <p className="text-xs text-zinc-400">Active Today (24h)</p>
                <p className="mt-2 text-3xl font-bold font-mono tabular-nums text-white">
                  {stats.activeToday.toLocaleString()}
                </p>
              </div>
            </div>

            <div className="rounded-2xl bg-[#111114] border border-white/10 p-5 flex flex-wrap items-center justify-between gap-4 text-xs text-zinc-400">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-zinc-300" />
                <span>
                  Bot Token: <strong className="text-zinc-200">{settings.bot_token_configured ? settings.bot_token_masked : 'Not configured'}</strong> ·
                  Ad Gate: <strong className="text-zinc-200">
                    {settings.cleanads_rewarded_enabled && settings.reward_ad_enabled
                      ? `CleanAds + ${settings.ad_provider}`
                      : settings.cleanads_rewarded_enabled
                      ? 'CleanAds'
                      : settings.reward_ad_enabled
                      ? settings.ad_provider
                      : 'Disabled'}
                  </strong>
                  {settings.cleanads_interstitial_enabled ? ' · CleanAds Interstitial On' : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                className="text-white font-semibold hover:underline"
              >
                Configure Settings
              </button>
            </div>
          </section>
        )}

        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <form onSubmit={handleSaveSettings} className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                  <Settings className="w-5 h-5 text-zinc-400" />
                  <span>App, Bot &amp; Ad Settings</span>
                </h1>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Stored in Cloudflare D1 <code className="font-mono text-zinc-300">app_settings</code> table.
                </p>
              </div>

              <button
                type="submit"
                disabled={savingSettings}
                className="min-h-[44px] px-5 py-2 text-xs font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 disabled:opacity-50 flex items-center gap-2 transition"
              >
                {savingSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                <span>Save Settings</span>
              </button>
            </div>

            {settingsMsg && (
              <p
                className={`text-xs px-4 py-3 rounded-xl border ${
                  settingsMsg.ok
                    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                    : 'bg-red-500/10 border-red-500/25 text-red-200'
                }`}
              >
                {settingsMsg.text}
              </p>
            )}

            <div className="grid md:grid-cols-2 gap-6">
              {/* Branding & Watermark */}
              <div className="rounded-2xl bg-[#111114] border border-white/10 p-5 space-y-4">
                <h2 className="text-sm font-semibold text-white">Branding &amp; Watermark</h2>

                <label className="block space-y-1.5">
                  <span className="text-xs text-zinc-400">Site / Mini App Name</span>
                  <input
                    type="text"
                    value={settings.site_name}
                    onChange={(e) => setSettings((s) => ({ ...s, site_name: e.target.value }))}
                    className="w-full min-h-[44px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white focus:outline-none focus:border-white/40"
                  />
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs text-zinc-400">Watermark Text</span>
                  <input
                    type="text"
                    value={settings.watermark_text}
                    onChange={(e) => setSettings((s) => ({ ...s, watermark_text: e.target.value }))}
                    className="w-full min-h-[44px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white focus:outline-none focus:border-white/40"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 pt-1 cursor-pointer">
                  <span className="text-xs font-medium text-zinc-200">Show Watermark on Exported Videos</span>
                  <input
                    type="checkbox"
                    checked={settings.watermark_enabled}
                    onChange={(e) => setSettings((s) => ({ ...s, watermark_enabled: e.target.checked }))}
                    className="h-5 w-5 accent-white rounded"
                  />
                </label>
              </div>

              {/* Telegram Bot & One-Click Webhook */}
              <div className="rounded-2xl bg-[#111114] border border-white/10 p-5 space-y-4">
                <h2 className="text-sm font-semibold text-white">Telegram Bot Integration</h2>

                <label className="block space-y-1.5">
                  <span className="text-xs text-zinc-400">
                    Bot Token {settings.bot_token_configured ? `(Active: ${settings.bot_token_masked})` : '(Not Set)'}
                  </span>
                  <input
                    type="password"
                    value={newBotToken}
                    onChange={(e) => setNewBotToken(e.target.value)}
                    placeholder="Paste new @BotFather token to update"
                    className="w-full min-h-[44px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                  />
                </label>

                <div className="pt-2 border-t border-white/10 space-y-3">
                  <button
                    type="button"
                    onClick={handleRegisterWebhook}
                    disabled={webhookLoading}
                    className="min-h-[44px] w-full px-4 py-2 text-xs font-semibold rounded-xl bg-white/[0.08] border border-white/15 text-white hover:bg-white/[0.14] disabled:opacity-50 flex items-center justify-center gap-2 transition"
                  >
                    {webhookLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Webhook className="w-4 h-4" />}
                    <span>One-Click Register Telegram Webhook</span>
                  </button>

                  {webhookMsg && (
                    <p
                      className={`text-xs px-3 py-2 rounded-lg border ${
                        webhookMsg.ok
                          ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                          : 'bg-red-500/10 border-red-500/25 text-red-200'
                      }`}
                    >
                      {webhookMsg.text}
                    </p>
                  )}
                </div>
              </div>

              {/* Multi-Network Rewarded Ad Settings */}
              <div className="md:col-span-2 rounded-2xl bg-[#111114] border border-white/10 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-white">Rewarded Ad Networks</h2>
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <span className="text-xs text-zinc-300">Enable Ad-Gated HD Export</span>
                    <input
                      type="checkbox"
                      checked={settings.reward_ad_enabled}
                      onChange={(e) => setSettings((s) => ({ ...s, reward_ad_enabled: e.target.checked }))}
                      className="h-5 w-5 accent-white rounded"
                    />
                  </label>
                </div>

                <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
                  <label className="block space-y-1.5">
                    <span className="text-xs text-zinc-400">Active Provider</span>
                    <select
                      value={settings.ad_provider}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, ad_provider: e.target.value as AdProvider }))
                      }
                      className="w-full min-h-[44px] px-3 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white focus:outline-none focus:border-white/40"
                    >
                      <option value="adsgram">AdsGram</option>
                      <option value="monetag">Monetag</option>
                      <option value="richads">RichAds</option>
                      <option value="gigapub">GigaPub</option>
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs text-zinc-400">AdsGram Block ID</span>
                    <input
                      type="text"
                      value={settings.adsgram_block_id}
                      onChange={(e) => setSettings((s) => ({ ...s, adsgram_block_id: e.target.value }))}
                      placeholder="int-1234"
                      className="w-full min-h-[44px] px-3 text-sm font-mono rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                    />
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs text-zinc-400">Monetag Zone ID</span>
                    <input
                      type="text"
                      value={settings.monetag_zone_id}
                      onChange={(e) => setSettings((s) => ({ ...s, monetag_zone_id: e.target.value }))}
                      placeholder="9876543"
                      className="w-full min-h-[44px] px-3 text-sm font-mono rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                    />
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs text-zinc-400">RichAds Pub ID</span>
                    <input
                      type="text"
                      value={settings.richads_pub_id}
                      onChange={(e) => setSettings((s) => ({ ...s, richads_pub_id: e.target.value }))}
                      placeholder="pub_id"
                      className="w-full min-h-[44px] px-3 text-sm font-mono rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                    />
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs text-zinc-400">GigaPub ID</span>
                    <input
                      type="text"
                      value={settings.gigapub_id}
                      onChange={(e) => setSettings((s) => ({ ...s, gigapub_id: e.target.value }))}
                      placeholder="giga_id"
                      className="w-full min-h-[44px] px-3 text-sm font-mono rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                    />
                  </label>
                </div>
              </div>

              {/* CleanAds Monetization (Rewarded + Interstitial) */}
              <div className="md:col-span-2 rounded-2xl bg-[#111114] border border-white/10 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">CleanAds Monetization</h2>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Paste your <code className="font-mono text-zinc-300">pl_...</code> Placement ID or full CleanAds snippet — the ID is extracted automatically.
                    </p>
                  </div>

                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <span className="text-xs text-zinc-300">Test Mode</span>
                    <input
                      type="checkbox"
                      checked={settings.cleanads_test_mode}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, cleanads_test_mode: e.target.checked }))
                      }
                      className="h-5 w-5 accent-white rounded"
                    />
                  </label>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  {/* CleanAds Rewarded Unit */}
                  <div className="rounded-xl bg-[#08080A] border border-white/10 p-4 space-y-3">
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <div>
                        <span className="text-xs font-semibold text-white block">
                          CleanAds Rewarded
                        </span>
                        <span className="text-[11px] text-zinc-400">
                          Shown when tapping Download Video (falls back on no-fill)
                        </span>
                      </div>
                      <input
                        type="checkbox"
                        checked={settings.cleanads_rewarded_enabled}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            cleanads_rewarded_enabled: e.target.checked,
                          }))
                        }
                        className="h-5 w-5 accent-white rounded shrink-0"
                      />
                    </label>

                    <label className="block space-y-1.5">
                      <span className="text-xs text-zinc-400">Rewarded Placement ID</span>
                      <input
                        type="text"
                        value={settings.cleanads_rewarded_placement_id}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            cleanads_rewarded_placement_id: e.target.value,
                          }))
                        }
                        onBlur={(e) =>
                          setSettings((s) => ({
                            ...s,
                            cleanads_rewarded_placement_id: extractCleanAdsPlacementId(
                              e.target.value
                            ),
                          }))
                        }
                        placeholder="pl_..."
                        className="w-full min-h-[44px] px-3 text-sm font-mono rounded-xl bg-[#111114] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() => handleTestCleanAds('rewarded')}
                      disabled={testingCleanAds !== null}
                      className="min-h-[38px] w-full px-3 text-xs font-medium rounded-lg bg-white/[0.06] border border-white/10 text-zinc-200 hover:bg-white/[0.12] disabled:opacity-50 flex items-center justify-center gap-1.5 transition"
                    >
                      {testingCleanAds === 'rewarded' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>Test Rewarded Ad</span>
                    </button>
                  </div>

                  {/* CleanAds Interstitial Unit */}
                  <div className="rounded-xl bg-[#08080A] border border-white/10 p-4 space-y-3">
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <div>
                        <span className="text-xs font-semibold text-white block">
                          CleanAds Interstitial
                        </span>
                        <span className="text-[11px] text-zinc-400">
                          Shown naturally after exports or starting a new project (90s cooldown)
                        </span>
                      </div>
                      <input
                        type="checkbox"
                        checked={settings.cleanads_interstitial_enabled}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            cleanads_interstitial_enabled: e.target.checked,
                          }))
                        }
                        className="h-5 w-5 accent-white rounded shrink-0"
                      />
                    </label>

                    <label className="block space-y-1.5">
                      <span className="text-xs text-zinc-400">Interstitial Placement ID</span>
                      <input
                        type="text"
                        value={settings.cleanads_interstitial_placement_id}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            cleanads_interstitial_placement_id: e.target.value,
                          }))
                        }
                        onBlur={(e) =>
                          setSettings((s) => ({
                            ...s,
                            cleanads_interstitial_placement_id: extractCleanAdsPlacementId(
                              e.target.value
                            ),
                          }))
                        }
                        placeholder="pl_..."
                        className="w-full min-h-[44px] px-3 text-sm font-mono rounded-xl bg-[#111114] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() => handleTestCleanAds('interstitial')}
                      disabled={testingCleanAds !== null}
                      className="min-h-[38px] w-full px-3 text-xs font-medium rounded-lg bg-white/[0.06] border border-white/10 text-zinc-200 hover:bg-white/[0.12] disabled:opacity-50 flex items-center justify-center gap-1.5 transition"
                    >
                      {testingCleanAds === 'interstitial' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>Test Interstitial Ad</span>
                    </button>
                  </div>
                </div>

                {cleanAdsTestMsg && (
                  <p
                    className={`text-xs px-3.5 py-2.5 rounded-xl border ${
                      cleanAdsTestMsg.ok
                        ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                        : 'bg-amber-500/10 border-amber-500/25 text-amber-200'
                    }`}
                  >
                    {cleanAdsTestMsg.text}
                  </p>
                )}
              </div>
            </div>
          </form>
        )}

        {/* Batched Broadcast Tab */}
        {activeTab === 'broadcast' && (
          <section className="space-y-6 max-w-2xl">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                <Radio className="w-5 h-5 text-zinc-400" />
                <span>Batched Telegram Broadcast</span>
              </h1>
              <p className="text-xs text-zinc-400 mt-1">
                Sends 25 users per batch to stay safely within Cloudflare Free Tier subrequest limits.
              </p>
            </div>

            <form
              onSubmit={handleStartBroadcast}
              className="rounded-2xl bg-[#111114] border border-white/10 p-5 space-y-4"
            >
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-zinc-400">
                  Message to {stats.totalUsers.toLocaleString()} registered users
                </span>
                <textarea
                  rows={5}
                  maxLength={1000}
                  value={broadcastMessage}
                  onChange={(e) => setBroadcastMessage(e.target.value)}
                  placeholder="New Festival & Travel templates are live! Open ReelCraft to create your 9:16 status video."
                  className="w-full p-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40 resize-y"
                />
              </label>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={broadcasting || !broadcastMessage.trim()}
                  className="min-h-[46px] px-5 py-2.5 text-sm font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 disabled:opacity-45 flex items-center gap-2 transition"
                >
                  {broadcasting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  <span>{broadcasting ? 'Sending Batches...' : 'Start Broadcast'}</span>
                </button>

                {broadcasting && (
                  <button
                    type="button"
                    onClick={() => {
                      stopBroadcastRef.current = true;
                    }}
                    className="min-h-[46px] px-4 py-2.5 text-xs font-semibold rounded-xl bg-red-500/15 border border-red-500/30 text-red-200 hover:bg-red-500/25 transition"
                  >
                    Stop
                  </button>
                )}
              </div>

              {(broadcasting || broadcastProgress.processed > 0 || broadcastProgress.done) && (
                <div className="pt-3 border-t border-white/10 space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                    <span className="text-zinc-300">
                      Processed {broadcastProgress.processed} / {broadcastProgress.total}
                    </span>
                    <span className="text-white font-semibold">{broadcastPct}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-white transition-all duration-200"
                      style={{ width: `${broadcastPct}%` }}
                    />
                  </div>
                  <div className="flex items-center gap-4 text-xs font-mono tabular-nums text-zinc-400">
                    <span className="text-emerald-400">Sent: {broadcastProgress.sent}</span>
                    <span className="text-amber-300">Failed: {broadcastProgress.failed}</span>
                    {broadcastProgress.done && (
                      <span className="inline-flex items-center gap-1 text-white">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        Complete
                      </span>
                    )}
                  </div>
                </div>
              )}

              {broadcastError && (
                <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
                  {broadcastError}
                </p>
              )}
            </form>
          </section>
        )}
      </main>
    </div>
  );
}
