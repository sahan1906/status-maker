export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>;
}

export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  SESSION_SECRET?: string;
  APP_URL?: string;
}

export interface PagesContext {
  request: Request;
  env: Env;
  params: Record<string, string | string[]>;
  waitUntil: (promise: Promise<unknown>) => void;
}

export type PagesHandler = (context: PagesContext) => Promise<Response> | Response;

export const PUBLIC_SETTING_KEYS = [
  'site_name',
  'watermark_text',
  'watermark_enabled',
  'reward_ad_enabled',
  'ad_provider',
  'adsgram_block_id',
  'monetag_zone_id',
  'richads_pub_id',
  'gigapub_id',
  'cleanads_rewarded_enabled',
  'cleanads_rewarded_placement_id',
  'cleanads_interstitial_enabled',
  'cleanads_interstitial_placement_id',
  'cleanads_test_mode',
  'shorts_ad_enabled',
  'shorts_ad_every_n',
  'shorts_download_ad_enabled',
  'telegram_bot_username',
  'telegram_miniapp_short_name',
] as const;

export const EDITABLE_SETTING_KEYS = [
  ...PUBLIC_SETTING_KEYS,
  'shorts_channel_id',
  'bot_token',
] as const;

export type SettingKey = (typeof EDITABLE_SETTING_KEYS)[number];
