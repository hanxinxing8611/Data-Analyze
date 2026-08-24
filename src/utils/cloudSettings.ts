import {
  CRITERIA_STORAGE_KEY,
  sanitizeThresholds,
  type CriteriaThresholds,
} from '../report/reportData';
import {
  MAIL_RECIPIENTS_STORAGE_KEY,
  loadMailRecipients,
  saveMailRecipients,
} from './mailRecipients';

/* ================= 云端共享设置 =================
 *
 * 无后端架构下的「保存即云端共享」：
 * - 读：打开页面时从 GitHub 仓库拉取 shared/settings.json（公开仓库匿名可读），
 *       先走 Contents API（仓库实时内容），失败再回退已部署的静态站点（稍旧）
 * - 写：管理员在系统设置中配置 GitHub Fine-grained PAT 后，保存设置时
 *       通过 Contents API 提交到仓库，其他工程师下次打开页面即生效
 * - PAT 仅存本机 localStorage，不进代码、不进仓库
 * - 共享范围可配置（统计口径 / 默认收件人）；字段缺失 = 不共享该项，
 *   拉取时不覆盖对应本地值
 */

/** 云端设置内容 */
export interface CloudSettings {
  /** 统计口径（缺失表示不共享） */
  criteria?: CriteriaThresholds;
  /** 默认收件人（缺失表示不共享；[] 表示共享空列表） */
  mailRecipients?: string[];
  /** 云端最后更新时间（ISO 字符串） */
  updatedAt?: string;
}

/** 云端同步配置（本机） */
export interface CloudConfig {
  owner: string;
  repo: string;
  token: string;
  /** 保存时是否共享统计口径 */
  shareCriteria: boolean;
  /** 保存时是否共享默认收件人 */
  shareRecipients: boolean;
}

export const DEFAULT_CLOUD_CONFIG: CloudConfig = {
  owner: 'hanxinxing8611',
  repo: 'Data-Analyze',
  token: '',
  shareCriteria: true,
  shareRecipients: true,
};

/** 仓库中共享文件的路径（public/ 下随 Vite 部署，API 与静态回退两通道均可读） */
const CLOUD_FILE_PATH = 'public/shared/settings.json';

const CLOUD_CONFIG_KEY = 'dv-cloud-config';
const CLOUD_SYNC_INFO_KEY = 'dv-cloud-sync-info';

/** 最近一次云端同步信息（用于设置页展示） */
export interface CloudSyncInfo {
  /** 本机拉取时间（ISO） */
  fetchedAt: string;
  /** 云端文件更新时间（ISO，来自文件内容） */
  cloudUpdatedAt?: string;
  /** 拉取来源：api = 仓库实时 / pages = 部署产物 */
  source: 'api' | 'pages';
}

/* ---------------- 配置读写（localStorage） ---------------- */

export function loadCloudConfig(): CloudConfig {
  try {
    const raw = localStorage.getItem(CLOUD_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CLOUD_CONFIG };
    const p = JSON.parse(raw) as Partial<CloudConfig>;
    return {
      owner: typeof p.owner === 'string' && p.owner.trim() ? p.owner.trim() : DEFAULT_CLOUD_CONFIG.owner,
      repo: typeof p.repo === 'string' && p.repo.trim() ? p.repo.trim() : DEFAULT_CLOUD_CONFIG.repo,
      token: typeof p.token === 'string' ? p.token : '',
      shareCriteria: p.shareCriteria !== false,
      shareRecipients: p.shareRecipients !== false,
    };
  } catch {
    return { ...DEFAULT_CLOUD_CONFIG };
  }
}

export function saveCloudConfig(cfg: CloudConfig): void {
  try {
    localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    // localStorage 不可用时仅本次会话生效
  }
}

export function loadCloudSyncInfo(): CloudSyncInfo | null {
  try {
    const raw = localStorage.getItem(CLOUD_SYNC_INFO_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<CloudSyncInfo>;
    if (typeof p.fetchedAt !== 'string') return null;
    return {
      fetchedAt: p.fetchedAt,
      cloudUpdatedAt: typeof p.cloudUpdatedAt === 'string' ? p.cloudUpdatedAt : undefined,
      source: p.source === 'pages' ? 'pages' : 'api',
    };
  } catch {
    return null;
  }
}

function saveCloudSyncInfo(info: CloudSyncInfo): void {
  try {
    localStorage.setItem(CLOUD_SYNC_INFO_KEY, JSON.stringify(info));
  } catch {
    // 展示信息，忽略
  }
}

/* ---------------- 解析（纯函数，verify 脚本覆盖） ---------------- */

/** 解析云端 settings.json 文本；非法内容返回 null */
export function parseCloudSettings(raw: string): CloudSettings | null {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return null;
    const out: CloudSettings = {};
    if (p.criteria !== undefined) {
      out.criteria = sanitizeThresholds(p.criteria as Partial<CriteriaThresholds>);
    }
    if (p.mailRecipients !== undefined) {
      out.mailRecipients = Array.isArray(p.mailRecipients)
        ? p.mailRecipients
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim())
            .filter((v) => v.length > 0)
        : [];
    }
    if (typeof p.updatedAt === 'string') out.updatedAt = p.updatedAt;
    return out;
  } catch {
    return null;
  }
}

