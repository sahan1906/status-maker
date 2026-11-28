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

export interface InitialEditsRouteState {
  isEdits: boolean;
  initialVideoId: string;
  initialTemplateId: string;
}

export function getInitialEditsRouteState(): InitialEditsRouteState {
  if (typeof window === 'undefined') {
    return { isEdits: false, initialVideoId: '', initialTemplateId: '' };
  }

  const pathname = window.location.pathname.replace(/\/+$/, '');
  const params = new URLSearchParams(window.location.search);
  const startParam = readTelegramStartParam();

  if (startParam === 'edits' || startParam === 'shorts') {
    return { isEdits: true, initialVideoId: '', initialTemplateId: '' };
  }
  if (startParam.startsWith('edit_') && startParam.length > 5) {
    return { isEdits: true, initialVideoId: startParam.slice(5).trim(), initialTemplateId: '' };
  }
  if (startParam.startsWith('short_') && startParam.length > 6) {
    return { isEdits: true, initialVideoId: startParam.slice(6).trim(), initialTemplateId: '' };
  }
  if (startParam.startsWith('tpl_') && startParam.length > 4) {
    return { isEdits: true, initialVideoId: '', initialTemplateId: startParam.slice(4).trim() };
  }
  if (pathname === '/edits' || pathname === '/shorts') {
    return {
      isEdits: true,
      initialVideoId: (params.get('v') || '').trim(),
      initialTemplateId: (params.get('t') || '').trim(),
    };
  }

  return { isEdits: false, initialVideoId: '', initialTemplateId: '' };
}

export function buildEditsTelegramDirectLink(
  botUsername: string,
  miniAppShortName: string,
  target?: { videoId?: string; templateId?: string }
): string {
  const cleanBot = (botUsername || '').replace(/^@+/, '').trim();
  const cleanApp = (miniAppShortName || '').trim();
  const videoId = target?.videoId?.trim() || '';
  const templateId = target?.templateId?.trim() || '';
  const startVal = templateId
    ? `tpl_${templateId}`
    : videoId
      ? `edit_${videoId}`
      : 'edits';

  if (cleanBot) {
    if (cleanApp) {
      return `https://t.me/${cleanBot}/${cleanApp}?startapp=${encodeURIComponent(startVal)}`;
    }
    return `https://t.me/${cleanBot}?startapp=${encodeURIComponent(startVal)}`;
  }

  const query = templateId
    ? `?t=${encodeURIComponent(templateId)}`
    : videoId
      ? `?v=${encodeURIComponent(videoId)}`
      : '';

  if (typeof window !== 'undefined') {
    return `${window.location.origin}/edits${query}`;
  }
  return `/edits${query}`;
}

export interface InitialTapLinkRouteState {
  isTapLinksTab: boolean;
  unlockCode: string;
}

export function getInitialTapLinkRouteState(): InitialTapLinkRouteState {
  if (typeof window === 'undefined') {
    return { isTapLinksTab: false, unlockCode: '' };
  }

  const pathname = window.location.pathname.replace(/\/+$/, '');
  const startParam = readTelegramStartParam();

  if (startParam.startsWith('tl_') && startParam.length > 3) {
    return { isTapLinksTab: false, unlockCode: startParam.slice(3).trim().toLowerCase() };
  }
  if (startParam === 'taplinks') {
    return { isTapLinksTab: true, unlockCode: '' };
  }

  const shortMatch = pathname.match(/^\/l\/([a-zA-Z0-9_-]{3,32})$/);
  if (shortMatch?.[1]) {
    return { isTapLinksTab: false, unlockCode: shortMatch[1].toLowerCase() };
  }

  if (pathname === '/taplinks') {
    return { isTapLinksTab: true, unlockCode: '' };
  }

  return { isTapLinksTab: false, unlockCode: '' };
}

export function buildTapLinkTelegramDirectLink(
  botUsername: string,
  miniAppShortName: string,
  code?: string
): string {
  const cleanBot = (botUsername || '').replace(/^@+/, '').trim();
  const cleanApp = (miniAppShortName || '').trim();
  const cleanCode = (code || '').trim().toLowerCase();
  const startVal = cleanCode ? `tl_${cleanCode}` : 'taplinks';

  if (cleanBot) {
    if (cleanApp) {
      return `https://t.me/${cleanBot}/${cleanApp}?startapp=${encodeURIComponent(startVal)}`;
    }
    return `https://t.me/${cleanBot}?startapp=${encodeURIComponent(startVal)}`;
  }

  if (typeof window !== 'undefined') {
    return cleanCode
      ? `${window.location.origin}/l/${encodeURIComponent(cleanCode)}`
      : `${window.location.origin}/taplinks`;
  }
  return cleanCode ? `/l/${encodeURIComponent(cleanCode)}` : '/taplinks';
}

export function openVerifiedDestinationUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }

  const safeUrl = parsed.toString();
  const tg = window.Telegram?.WebApp;
  const isTelegramLink =
    parsed.hostname === 't.me' ||
    parsed.hostname === 'telegram.me' ||
    parsed.hostname === 'telegram.dog';

  if (tg) {
    try {
      if (isTelegramLink && typeof tg.openTelegramLink === 'function') {
        tg.openTelegramLink(safeUrl);
        return true;
      }
      if (typeof tg.openLink === 'function') {
        tg.openLink(safeUrl);
        return true;
      }
    } catch {
      // Fall through to standard navigation
    }
  }

  window.location.assign(safeUrl);
  return true;
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
