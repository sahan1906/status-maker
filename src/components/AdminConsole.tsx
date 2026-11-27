import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Copy,
  ExternalLink,
  Film,
  Loader2,
  Lock,
  LogOut,
  Radio,
  RefreshCw,
  Save,
  Send,
  Settings,
  Trash2,
  Upload,
  Webhook,
} from 'lucide-react';
import {
  AdProvider,
  extractCleanAdsPlacementId,
  testCleanAdsPlacement,
} from '../lib/adNetworks';
import { buildEditsTelegramDirectLink } from '../lib/telegram';

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
  shorts_ad_enabled: boolean;
  shorts_ad_every_n: number;
  shorts_download_ad_enabled: boolean;
  shorts_channel_id: string;
  telegram_bot_username: string;
  telegram_miniapp_short_name: string;
  bot_token_configured: boolean;
  bot_token_masked: string;
}

interface AdminConsoleProps {
  onExitToApp: () => void;
  onConfigUpdated: () => void;
}

type AdminTab = 'dashboard' | 'shorts' | 'overlays' | 'settings' | 'broadcast';

interface AdminShortItem {
  id: string;
  title: string;
  tags: string;
  video_url: string;
  poster_url: string;
  likes: number;
  created_at: string;
}

interface AdminOverlayItem {
  id: string;
  name: string;
  tagline: string;
  badge: string;
  fit_mode: 'full-frame' | 'detected-rect';
  chroma_sensitivity: number;
  accent_color: string;
  source_type: 'telegram' | 'url';
  stream_url: string;
  created_at?: string;
}

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
  shorts_ad_enabled: true,
  shorts_ad_every_n: 1,
  shorts_download_ad_enabled: false,
  shorts_channel_id: '',
  telegram_bot_username: '',
  telegram_miniapp_short_name: '',
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
  const [copiedDirectLink, setCopiedDirectLink] = useState(false);
  const [copiedWebLink, setCopiedWebLink] = useState(false);
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

  // Premade AI Green-Screen Overlay Templates state
  const [overlays, setOverlays] = useState<AdminOverlayItem[]>([]);
  const [ovName, setOvName] = useState('');
  const [ovTagline, setOvTagline] = useState('');
  const [ovBadge, setOvBadge] = useState('AI Overlay');
  const [ovFitMode, setOvFitMode] = useState<'full-frame' | 'detected-rect'>('full-frame');
  const [ovSensitivity, setOvSensitivity] = useState(0.55);
  const [ovSourceMode, setOvSourceMode] = useState<'upload' | 'url'>('upload');
  const [ovVideoUrl, setOvVideoUrl] = useState('');
  const [ovStorageChatId, setOvStorageChatId] = useState('');
  const [ovFile, setOvFile] = useState<File | null>(null);
  const [ovSubmitting, setOvSubmitting] = useState(false);
  const [ovMsg, setOvMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ovFileInputRef = useRef<HTMLInputElement | null>(null);

  // Self-hosted Shorts (Private Telegram Channel -> D1)
  const [adminShorts, setAdminShorts] = useState<AdminShortItem[]>([]);
  const [shortTitle, setShortTitle] = useState('');
  const [shortTags, setShortTags] = useState('');
  const [shortFile, setShortFile] = useState<File | null>(null);
  const [shortUploading, setShortUploading] = useState(false);
  const [shortMsg, setShortMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const shortFileInputRef = useRef<HTMLInputElement | null>(null);

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
        const [statsRes, settingsRes, overlaysRes, shortsRes] = await Promise.all([
          fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${bearer}` } }),
          fetch('/api/admin/settings', { headers: { Authorization: `Bearer ${bearer}` } }),
          fetch('/api/admin/overlays', { headers: { Authorization: `Bearer ${bearer}` } }),
          fetch('/api/admin/shorts', { headers: { Authorization: `Bearer ${bearer}` } }),
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
        if (overlaysRes.ok) {
          const ovData = (await overlaysRes.json()) as {
            overlays?: AdminOverlayItem[];
            storage_chat_id?: string;
          };
          setOverlays(Array.isArray(ovData.overlays) ? ovData.overlays : []);
          if (ovData.storage_chat_id) {
            setOvStorageChatId(ovData.storage_chat_id);
          }
        }
        if (shortsRes.ok) {
          const shData = (await shortsRes.json()) as { videos?: AdminShortItem[] };
          setAdminShorts(Array.isArray(shData.videos) ? shData.videos : []);
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
        shorts_ad_enabled: settings.shorts_ad_enabled,
        shorts_ad_every_n: 1,
        shorts_download_ad_enabled: false,
        shorts_channel_id: settings.shorts_channel_id.trim(),
        telegram_bot_username: settings.telegram_bot_username.replace(/^@+/, '').trim(),
        telegram_miniapp_short_name: settings.telegram_miniapp_short_name.trim(),
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

  const handleCreateOverlay = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setOvMsg(null);
    if (!ovName.trim()) {
      setOvMsg({ ok: false, text: 'Enter a template name first (e.g. AI Girl Birthday Wish).' });
      return;
    }
    if (ovSourceMode === 'upload' && !ovFile) {
      setOvMsg({ ok: false, text: 'Choose a green-screen MP4 video file to upload.' });
      return;
    }
    if (ovSourceMode === 'url' && !ovVideoUrl.trim()) {
      setOvMsg({ ok: false, text: 'Paste a direct https:// MP4 video URL.' });
      return;
    }

    setOvSubmitting(true);
    try {
      const form = new FormData();
      form.append('name', ovName.trim());
      form.append('tagline', ovTagline.trim());
      form.append('badge', ovBadge.trim() || 'AI Overlay');
      form.append('fit_mode', ovFitMode);
      form.append('chroma_sensitivity', String(ovSensitivity));
      if (ovSourceMode === 'upload' && ovFile) {
        form.append('video', ovFile, ovFile.name);
        if (ovStorageChatId.trim()) {
          form.append('storage_chat_id', ovStorageChatId.trim());
        }
      } else {
        form.append('video_url', ovVideoUrl.trim());
      }

      const res = await fetch('/api/admin/overlays', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        overlay?: AdminOverlayItem;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.overlay) {
        setOvMsg({ ok: false, text: data.error || 'Could not publish AI overlay template.' });
        return;
      }

      setOverlays((prev) => [data.overlay!, ...prev]);
      setOvName('');
      setOvTagline('');
      setOvVideoUrl('');
      setOvFile(null);
      if (ovFileInputRef.current) ovFileInputRef.current.value = '';
      setOvMsg({
        ok: true,
        text: `"${data.overlay.name}" is now live in the main Templates gallery!`,
      });
      onConfigUpdated();
    } catch {
      setOvMsg({ ok: false, text: 'Network error while publishing overlay.' });
    } finally {
      setOvSubmitting(false);
    }
  };

  const handleDeleteOverlay = async (id: string) => {
    if (!token) return;
    setOvMsg(null);
    try {
      const res = await fetch(`/api/admin/overlays?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setOverlays((prev) => prev.filter((item) => item.id !== id));
        onConfigUpdated();
      }
    } catch {
      setOvMsg({ ok: false, text: 'Could not delete overlay.' });
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

  const handleUploadShort = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !shortFile) {
      setShortMsg({ ok: false, text: 'Choose an MP4 video file first.' });
      return;
    }
    setShortUploading(true);
    setShortMsg(null);
    try {
      const form = new FormData();
      form.append('title', shortTitle.trim() || 'Short Reel');
      form.append('tags', shortTags.trim());
      if (settings.shorts_channel_id.trim()) {
        form.append('shorts_channel_id', settings.shorts_channel_id.trim());
      }
      form.append('video', shortFile, shortFile.name || 'short.mp4');

      const res = await fetch('/api/admin/shorts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setShortMsg({ ok: false, text: data.error || 'Could not upload short video.' });
        return;
      }
      setShortTitle('');
      setShortTags('');
      setShortFile(null);
      if (shortFileInputRef.current) shortFileInputRef.current.value = '';
      setShortMsg({ ok: true, text: 'Video uploaded to your private channel & published to Edits!' });
      await loadDashboardData(token);
    } catch {
      setShortMsg({ ok: false, text: 'Network error while uploading video.' });
    } finally {
      setShortUploading(false);
    }
  };

  const handleDeleteShort = async (id: string) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/shorts?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setAdminShorts((prev) => prev.filter((item) => item.id !== id));
      }
    } catch {
      // Ignore network error
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

          <nav className="flex items-center gap-1 bg-white/[0.04] p-1 rounded-xl border border-white/10 overflow-x-auto no-scrollbar">
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
              onClick={() => setActiveTab('shorts')}
              className={`min-h-[34px] px-3 py-1 text-xs font-semibold rounded-lg whitespace-nowrap transition ${
                activeTab === 'shorts' ? 'bg-white text-[#08080A]' : 'text-zinc-400 hover:text-white'
              }`}
            >
              Edits ({adminShorts.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('overlays')}
              className={`min-h-[34px] px-3 py-1 text-xs font-semibold rounded-lg whitespace-nowrap transition ${
                activeTab === 'overlays' ? 'bg-white text-[#08080A]' : 'text-zinc-400 hover:text-white'
              }`}
            >
              AI Overlays
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

              {/* In-App Edits Feed, Private Channel & Telegram Direct Link */}
              <div className="md:col-span-2 rounded-2xl bg-[#111114] border border-white/10 p-5 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">
                      Edits Feed, Private Channel &amp; Telegram Direct Link
                    </h2>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Edits automatically includes all built-in Templates (with Use this Edit button) plus any videos you post to your private Telegram channel.
                    </p>
                  </div>

                  <a
                    href="/edits"
                    target="_blank"
                    rel="noreferrer"
                    className="min-h-[38px] px-3.5 text-xs font-semibold rounded-xl bg-white/[0.08] border border-white/15 text-white hover:bg-white/[0.14] inline-flex items-center gap-1.5 transition whitespace-nowrap"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Open Edits Tab</span>
                  </a>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  {/* Hourly 1-Scroll Ad Gate */}
                  <div className="rounded-xl bg-[#08080A] border border-white/10 p-4 space-y-4">
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <div>
                        <span className="text-xs font-semibold text-white block">
                          Hourly Ad Gate in Edits Tab
                        </span>
                        <span className="text-[11px] text-zinc-400 leading-relaxed block mt-0.5">
                          Shows 1 short ad after the user&apos;s first scroll in Edits — strictly capped to once per hour per user.
                        </span>
                      </div>
                      <input
                        type="checkbox"
                        checked={settings.shorts_ad_enabled}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, shorts_ad_enabled: e.target.checked }))
                        }
                        className="h-5 w-5 accent-amber-400 rounded shrink-0"
                      />
                    </label>

                    <div className="pt-3 border-t border-white/10 space-y-1">
                      <span className="text-xs font-semibold text-zinc-200 block">
                        Editor Download Ad
                      </span>
                      <p className="text-[11px] text-zinc-400 leading-relaxed">
                        Exporting / downloading a finished video in the Editor continues to show your rewarded ad every time (controlled by Rewarded Ad Networks above).
                      </p>
                    </div>
                  </div>

                  {/* Private Telegram Channel & Direct Links */}
                  <div className="rounded-xl bg-[#08080A] border border-white/10 p-4 space-y-4">
                    {/* 1. Private Telegram Channel ID for Auto-Sync */}
                    <div className="space-y-1.5">
                      <label className="block space-y-1">
                        <span className="text-xs font-semibold text-white block">
                          Private Edits Channel ID (Auto-Sync)
                        </span>
                        <span className="text-[11px] text-zinc-400 block leading-relaxed">
                          Add your bot as Admin in your private channel, click Register Webhook above, then post{' '}
                          <code className="font-mono text-amber-300">/setshortschannel</code> once in the channel (or paste the <code className="font-mono text-zinc-300">-100...</code> ID below). Every AI prompt / showcase video you post there appears in Edits automatically.
                        </span>
                        <input
                          type="text"
                          value={settings.shorts_channel_id}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              shorts_channel_id: e.target.value.replace(/[^0-9-]/g, ''),
                            }))
                          }
                          placeholder="-1001234567890"
                          className="w-full min-h-[40px] px-3 text-xs font-mono rounded-xl bg-[#111114] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                        />
                      </label>
                    </div>

                    {/* 2. Telegram Mini App Direct Link */}
                    <div className="pt-3 border-t border-white/10 space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block space-y-1">
                          <span className="text-[11px] text-zinc-400">Reel Maker Bot Username</span>
                          <input
                            type="text"
                            value={settings.telegram_bot_username}
                            onChange={(e) =>
                              setSettings((s) => ({
                                ...s,
                                telegram_bot_username: e.target.value.replace(/^@+/, ''),
                              }))
                            }
                            placeholder="YourReelMakerBot"
                            className="w-full min-h-[40px] px-3 text-xs font-mono rounded-xl bg-[#111114] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                          />
                        </label>

                        <label className="block space-y-1">
                          <span className="text-[11px] text-zinc-400">Mini App Short Name</span>
                          <input
                            type="text"
                            value={settings.telegram_miniapp_short_name}
                            onChange={(e) =>
                              setSettings((s) => ({
                                ...s,
                                telegram_miniapp_short_name: e.target.value,
                              }))
                            }
                            placeholder="Optional (e.g. app)"
                            className="w-full min-h-[40px] px-3 text-xs font-mono rounded-xl bg-[#111114] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                          />
                        </label>
                      </div>

                      {(() => {
                        const hasBot = Boolean(settings.telegram_bot_username.trim());
                        const directLink = hasBot
                          ? buildEditsTelegramDirectLink(
                              settings.telegram_bot_username,
                              settings.telegram_miniapp_short_name
                            )
                          : 'https://t.me/YOUR_BOT_USERNAME?startapp=edits';
                        return (
                          <div className="space-y-1.5">
                            <span className="text-[11px] text-zinc-400 block">
                              Telegram Direct Link to Edits Tab
                            </span>
                            <div className="flex items-center gap-2">
                              <code
                                className={`flex-1 min-w-0 truncate px-3 py-2.5 text-[11px] font-mono rounded-xl bg-[#111114] border border-white/10 ${
                                  hasBot ? 'text-amber-300' : 'text-zinc-500'
                                }`}
                              >
                                {directLink}
                              </code>
                              <button
                                type="button"
                                disabled={!hasBot}
                                onClick={() => {
                                  navigator.clipboard?.writeText(directLink).catch(() => {});
                                  setCopiedDirectLink(true);
                                  window.setTimeout(() => setCopiedDirectLink(false), 2000);
                                }}
                                className="min-h-[40px] px-3 text-xs font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 disabled:opacity-40 flex items-center gap-1.5 shrink-0 transition"
                              >
                                {copiedDirectLink ? (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                    <span>Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5" />
                                    <span>Copy</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })()}

                      {(() => {
                        const webEditsUrl =
                          typeof window !== 'undefined'
                            ? `${window.location.origin}/edits`
                            : '/edits';
                        return (
                          <div className="space-y-1">
                            <span className="text-[11px] text-zinc-500 block">
                              Web URL (Browser Preview)
                            </span>
                            <div className="flex items-center gap-2">
                              <code className="flex-1 min-w-0 truncate px-3 py-2 text-[11px] font-mono rounded-xl bg-[#111114] border border-white/10 text-zinc-300">
                                {webEditsUrl}
                              </code>
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard?.writeText(webEditsUrl).catch(() => {});
                                  setCopiedWebLink(true);
                                  window.setTimeout(() => setCopiedWebLink(false), 2000);
                                }}
                                className="min-h-[36px] px-3 text-xs font-semibold rounded-xl bg-white/[0.08] border border-white/15 text-white hover:bg-white/[0.14] flex items-center gap-1.5 shrink-0 transition"
                              >
                                {copiedWebLink ? (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                    <span>Copied</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5" />
                                    <span>Copy</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </form>
        )}

        {/* Edits Videos Management Tab (Private Channel Auto-Sync + Direct Upload) */}
        {activeTab === 'shorts' && (
          <section className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold text-white">Edits Videos (AI Prompts &amp; Custom)</h1>
                <p className="text-xs text-zinc-400 mt-1">
                  Built-in Templates appear in Edits automatically with a Use this Edit button. Post AI prompt videos in your private Telegram channel (or upload below) to mix them into Edits.
                </p>
              </div>
              <button
                type="button"
                onClick={() => token && loadDashboardData(token)}
                className="min-h-[40px] px-3.5 text-xs font-semibold rounded-xl bg-white/[0.08] border border-white/15 text-white hover:bg-white/[0.14] flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Refresh</span>
              </button>
            </div>

            <div className="grid lg:grid-cols-12 gap-6 items-start">
              {/* Direct Upload to Private Channel */}
              <form
                onSubmit={handleUploadShort}
                className="lg:col-span-5 rounded-2xl bg-[#111114] border border-white/10 p-5 space-y-4"
              >
                <div>
                  <h2 className="text-sm font-semibold text-white">Upload Video to Edits Feed</h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {settings.shorts_channel_id
                      ? `Linked Channel: ${settings.shorts_channel_id}`
                      : 'Link your private channel in Settings (or post /setshortschannel in the channel) first.'}
                  </p>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs text-zinc-400">Title / Caption</span>
                  <input
                    type="text"
                    value={shortTitle}
                    onChange={(e) => setShortTitle(e.target.value)}
                    placeholder="e.g. Cinematic AI Portrait Prompt"
                    className="w-full min-h-[42px] px-3 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                  />
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs text-zinc-400">Tags (comma or space separated)</span>
                  <input
                    type="text"
                    value={shortTags}
                    onChange={(e) => setShortTags(e.target.value)}
                    placeholder="ai, prompt, portrait"
                    className="w-full min-h-[42px] px-3 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                  />
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs text-zinc-400">Vertical Video MP4 (max 19.5 MB)</span>
                  <input
                    ref={shortFileInputRef}
                    type="file"
                    accept="video/mp4,video/*"
                    onChange={(e) => setShortFile(e.target.files?.[0] || null)}
                    className="w-full text-xs text-zinc-300 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                </label>

                {shortMsg && (
                  <p
                    className={`text-xs px-3 py-2 rounded-xl border ${
                      shortMsg.ok
                        ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                        : 'bg-red-500/10 border-red-500/25 text-red-200'
                    }`}
                  >
                    {shortMsg.text}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={shortUploading || !shortFile}
                  className="w-full min-h-[44px] px-4 text-xs font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 disabled:opacity-50 flex items-center justify-center gap-2 transition"
                >
                  {shortUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  <span>{shortUploading ? 'Uploading...' : 'Upload & Publish to Edits'}</span>
                </button>
              </form>

              {/* Published Custom Videos List */}
              <div className="lg:col-span-7 rounded-2xl bg-[#111114] border border-white/10 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white">
                    Published Channel Videos ({adminShorts.length})
                  </h2>
                </div>

                {adminShorts.length === 0 ? (
                  <div className="py-12 text-center space-y-2 border border-dashed border-white/10 rounded-xl px-4">
                    <Film className="w-7 h-7 text-zinc-500 mx-auto" />
                    <p className="text-sm font-medium text-zinc-300">No custom videos uploaded yet</p>
                    <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                      Your built-in Templates are already live in Edits. Post AI prompt videos in your linked private channel (or upload on the left) to mix them in.
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-white/10">
                    {adminShorts.map((item) => (
                      <div key={item.id} className="py-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-14 rounded-lg bg-[#08080A] border border-white/10 overflow-hidden shrink-0 flex items-center justify-center">
                            {item.poster_url ? (
                              <img
                                src={item.poster_url}
                                alt={item.title}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <Film className="w-4 h-4 text-zinc-600" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-white truncate">{item.title}</p>
                            <p className="text-xs text-zinc-400 font-mono tabular-nums truncate">
                              {item.likes} likes{item.tags ? ` · ${item.tags}` : ''}
                            </p>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleDeleteShort(item.id)}
                          aria-label={`Delete ${item.title}`}
                          className="min-w-[40px] min-h-[40px] rounded-xl text-zinc-400 hover:text-red-300 hover:bg-red-500/10 flex items-center justify-center shrink-0 transition"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
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

        {/* Premade AI Green-Screen Overlay Templates Tab */}
        {activeTab === 'overlays' && (
          <section className="space-y-6">
            <div>
              <h1 className="text-2xl font-bold text-white">Premade AI Green-Screen Templates</h1>
              <p className="text-xs text-zinc-400 mt-0.5">
                Upload a premade green-screen video once (e.g. AI girl wishing Happy Birthday). Users simply drop their photo or video behind it!
              </p>
            </div>

            <form
              onSubmit={handleCreateOverlay}
              className="rounded-2xl bg-[#111114] border border-white/10 p-5 space-y-4"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-zinc-400">Template Name</span>
                  <input
                    type="text"
                    required
                    maxLength={48}
                    value={ovName}
                    onChange={(e) => setOvName(e.target.value)}
                    placeholder="e.g. AI Girl Birthday Wish"
                    className="w-full min-h-[44px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                  />
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-zinc-400">Badge Label</span>
                  <input
                    type="text"
                    maxLength={20}
                    value={ovBadge}
                    onChange={(e) => setOvBadge(e.target.value)}
                    placeholder="AI Birthday"
                    className="w-full min-h-[44px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                  />
                </label>
              </div>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-zinc-400">Short Description</span>
                <input
                  type="text"
                  maxLength={120}
                  value={ovTagline}
                  onChange={(e) => setOvTagline(e.target.value)}
                  placeholder="AI girl wishes Happy Birthday right in front of your photo"
                  className="w-full min-h-[44px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-zinc-400">User Photo Placement</span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setOvFitMode('full-frame')}
                      className={`min-h-[42px] px-3 rounded-xl border text-xs font-semibold transition ${
                        ovFitMode === 'full-frame'
                          ? 'bg-white text-[#08080A] border-white'
                          : 'bg-[#08080A] text-zinc-300 border-white/10 hover:border-white/25'
                      }`}
                    >
                      Full Background
                    </button>
                    <button
                      type="button"
                      onClick={() => setOvFitMode('detected-rect')}
                      className={`min-h-[42px] px-3 rounded-xl border text-xs font-semibold transition ${
                        ovFitMode === 'detected-rect'
                          ? 'bg-white text-[#08080A] border-white'
                          : 'bg-[#08080A] text-zinc-300 border-white/10 hover:border-white/25'
                      }`}
                    >
                      Inside Green Box
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    Use Full Background for an AI person on green screen; Inside Green Box for a phone/frame.
                  </p>
                </div>

                <label className="block space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400 font-medium">Default Chroma Key Sensitivity</span>
                    <span className="font-mono text-white">{Math.round(ovSensitivity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0.15}
                    max={0.95}
                    step={0.02}
                    value={ovSensitivity}
                    onChange={(e) => setOvSensitivity(Number(e.target.value))}
                    className="w-full accent-emerald-400 h-1.5 mt-3 cursor-pointer"
                  />
                </label>
              </div>

              {/* Video Source Toggle: Free Telegram MP4 Upload OR Direct MP4 URL */}
              <div className="pt-3 border-t border-white/10 space-y-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setOvSourceMode('upload')}
                    className={`min-h-[36px] px-3.5 rounded-xl text-xs font-semibold border transition ${
                      ovSourceMode === 'upload'
                        ? 'bg-emerald-400 text-[#05140B] border-emerald-400'
                        : 'bg-[#08080A] text-zinc-300 border-white/10'
                    }`}
                  >
                    Upload MP4 (Free via Bot)
                  </button>
                  <button
                    type="button"
                    onClick={() => setOvSourceMode('url')}
                    className={`min-h-[36px] px-3.5 rounded-xl text-xs font-semibold border transition ${
                      ovSourceMode === 'url'
                        ? 'bg-white text-[#08080A] border-white'
                        : 'bg-[#08080A] text-zinc-300 border-white/10'
                    }`}
                  >
                    Direct HTTPS MP4 URL
                  </button>
                </div>

                {ovSourceMode === 'upload' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-zinc-400">
                        Green-Screen MP4 File (max 19 MB)
                      </span>
                      <input
                        ref={ovFileInputRef}
                        type="file"
                        accept="video/mp4,video/*"
                        onChange={(e) => setOvFile(e.target.files?.[0] || null)}
                        className="w-full text-xs text-zinc-300 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-white file:text-[#08080A] hover:file:bg-zinc-200 cursor-pointer"
                      />
                    </label>

                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-zinc-400">
                        Your Telegram Chat ID (optional if bot has users)
                      </span>
                      <input
                        type="text"
                        value={ovStorageChatId}
                        onChange={(e) => setOvStorageChatId(e.target.value)}
                        placeholder="e.g. 123456789 or -100..."
                        className="w-full min-h-[42px] px-3.5 text-sm font-mono rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                      />
                    </label>
                  </div>
                ) : (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-zinc-400">Direct MP4 Video URL</span>
                    <input
                      type="url"
                      value={ovVideoUrl}
                      onChange={(e) => setOvVideoUrl(e.target.value)}
                      placeholder="https://example.com/ai-girl-birthday-greenscreen.mp4"
                      className="w-full min-h-[44px] px-3.5 text-sm font-mono rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/40"
                    />
                  </label>
                )}
              </div>

              <button
                type="submit"
                disabled={ovSubmitting}
                className="min-h-[46px] px-5 py-2.5 text-sm font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 disabled:opacity-45 flex items-center gap-2 transition"
              >
                {ovSubmitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                <span>{ovSubmitting ? 'Publishing Template...' : 'Publish AI Overlay Template'}</span>
              </button>

              {ovMsg && (
                <p
                  className={`text-xs rounded-xl px-3 py-2 border ${
                    ovMsg.ok
                      ? 'text-emerald-200 bg-emerald-500/10 border-emerald-500/25'
                      : 'text-red-300 bg-red-500/10 border-red-500/20'
                  }`}
                >
                  {ovMsg.text}
                </p>
              )}
            </form>

            {/* Published Premade AI Overlays List */}
            <div className="rounded-2xl bg-[#111114] border border-white/10 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">
                  Published AI Overlays ({overlays.length})
                </h2>
              </div>

              {overlays.length === 0 ? (
                <p className="text-xs text-zinc-500 py-4 text-center">
                  No premade AI overlays published yet. Upload your first green-screen video above!
                </p>
              ) : (
                <div className="space-y-2.5">
                  {overlays.map((ov) => (
                    <div
                      key={ov.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-[#08080A] border border-white/10 p-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-11 w-11 rounded-lg bg-pink-500/15 border border-pink-400/30 flex items-center justify-center text-pink-300 shrink-0">
                          <Film className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-white truncate">
                              {ov.name}
                            </span>
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/10 text-zinc-300 shrink-0">
                              {ov.fit_mode === 'full-frame' ? 'Full BG' : 'Green Box'}
                            </span>
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 shrink-0">
                              {ov.source_type === 'telegram' ? 'Bot Hosted' : 'URL'}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-400 truncate mt-0.5">{ov.tagline}</p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleDeleteOverlay(ov.id)}
                        aria-label={`Delete ${ov.name}`}
                        className="min-h-[38px] min-w-[38px] rounded-lg bg-red-500/10 border border-red-500/25 text-red-300 hover:bg-red-500/20 flex items-center justify-center shrink-0 transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
