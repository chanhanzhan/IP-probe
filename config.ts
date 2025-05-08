import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config();

const configPath = path.resolve(process.cwd(), 'config.json');

export interface AppConfig {
  ADMIN_TOKEN: string;
  IMAGE_URL: string;
  IMAGE_DIR: string;
  LOCAL_IMAGE_FIRST: boolean;
  IPINFO_API: string;
  DB_TYPE: string;
  RATE_LIMIT_CONFIG?: {
    STAT_WINDOW_MS: number;
    CLEAN_INTERVAL_MS: number;
    RATE_LIMIT_WINDOW_MS: number;
    RATE_LIMIT_MAX: number;
    RATE_LIMIT_BAN_TIMES: number;
    BAN_DURATION_MS: number;
  };
}

const defaultConfig: AppConfig = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'admin',
  IMAGE_URL: process.env.IMAGE_URL || 'https://www.loliapi.com/acg/',
  IMAGE_DIR: process.env.IMAGE_DIR || './images',
  LOCAL_IMAGE_FIRST: process.env.LOCAL_IMAGE_FIRST === 'true',
  IPINFO_API: process.env.IPINFO_API || 'https://ipinfo.io/',
  DB_TYPE: process.env.DB_TYPE || 'sqlite',
  RATE_LIMIT_CONFIG: {
    STAT_WINDOW_MS: 24 * 60 * 60 * 1000,
    CLEAN_INTERVAL_MS: 10 * 60 * 1000,
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_MAX: 10,
    RATE_LIMIT_BAN_TIMES: 3,
    BAN_DURATION_MS: 60 * 60 * 1000
  }
};

export function loadConfig(): AppConfig {
  if (fs.existsSync(configPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return { ...defaultConfig, ...json };
    } catch {
      return defaultConfig;
    }
  }
  return defaultConfig;
}

export function saveConfig(cfg: Partial<AppConfig>) {
  const merged = { ...loadConfig(), ...cfg };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
}

export const CONFIG = loadConfig(); 