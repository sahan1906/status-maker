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
  };
  ready: () => void;
  expand: () => void;
  isVersionAtLeast?: (version: string) => boolean;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
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
}

export function initTelegramApp(): TelegramContextInfo {
  const tg = window.Telegram?.WebApp;
  if (!tg) {
    return { isTelegram: false, initData: '', userId: '', username: '' };
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
