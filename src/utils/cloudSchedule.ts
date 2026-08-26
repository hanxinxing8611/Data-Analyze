/**
 * 验证计划云端共享
 *
 * 数据流：
 * - 拉取：页面打开时从 GitHub 仓库拉取 public/shared/schedule.json → 替换本地 schedule 表
 * - 推送：增删改操作后自动推送本地全量排产数据到云端（需配置 Token）
 * - 无 Token：仅本地操作，不推送（其他工程师不受影响）
 * - 冲突处理：sha 请求禁用缓存，409 冲突自动重试（最多 3 次，间隔 600ms）
 *
 * 云端数据格式：Omit<ScheduleItem, 'id' | 'created_at'>[]
 * （id 和 created_at 是本地 DB 产物，不参与云端同步）
 */

import type { ScheduleItem } from '../types';
import { loadCloudConfig, type CloudConfig } from './cloudSettings';

/** 云端排产文件路径 */
const CLOUD_SCHEDULE_PATH = 'public/shared/schedule.json';

/** 云端排产条目（不含本地 id 和 created_at） */
export type CloudScheduleItem = Omit<ScheduleItem, 'id' | 'created_at'>;

/* ---------------- 编码工具 ---------------- */

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function encodeBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/* ---------------- 解析 ---------------- */

/** 解析云端 schedule.json 文本；非法内容返回 null */
export function parseCloudSchedule(raw: string): CloudScheduleItem[] | null {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    return arr.filter((it): it is CloudScheduleItem => {
      if (!it || typeof it !== 'object') return false;
      const o = it as Record<string, unknown>;
      return (
        typeof o.batch_id === 'string' &&
        typeof o.engineer_name === 'string' &&
        typeof o.start_date === 'string' &&
        typeof o.report_deadline === 'string' &&
        typeof o.status === 'string'
      );
    });
  } catch {
    return null;
  }
}

/* ---------------- 拉取 ---------------- */

/**
 * 拉取云端排产数据：
 * 1. GitHub Contents API（仓库实时内容，公开仓库匿名可读）
 * 2. 失败时回退已部署静态站点
 * 返回 null 表示无云端数据或网络失败
 */
export async function fetchCloudSchedule(): Promise<CloudScheduleItem[] | null> {
  const cfg = loadCloudConfig();
  const { owner, repo } = cfg;

  // 通道 1：Contents API（实时）
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${CLOUD_SCHEDULE_PATH}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (res.ok) {
      const data = (await res.json()) as { content?: string; encoding?: string };
      if (data.content && data.encoding === 'base64') {
        const parsed = parseCloudSchedule(decodeBase64Utf8(data.content));
        if (parsed) return parsed;
      }
    }
  } catch {
    // 网络失败，尝试回退
  }

  // 通道 2：已部署静态站点
  try {
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    const res = await fetch(`${base}shared/schedule.json?t=${Date.now()}`);
    if (res.ok) {
      const parsed = parseCloudSchedule(await res.text());
      if (parsed) return parsed;
    }
  } catch {
    // 双通道均失败
  }
  return null;
}

/* ---------------- 推送 ---------------- */

/** 获取云端文件当前 sha（禁用缓存，避免拿到过期 sha 导致 409） */
async function fetchCloudScheduleSha(cfg: CloudConfig): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${CLOUD_SCHEDULE_PATH}?t=${Date.now()}`,
    {
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
      },
    },
  );
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new Error('Token 无效或已过期（HTTP 401/403），请在系统设置中更换新 Token');
  }
  if (!res.ok) throw new Error(`读取云端排产文件失败（HTTP ${res.status}）`);
  const data = (await res.json()) as { sha?: string };
  return typeof data.sha === 'string' ? data.sha : null;
}

/**
 * 推送本地排产数据到 GitHub 仓库
 * 409/422 冲突自动重试（最多 3 次，每次重新获取 sha）
 */
export async function pushCloudSchedule(items: CloudScheduleItem[]): Promise<{ ok: boolean; message: string }> {
  const cfg = loadCloudConfig();
  if (!cfg.token) return { ok: false, message: 'not-configured' };

  const content = encodeBase64Utf8(JSON.stringify(items, null, 2) + '\n');

  const doPut = async (sha: string | null) =>
    fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${CLOUD_SCHEDULE_PATH}`,
      {
        method: 'PUT',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'chore: 更新验证计划排产数据',
          content,
          ...(sha ? { sha } : {}),
        }),
      },
    );

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sha = await fetchCloudScheduleSha(cfg);
      const res = await doPut(sha);
      if (res.ok) return { ok: true, message: '已同步云端' };
      if (res.status !== 409 && res.status !== 422) {
        const detail = (await res.json().catch(() => ({}))) as { message?: string };
        return { ok: false, message: detail.message ? `HTTP ${res.status}：${detail.message}` : `HTTP ${res.status}` };
      }
      // sha 已过期（他人刚推送），稍候重新取 sha 再试
      await new Promise((r) => setTimeout(r, 600));
    }
    return { ok: false, message: '云端数据已被他人更新，同步冲突，请稍后重试' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}