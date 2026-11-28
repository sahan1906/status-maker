import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react';
import { PublicAppConfig } from '../lib/adNetworks';
import {
  buildTapLinkTelegramDirectLink,
  haptic,
  openTelegramShareUrl,
  TelegramContextInfo,
} from '../lib/telegram';

export interface SavedTapLinkItem {
  id: string;
  code: string;
  title: string;
  destination_url: string;
  destination_host: string;
  clicks: number;
  unlocks: number;
  short_url: string;
  telegram_url: string;
  web_url: string;
  created_at: string;
}

interface TapLinksViewProps {
  appConfig: PublicAppConfig;
  tgContext: TelegramContextInfo;
  onPreviewCode: (code: string) => void;
}

const MY_TAPLINKS_STORAGE_KEY = 'reelcraft_my_taplinks_v1';

function readSavedLinks(): SavedTapLinkItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(MY_TAPLINKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedTapLinkItem[]).slice(0, 40) : [];
  } catch {
    return [];
  }
}

function writeSavedLinks(items: SavedTapLinkItem[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MY_TAPLINKS_STORAGE_KEY, JSON.stringify(items.slice(0, 40)));
  } catch {
    // Ignore storage quota errors
  }
}

export function TapLinksView({ appConfig, tgContext, onPreviewCode }: TapLinksViewProps) {
  const [urlInput, setUrlInput] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [aliasInput, setAliasInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [createdLink, setCreatedLink] = useState<SavedTapLinkItem | null>(null);
  const [myLinks, setMyLinks] = useState<SavedTapLinkItem[]>(() => readSavedLinks());
  const [syncingStats, setSyncingStats] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const hasBotDirectLinks = Boolean(appConfig.telegram_bot_username.trim());

  const resolveTelegramUrl = useCallback(
    (item: SavedTapLinkItem) => {
      if (item.telegram_url) return item.telegram_url;
      if (appConfig.telegram_bot_username.trim()) {
        return buildTapLinkTelegramDirectLink(
          appConfig.telegram_bot_username,
          appConfig.telegram_miniapp_short_name,
          item.code
        );
      }
      return '';
    },
    [appConfig.telegram_bot_username, appConfig.telegram_miniapp_short_name]
  );

  const resolveWebUrl = useCallback((item: SavedTapLinkItem) => {
    if (item.web_url) return item.web_url;
    if (typeof window !== 'undefined') {
      return `${window.location.origin}/l/${encodeURIComponent(item.code)}`;
    }
    return `/l/${encodeURIComponent(item.code)}`;
  }, []);

  const syncLiveStats = useCallback(async (itemsToSync: SavedTapLinkItem[]) => {
    if (itemsToSync.length === 0) return;
    setSyncingStats(true);
    try {
      const codes = itemsToSync.map((i) => i.code).join(',');
      const res = await fetch(`/api/taplinks?codes=${encodeURIComponent(codes)}`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = (await res.json()) as { ok?: boolean; links?: SavedTapLinkItem[] };
      if (!data.ok || !Array.isArray(data.links)) return;

      const byCode = new Map(data.links.map((item) => [item.code, item]));
      setMyLinks((prev) => {
        const merged = prev.map((existing) => {
          const fresh = byCode.get(existing.code);
          return fresh ? { ...existing, ...fresh } : existing;
        });
        writeSavedLinks(merged);
        return merged;
      });
    } catch {
      // Ignore transient network errors
    } finally {
      setSyncingStats(false);
    }
  }, []);

  useEffect(() => {
    const saved = readSavedLinks();
    if (saved.length > 0) {
      void syncLiveStats(saved);
    }
  }, [syncLiveStats]);

  const copyText = async (text: string, key: string) => {
    haptic('light');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      window.setTimeout(() => {
        setCopiedId((curr) => (curr === key ? null : curr));
      }, 1800);
    } catch {
      // Clipboard blocked in restricted iframe
    }
  };

  const handleShareLink = (item: SavedTapLinkItem) => {
    haptic('light');
    const bestUrl = resolveTelegramUrl(item) || resolveWebUrl(item);
    const shareText = item.title ? `${item.title}` : 'Open link';
    const openedTg = openTelegramShareUrl(bestUrl, shareText);
    if (!openedTg) {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        navigator.share({ title: shareText, url: bestUrl }).catch(() => {
          void copyText(bestUrl, `share-${item.code}`);
        });
      } else {
        void copyText(bestUrl, `share-${item.code}`);
      }
    }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!urlInput.trim()) {
      setFormError('Paste a destination URL first.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/taplinks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlInput.trim(),
          title: titleInput.trim(),
          alias: aliasInput.trim(),
          creator_ref: tgContext.userId || tgContext.username || '',
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        link?: SavedTapLinkItem;
        error?: string;
      };

      if (!res.ok || !data.ok || !data.link) {
        setFormError(data.error || 'Could not create TapLink. Please check the URL and try again.');
        return;
      }

      haptic('success');
      const fresh = data.link;
      setCreatedLink(fresh);
      setMyLinks((prev) => {
        const next = [fresh, ...prev.filter((item) => item.code !== fresh.code)].slice(0, 40);
        writeSavedLinks(next);
        return next;
      });
      setUrlInput('');
      setTitleInput('');
      setAliasInput('');
    } catch {
      setFormError('Network error while creating your link. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveFromHistory = (code: string) => {
    haptic('light');
    setMyLinks((prev) => {
      const next = prev.filter((item) => item.code !== code);
      writeSavedLinks(next);
      return next;
    });
    if (createdLink?.code === code) {
      setCreatedLink(null);
    }
  };

  const totalClicks = myLinks.reduce((sum, item) => sum + (item.clicks || 0), 0);
  const totalUnlocks = myLinks.reduce((sum, item) => sum + (item.unlocks || 0), 0);

  return (
    <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 pt-5 pb-24 md:py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">TapLinks</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Shorten any link and share it with your audience. Viewers see 1 quick ad before opening your destination.
          </p>
        </div>

        {myLinks.length > 0 && (
          <div className="flex items-center gap-5 text-xs text-zinc-400">
            <div>
              <span className="block text-[11px] text-zinc-500">Visits</span>
              <span className="font-mono tabular-nums text-base font-semibold text-white">
                {totalClicks.toLocaleString()}
              </span>
            </div>
            <div>
              <span className="block text-[11px] text-zinc-500">Unlocks</span>
              <span className="font-mono tabular-nums text-base font-semibold text-amber-400">
                {totalUnlocks.toLocaleString()}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Shortener Composer */}
      <form
        onSubmit={handleCreate}
        className="rounded-2xl bg-[#111114] border border-white/10 p-5 sm:p-6 space-y-4"
      >
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-zinc-300">Destination URL</span>
          <div className="relative">
            <Link2 className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com/your-pack-or-channel"
              className="w-full min-h-[48px] pl-10 pr-3.5 text-sm rounded-xl bg-[#08080A] border border-white/15 text-white placeholder:text-zinc-500 focus:outline-none focus:border-amber-400/70"
            />
          </div>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-zinc-400">Link Title (optional)</span>
            <input
              type="text"
              maxLength={90}
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              placeholder="e.g. Free Presets Pack"
              className="w-full min-h-[44px] px-3.5 text-sm rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/35"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-zinc-400">Custom Alias (optional)</span>
            <input
              type="text"
              maxLength={32}
              autoCapitalize="none"
              spellCheck={false}
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
              placeholder="e.g. viral-pack"
              className="w-full min-h-[44px] px-3.5 text-sm font-mono rounded-xl bg-[#08080A] border border-white/10 text-white placeholder:text-zinc-600 focus:outline-none focus:border-white/35"
            />
          </label>
        </div>

        {formError && (
          <p className="text-xs text-red-200 bg-red-500/10 border border-red-500/25 rounded-xl px-3.5 py-2.5">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-xs text-zinc-500">
            Supports https:// websites, Drive links, Telegram channels, and store pages.
          </p>
          <button
            type="submit"
            disabled={submitting}
            className="w-full sm:w-auto min-h-[46px] px-6 py-2.5 text-sm font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 active:scale-[0.99] disabled:opacity-50 flex items-center justify-center gap-2 transition"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Link2 className="w-4 h-4" />
            )}
            <span>{submitting ? 'Creating...' : 'Create TapLink'}</span>
          </button>
        </div>
      </form>

      {/* Newly Created Link Result */}
      {createdLink && (
        <section className="rounded-2xl bg-[#111114] border border-amber-400/35 p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-amber-400">TapLink Ready</p>
              <h2 className="text-base font-semibold text-white truncate mt-0.5">
                {createdLink.title}
              </h2>
              <p className="text-xs text-zinc-400 truncate mt-0.5">
                Destination: {createdLink.destination_host}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onPreviewCode(createdLink.code)}
              className="min-h-[38px] px-3 text-xs font-medium rounded-xl bg-white/[0.06] border border-white/10 text-zinc-200 hover:text-white flex items-center gap-1.5 shrink-0 transition"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Preview</span>
            </button>
          </div>

          <div className="space-y-2.5">
            {resolveTelegramUrl(createdLink) && (
              <div className="rounded-xl bg-[#08080A] border border-white/10 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div className="min-w-0">
                  <span className="text-[11px] font-medium text-amber-300 block">
                    Telegram Direct Link (Best for Channels &amp; Ads)
                  </span>
                  <p className="text-xs font-mono text-white truncate mt-0.5">
                    {resolveTelegramUrl(createdLink)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => copyText(resolveTelegramUrl(createdLink), `new-tg-${createdLink.code}`)}
                    className="min-h-[38px] px-3.5 text-xs font-semibold rounded-lg bg-white text-[#08080A] hover:bg-zinc-200 flex items-center gap-1.5 transition"
                  >
                    {copiedId === `new-tg-${createdLink.code}` ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleShareLink(createdLink)}
                    className="min-h-[38px] px-3 text-xs font-semibold rounded-lg bg-white/[0.08] border border-white/10 text-white hover:bg-white/[0.14] flex items-center gap-1.5 transition"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Share</span>
                  </button>
                </div>
              </div>
            )}

            <div className="rounded-xl bg-[#08080A] border border-white/10 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="min-w-0">
                <span className="text-[11px] font-medium text-zinc-400 block">
                  Web Short Link
                </span>
                <p className="text-xs font-mono text-zinc-200 truncate mt-0.5">
                  {resolveWebUrl(createdLink)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => copyText(resolveWebUrl(createdLink), `new-web-${createdLink.code}`)}
                  className="min-h-[38px] px-3.5 text-xs font-semibold rounded-lg bg-white/[0.08] border border-white/10 text-white hover:bg-white/[0.14] flex items-center gap-1.5 transition"
                >
                  {copiedId === `new-web-${createdLink.code}` ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
                {!hasBotDirectLinks && (
                  <button
                    type="button"
                    onClick={() => handleShareLink(createdLink)}
                    className="min-h-[38px] px-3 text-xs font-semibold rounded-lg bg-white text-[#08080A] hover:bg-zinc-200 flex items-center gap-1.5 transition"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Share</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Your Recent TapLinks */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">
            Your TapLinks ({myLinks.length})
          </h2>
          {myLinks.length > 0 && (
            <button
              type="button"
              onClick={() => syncLiveStats(myLinks)}
              disabled={syncingStats}
              className="min-h-[36px] px-3 text-xs font-medium text-zinc-400 hover:text-white flex items-center gap-1.5 transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncingStats ? 'animate-spin' : ''}`} />
              <span>Refresh Stats</span>
            </button>
          )}
        </div>

        {myLinks.length === 0 ? (
          <div className="rounded-2xl bg-[#111114] border border-white/10 p-8 text-center space-y-1.5">
            <p className="text-sm font-medium text-zinc-200">No TapLinks yet</p>
            <p className="text-xs text-zinc-500">
              Paste your first destination URL above to generate a shareable short link.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {myLinks.map((item) => {
              const primaryUrl = resolveTelegramUrl(item) || resolveWebUrl(item);
              const copyKey = `list-${item.code}`;
              return (
                <article
                  key={item.code}
                  className="rounded-2xl bg-[#111114] border border-white/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="text-sm font-semibold text-white truncate">{item.title}</h3>
                      <span className="text-[11px] font-mono text-zinc-500 shrink-0">
                        /{item.code}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-400 truncate">{item.destination_host}</p>
                    <p className="text-[11px] font-mono text-zinc-500 truncate">{primaryUrl}</p>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-white/5">
                    <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
                      <div>
                        <span className="text-zinc-500 mr-1">Visits</span>
                        <span className="text-white font-semibold">{item.clicks}</span>
                      </div>
                      <div>
                        <span className="text-zinc-500 mr-1">Unlocks</span>
                        <span className="text-amber-400 font-semibold">{item.unlocks}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => copyText(primaryUrl, copyKey)}
                        className="min-h-[38px] px-3 text-xs font-semibold rounded-lg bg-white text-[#08080A] hover:bg-zinc-200 flex items-center gap-1.5 transition"
                      >
                        {copiedId === copyKey ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleShareLink(item)}
                        aria-label={`Share ${item.title}`}
                        className="min-h-[38px] min-w-[38px] rounded-lg bg-white/[0.06] border border-white/10 text-zinc-200 hover:text-white flex items-center justify-center transition"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onPreviewCode(item.code)}
                        aria-label={`Preview ${item.title}`}
                        className="min-h-[38px] min-w-[38px] rounded-lg bg-white/[0.06] border border-white/10 text-zinc-200 hover:text-white flex items-center justify-center transition"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveFromHistory(item.code)}
                        aria-label={`Remove ${item.title} from local list`}
                        className="min-h-[38px] min-w-[38px] rounded-lg bg-white/[0.04] border border-white/10 text-zinc-500 hover:text-red-300 flex items-center justify-center transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Quiet Verified Developer API Note (Admin-verified keys only) */}
      <div className="rounded-2xl bg-[#111114] border border-white/10 p-4 flex items-start gap-3 text-xs text-zinc-400">
        <KeyRound className="w-4 h-4 text-zinc-300 shrink-0 mt-0.5" />
        <p className="leading-relaxed">
          <strong className="text-zinc-200 font-semibold">Need bulk shortening or Mini App API access?</strong>{' '}
          Developer API keys (<code className="font-mono text-zinc-300">/api/v1/taplinks/*</code>) are issued directly after manual verification by the {appConfig.site_name} admin.
        </p>
      </div>
    </main>
  );
}
