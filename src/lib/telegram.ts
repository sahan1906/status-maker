interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramWebApp {
  initData?: string;
  platform?: string;
  initDataUnsafe?: {
    user?: TelegramUser;
    start_param?: string;
  };
  ready: () => void;
  expand: () => void;
  isVersionAtLeast?: (version: string) => boolean;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
  openTelegramLink?: (url: string) => void;
  downloadFile?: (
    params: { url: string; file_name: string },
    callback?: (accepted: boolean) => void
  ) => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export interface TelegramContextInfo {
  isTelegram: boolean;
  initData: string;
  userId: string;
  username: string;
  startParam: string;
}

export function readTelegramStartParam(): string {
  if (typeof window === 'undefined') return '';
  const tgStart = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
  if (typeof tgStart === 'string' && tgStart.trim()) {
    return tgStart.trim();
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('tgWebAppStartParam') || params.get('startapp') || '';
    return fromQuery.trim();
  } catch {
    return '';
  }
}

export function getInitialShortsRouteState(): {
  isShorts: boolean;
  initialVideoId: string;
} {
  if (typeof window === 'undefined') {
    return { isShorts: false, initialVideoId: '' };
  }

  const pathname = window.location.pathname.replace(/\/+$/, '');
  const params = new URLSearchParams(window.location.search);
  const startParam = readTelegramStartParam();

  if (startParam === 'shorts') {
    return { isShorts: true, initialVideoId: '' };
  }
  if (startParam.startsWith('short_') && startParam.length > 6) {
    return { isShorts: true, initialVideoId: startParam.slice(6).trim() };
  }
  if (pathname === '/shorts') {
    return { isShorts: true, initialVideoId: (params.get('v') || '').trim() };
  }

  return { isShorts: false, initialVideoId: '' };
}

export function buildShortsTelegramDirectLink(
  botUsername: string,
  miniAppShortName: string,
  videoId?: string
): string {
  const cleanBot = (botUsername || '').replace(/^@+/, '').trim();
  const cleanApp = (miniAppShortName || '').trim();
  const startVal = videoId ? `short_${videoId}` : 'shorts';

  if (cleanBot) {
    if (cleanApp) {
      return `https://t.me/${cleanBot}/${cleanApp}?startapp=${encodeURIComponent(startVal)}`;
    }
    return `https://t.me/${cleanBot}?startapp=${encodeURIComponent(startVal)}`;
  }

  if (typeof window !== 'undefined') {
    return `${window.location.origin}/shorts${videoId ? `?v=${encodeURIComponent(videoId)}` : ''}`;
  }
  return `/shorts${videoId ? `?v=${encodeURIComponent(videoId)}` : ''}`;
}

export function openTelegramShareUrl(shareUrl: string, text: string): boolean {
  const tg = window.Telegram?.WebApp;
  const tgShare = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(text)}`;
  if (tg && typeof tg.openTelegramLink === 'function') {
    try {
      tg.openTelegramLink(tgShare);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function initTelegramApp(): TelegramContextInfo {
  const tg = window.Telegram?.WebApp;
  const startParam = readTelegramStartParam();
  if (!tg) {
    return { isTelegram: false, initData: '', userId: '', username: '', startParam };
  }

  try {
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.('#08080A');
    tg.setBackgroundColor?.('#08080A');
  } catch {
    // Ignore outside Telegram
  }

  const user = tg.initDataUnsafe?.user;
  const hasTelegramPlatform = Boolean(tg.platform && tg.platform !== 'unknown');
  return {
    isTelegram: Boolean(tg.initData || user || hasTelegramPlatform),
    initData: tg.initData || '',
    userId: user?.id ? String(user.id) : '',
    username: user?.username || user?.first_name || '',
    startParam,
  };
}

export function triggerTelegramNativeDownload(
  url: string,
  fileName: string
): 'native-dialog' | 'external-browser' | 'unsupported' {
  const tg = window.Telegram?.WebApp;
  if (!tg) return 'unsupported';

  try {
    const supportsDownloadFile =
      typeof tg.downloadFile === 'function' &&
      (!tg.isVersionAtLeast || tg.isVersionAtLeast('8.0'));

    if (supportsDownloadFile && tg.downloadFile) {
      tg.downloadFile({ url, file_name: fileName });
      return 'native-dialog';
    }

    if (typeof tg.openLink === 'function') {
      tg.openLink(url);
      return 'external-browser';
    }
  } catch {
    if (typeof tg.openLink === 'function') {
      try {
        tg.openLink(url);
        return 'external-browser';
      } catch {
        return 'unsupported';
      }
    }
  }

  return 'unsupported';
}

export function haptic(kind: 'light' | 'medium' | 'success' = 'light'): void {
  const hf = window.Telegram?.WebApp?.HapticFeedback;
  if (!hf) return;
  try {
    if (kind === 'success') hf.notificationOccurred('success');
    else hf.impactOccurred(kind);
  } catch {
    // Ignore unsupported haptic calls
  }
}
