import { useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Play,
  ShieldCheck,
} from 'lucide-react';
import {
  PublicAppConfig,
  runTapLinkAd,
  shouldTriggerTapLinkAd,
} from '../lib/adNetworks';
import { haptic, openVerifiedDestinationUrl } from '../lib/telegram';

interface TapLinkMeta {
  code: string;
  title: string;
  destination_host: string;
  clicks: number;
  unlocks: number;
}

interface TapLinkUnlockViewProps {
  code: string;
  appConfig: PublicAppConfig;
  onExitToApp: () => void;
}

function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function TapLinkUnlockView({
  code,
  appConfig,
  onExitToApp,
}: TapLinkUnlockViewProps) {
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<TapLinkMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [unlocking, setUnlocking] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [unlockedUrl, setUnlockedUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setMeta(null);
    setUnlockedUrl(null);
    setStatusMessage(null);

    fetch(`/api/taplinks?code=${encodeURIComponent(code)}`, { cache: 'no-store' })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          link?: TapLinkMeta;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.ok || !data.link) {
          setLoadError(data.error || 'This TapLink was not found or has been removed.');
          return;
        }
        setMeta(data.link);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('Could not load this link right now. Please check your connection.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  const hasAdGate = shouldTriggerTapLinkAd(appConfig);

  const handleContinueClick = async () => {
    if (!meta || unlocking) return;
    haptic('medium');
    setStatusMessage(null);
    setUnlocking(true);

    try {
      if (hasAdGate) {
        const adResult = await runTapLinkAd(appConfig);
        if (adResult === 'cancelled') {
          setStatusMessage('Please finish watching the short ad to unlock the destination link.');
          return;
        }
      }

      const res = await fetch('/api/taplinks-unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: meta.code }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        destination_url?: string;
        unlocks?: number;
        error?: string;
      };

      if (!res.ok || !data.ok || !data.destination_url || !isSafeHttpUrl(data.destination_url)) {
        setStatusMessage(data.error || 'Could not unlock destination link. Please try again.');
        return;
      }

      haptic('success');
      setUnlockedUrl(data.destination_url);
      if (typeof data.unlocks === 'number') {
        setMeta((prev) => (prev ? { ...prev, unlocks: data.unlocks! } : prev));
      }

      // Open destination automatically; keep fallback button visible if popup/redirect is blocked
      openVerifiedDestinationUrl(data.destination_url);
    } catch {
      setStatusMessage('Network error while unlocking link. Please try again.');
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-[#08080A] text-zinc-100 flex flex-col items-center justify-between px-4 py-8">
      <header className="w-full max-w-md flex items-center justify-between">
        <button
          type="button"
          onClick={onExitToApp}
          className="text-sm font-bold tracking-tight text-white hover:text-zinc-300 transition"
        >
          {appConfig.site_name}
        </button>
        <span className="text-xs font-mono text-zinc-500">TapLinks</span>
      </header>

      <main className="w-full max-w-md my-auto py-8">
        {loading ? (
          <div className="rounded-2xl bg-[#111114] border border-white/10 p-8 flex flex-col items-center gap-3 text-center">
            <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
            <p className="text-sm text-zinc-400">Verifying destination link...</p>
          </div>
        ) : loadError || !meta ? (
          <div className="rounded-2xl bg-[#111114] border border-white/10 p-6 space-y-5 text-center">
            <div className="space-y-1.5">
              <h1 className="text-lg font-bold text-white">Link Unavailable</h1>
              <p className="text-xs text-zinc-400 leading-relaxed">
                {loadError || 'This short link is invalid or has expired.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onExitToApp}
              className="w-full min-h-[46px] px-4 text-sm font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 transition"
            >
              Open {appConfig.site_name}
            </button>
          </div>
        ) : (
          <div className="rounded-2xl bg-[#111114] border border-white/10 p-6 space-y-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-emerald-400">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>Verified HTTPS Destination</span>
              </div>
              <h1 className="text-xl font-bold text-white leading-snug break-words">
                {meta.title}
              </h1>
              <div className="flex items-center justify-between gap-3 pt-1 text-xs text-zinc-400">
                <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
                  <Globe className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  <span className="font-mono truncate">{meta.destination_host}</span>
                </span>
                <span className="font-mono tabular-nums text-zinc-500 shrink-0">
                  {meta.clicks.toLocaleString()} visits
                </span>
              </div>
            </div>

            {unlockedUrl ? (
              <div className="space-y-3">
                <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/25 px-3.5 py-2.5 flex items-center gap-2 text-xs text-emerald-300">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>Link unlocked. Tap below if it did not open automatically.</span>
                </div>

                <a
                  href={unlockedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    openVerifiedDestinationUrl(unlockedUrl);
                  }}
                  className="w-full min-h-[50px] px-5 py-3 text-sm font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 flex items-center justify-center gap-2 transition"
                >
                  <span>Open Destination Now</span>
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-zinc-400 leading-relaxed">
                  {hasAdGate
                    ? 'Watch 1 short sponsored ad to continue straight to the destination link.'
                    : 'Your link is ready. Tap below to open the verified destination.'}
                </p>

                {statusMessage && (
                  <p className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/25 rounded-xl px-3.5 py-2.5">
                    {statusMessage}
                  </p>
                )}

                <button
                  type="button"
                  onClick={handleContinueClick}
                  disabled={unlocking}
                  className="w-full min-h-[50px] px-5 py-3 text-sm font-semibold rounded-xl bg-amber-400 text-[#08080A] hover:bg-amber-300 active:scale-[0.99] disabled:opacity-60 flex items-center justify-center gap-2 transition"
                >
                  {unlocking ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>{hasAdGate ? 'Loading Short Ad...' : 'Unlocking...'}</span>
                    </>
                  ) : hasAdGate ? (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      <span>Watch 1 Short Ad &amp; Open Link</span>
                    </>
                  ) : (
                    <>
                      <span>Continue to Destination</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="w-full max-w-md text-center">
        <button
          type="button"
          onClick={onExitToApp}
          className="min-h-[40px] px-3 text-xs font-medium text-zinc-400 hover:text-white transition"
        >
          Explore Templates &amp; Edits on {appConfig.site_name} →
        </button>
      </footer>
    </div>
  );
}
