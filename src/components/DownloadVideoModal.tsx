import {
  CheckCircle2,
  Download,
  Loader2,
  Send,
  Share2,
  X,
} from 'lucide-react';
import { ExportVideoResult } from '../lib/videoRenderer';

interface DownloadVideoModalProps {
  open: boolean;
  templateName: string;
  adProviderLabel: string;
  isRunningAd: boolean;
  isExporting: boolean;
  exportProgress: number;
  exportError: string | null;
  exportedVideo: ExportVideoResult | null;
  isSendingTelegram: boolean;
  telegramSendStatus: { ok: boolean; message: string } | null;
  nativeShareSupported: boolean;
  onRetry: () => void;
  onCancelExport: () => void;
  onClose: () => void;
  onSendToTelegramChat: () => void;
  onNativeShare: () => void;
}

export function DownloadVideoModal({
  open,
  templateName,
  adProviderLabel,
  isRunningAd,
  isExporting,
  exportProgress,
  exportError,
  exportedVideo,
  isSendingTelegram,
  telegramSendStatus,
  nativeShareSupported,
  onRetry,
  onCancelExport,
  onClose,
  onSendToTelegramChat,
  onNativeShare,
}: DownloadVideoModalProps) {
  if (!open) return null;

  const handleClose = () => {
    if (isExporting) {
      onCancelExport();
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="download-video-title"
    >
      <div className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl bg-[#111114] border-t sm:border border-white/15 p-5 sm:p-6 pb-safe space-y-5 shadow-2xl">
        {/* Sheet drag handle on mobile */}
        <div className="w-10 h-1 rounded-full bg-white/15 mx-auto sm:hidden -mt-1" />

        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="download-video-title" className="text-lg font-bold text-white">
              Download Video
            </h2>
            <p className="text-xs font-mono text-zinc-400 mt-0.5">
              {templateName} · 720×1280 · 30fps MP4
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close download modal"
            className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 flex items-center justify-center rounded-xl text-zinc-400 hover:text-white hover:bg-white/10 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* State 1: Rewarded Ad running */}
        {isRunningAd && (
          <div className="rounded-xl bg-[#08080A] border border-white/10 p-5 flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-white animate-spin shrink-0" />
            <div>
              <p className="text-sm font-semibold text-white">Loading short sponsored video...</p>
              <p className="text-xs text-zinc-400 mt-0.5">
                Your HD video starts preparing right after the {adProviderLabel} ad.
              </p>
            </div>
          </div>
        )}

        {/* State 2: Encoding HD MP4 */}
        {isExporting && !isRunningAd && (
          <div className="rounded-xl bg-[#08080A] border border-white/10 p-5 space-y-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Loader2 className="w-4 h-4 text-white animate-spin" />
                <span className="text-sm font-medium text-white">Preparing HD MP4...</span>
              </div>
              <span className="text-sm font-mono font-semibold text-white tabular-nums">
                {exportProgress}%
              </span>
            </div>

            <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-white transition-all duration-150"
                style={{ width: `${exportProgress}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Rendered privately on your phone.</span>
              <button
                type="button"
                onClick={onCancelExport}
                className="text-zinc-300 hover:text-white font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* State 3: Error */}
        {exportError && !isExporting && !isRunningAd && (
          <div className="space-y-3">
            <div
              role="alert"
              className="rounded-xl bg-red-500/10 border border-red-500/25 px-4 py-3 text-sm text-red-200"
            >
              {exportError}
            </div>
            <button
              type="button"
              onClick={onRetry}
              className="min-h-[48px] w-full px-4 py-2.5 text-sm font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 transition"
            >
              Try Again
            </button>
          </div>
        )}

        {/* State 4: Ready to Save / Send */}
        {exportedVideo && !isExporting && !isRunningAd && (
          <div className="space-y-4">
            <div className="flex items-center gap-3.5 rounded-xl bg-[#08080A] border border-white/10 p-3">
              <video
                src={exportedVideo.url}
                controls
                playsInline
                muted
                loop
                className="w-16 aspect-[9/16] rounded-lg bg-black object-cover shrink-0 border border-white/10"
              />
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-1.5 text-emerald-400 text-sm font-semibold">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span className="text-white">Video Ready</span>
                </div>
                <p className="text-xs font-mono text-zinc-400 tabular-nums">
                  {exportedVideo.width}×{exportedVideo.height} · .{exportedVideo.extension.toUpperCase()} ·{' '}
                  {(exportedVideo.blob.size / (1024 * 1024)).toFixed(2)} MB
                </p>
                <p className="text-xs text-zinc-400">
                  Send to Telegram chat or download straight to your gallery.
                </p>
              </div>
            </div>

            <div className="space-y-2.5">
              {/* Primary: Send directly to Telegram Chat */}
              <button
                type="button"
                onClick={onSendToTelegramChat}
                disabled={isSendingTelegram}
                className="min-h-[48px] w-full px-4 py-2.5 text-sm font-semibold rounded-xl bg-white text-[#08080A] hover:bg-zinc-200 disabled:opacity-50 flex items-center justify-center gap-2 transition whitespace-nowrap"
              >
                {isSendingTelegram ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                <span>{isSendingTelegram ? 'Sending to Telegram...' : 'Send to My Telegram Chat'}</span>
              </button>

              {telegramSendStatus && (
                <p
                  className={`text-xs px-3 py-2 rounded-lg border ${
                    telegramSendStatus.ok
                      ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                      : 'bg-amber-500/10 border-amber-500/25 text-amber-200'
                  }`}
                >
                  {telegramSendStatus.message}
                </p>
              )}

              {/* Secondary: Direct Download + Web Share */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <a
                  href={exportedVideo.url}
                  download={`ReelCraft-${templateName.toLowerCase().replace(/\s+/g, '-')}.${exportedVideo.extension}`}
                  className={`min-h-[46px] w-full px-4 py-2 text-xs font-semibold rounded-xl bg-white/[0.08] border border-white/15 text-white hover:bg-white/[0.14] flex items-center justify-center gap-1.5 transition whitespace-nowrap ${
                    nativeShareSupported ? '' : 'sm:col-span-2'
                  }`}
                >
                  <Download className="w-4 h-4" />
                  <span>Download Video</span>
                </a>

                {nativeShareSupported && (
                  <button
                    type="button"
                    onClick={onNativeShare}
                    className="min-h-[46px] w-full px-4 py-2 text-xs font-semibold rounded-xl bg-white/[0.06] border border-white/10 text-zinc-200 hover:text-white hover:bg-white/[0.12] flex items-center justify-center gap-1.5 transition whitespace-nowrap"
                  >
                    <Share2 className="w-4 h-4" />
                    <span>Share to Apps</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
