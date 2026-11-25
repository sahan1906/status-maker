interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramWebApp {
  initData?: string;
  initDataUnsafe?: {
    user?: TelegramUser;
  };
  ready: () => void;
  expand: () => void;
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
  return {
    isTelegram: Boolean(tg.initData || user),
    initData: tg.initData || '',
    userId: user?.id ? String(user.id) : '',
    username: user?.username || user?.first_name || '',
  };
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