/** 按共享开关组装推送内容（从 localStorage 读当前值） */
export function collectCloudPayload(cfg: CloudConfig): CloudSettings {
  const payload: CloudSettings = { updatedAt: new Date().toISOString() };
  if (cfg.shareCriteria) {
    try {
      payload.criteria = sanitizeThresholds(JSON.parse(localStorage.getItem(CRITERIA_STORAGE_KEY) ?? 'null'));
    } catch {
      payload.criteria = undefined;
    }
  }
  if (cfg.shareRecipients) {
    payload.mailRecipients = loadMailRecipients();
  }
  return payload;
}

/* ---------------- 拉取 ---------------- */

/** 浏览器 UTF-8 base64 解码（Unicode 安全） */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** 浏览器 UTF-8 base64 编码（Unicode 安全） */
function encodeBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * 拉取云端设置：
 * 1. GitHub Contents API（仓库实时内容，公开仓库匿名可读）
 * 2. 失败时回退已部署静态站点（内容稍旧）
 * 无云端配置 / 网络失败 → null
 */
export async function fetchCloudSettings(): Promise<CloudSettings | null> {
  const cfg = loadCloudConfig();
  const { owner, repo } = cfg;

  // 通道 1：Contents API（实时）
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${CLOUD_FILE_PATH}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const data = (await res.json()) as { content?: string; encoding?: string };
      if (data.content && data.encoding === 'base64') {
        const parsed = parseCloudSettings(decodeBase64Utf8(data.content));
        if (parsed) {
          saveCloudSyncInfo({ fetchedAt: new Date().toISOString(), cloudUpdatedAt: parsed.updatedAt, source: 'api' });
          return parsed;
        }
      }
    }
  } catch {
    // 网络失败，尝试回退通道
  }

  // 通道 2：已部署静态站点（Pages 产物，部署完成前内容稍旧；public/ 内容映射到站点根）
  try {
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    const res = await fetch(`${base}shared/settings.json?t=${Date.now()}`);
    if (res.ok) {
      const parsed = parseCloudSettings(await res.text());
      if (parsed) {
        saveCloudSyncInfo({ fetchedAt: new Date().toISOString(), cloudUpdatedAt: parsed.updatedAt, source: 'pages' });
        return parsed;
      }
    }
  } catch {
    // 双通道均失败
  }
  return null;
}

/** 将云端设置写入本地（缺失字段跳过，保留本地值）；返回应用情况 */
export function applyCloudSettings(cloud: CloudSettings): { criteria: boolean; recipients: boolean } {
  let criteriaApplied = false;
  let recipientsApplied = false;
  if (cloud.criteria) {
    try {
      localStorage.setItem(CRITERIA_STORAGE_KEY, JSON.stringify(cloud.criteria));
      criteriaApplied = true;
    } catch {
      // localStorage 不可用
    }
  }
  if (cloud.mailRecipients) {
    saveMailRecipients(cloud.mailRecipients);
    recipientsApplied = true;
  }
  return { criteria: criteriaApplied, recipients: recipientsApplied };
}

/* ---------------- 推送 ---------------- */

export interface SyncResult {
  ok: boolean;
  /** not-configured = 未配置 token；nothing = 未勾选任何共享项；其余为错误信息 */
  message: string;
}

/** 获取云端文件当前 sha（新建文件无需 sha） */
async function fetchCloudSha(cfg: CloudConfig): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${CLOUD_FILE_PATH}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`读取云端文件失败（HTTP ${res.status}）`);
  const data = (await res.json()) as { sha?: string };
  return typeof data.sha === 'string' ? data.sha : null;
}

/** 提交设置到 GitHub 仓库（PUT Contents API，409 冲突自动重试一次） */
async function pushSettings(cfg: CloudConfig, payload: CloudSettings): Promise<void> {
  const content = encodeBase64Utf8(JSON.stringify(payload, null, 2) + '\n');
  const doPut = async (sha: string | null) =>
    fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${CLOUD_FILE_PATH}`, {
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'chore: 更新云端共享设置（统计口径/默认收件人）',
        content,
        ...(sha ? { sha } : {}),
      }),
    });

  let sha = await fetchCloudSha(cfg);
  let res = await doPut(sha);
  if (res.status === 409 || res.status === 422) {
    // 他人刚推送过：重新取 sha 再试一次
    sha = await fetchCloudSha(cfg);
    res = await doPut(sha);
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(detail.message ? `HTTP ${res.status}：${detail.message}` : `HTTP ${res.status}`);
  }
}

/** 一键同步入口：读本机配置与当前设置，推送云端 */
export async function syncSettingsToCloud(): Promise<SyncResult> {
  const cfg = loadCloudConfig();
  if (!cfg.token) return { ok: false, message: 'not-configured' };
  const payload = collectCloudPayload(cfg);
  if (!payload.criteria && !payload.mailRecipients) {
    return { ok: false, message: 'nothing' };
  }
  try {
    await pushSettings(cfg, payload);
    return { ok: true, message: '已同步云端' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
