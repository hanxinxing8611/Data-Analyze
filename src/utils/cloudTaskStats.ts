/**
 * 任务统计云端共享
 *
 * 数据流：
 * - 拉取：页面打开时从 GitHub 仓库拉取 public/shared/taskStats.json → 展示聚合统计
 * - 推送：验证计划增删改后，自动计算并推送全量工程师统计到云端（需配置 Token）
 * - 无 Token：仅本地操作，不推送（其他工程师不受影响）
 * - 冲突处理：sha 请求禁用缓存，409 冲突自动重试（最多 3 次，间隔 600ms）
 *
 * 云端数据格式：CloudTaskStat[]（聚合后的工程师统计，不含原始 PCE 数组）
 */

import type { ScheduleItem, SampleRecord } from '../types';
import type { CriteriaThresholds } from '../report/reportData';
import { isValidDevice } from '../report/reportData';
import { median } from './statistics';
import { loadCloudConfig, type CloudConfig } from './cloudSettings';

/** 云端任务统计文件路径 */
const CLOUD_TASK_STATS_PATH = 'public/shared/taskStats.json';

/** 云端任务统计条目（聚合后的工程师统计，不含原始数据数组） */
export interface CloudTaskStat {
  name: string;
  email: string;
  avgCycleDays: number | null;
  cycleStd: number | null;
  avgPce: number | null;
  medPce: number | null;
  maxPce: number | null;
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
  batchCount: number;
  pceDeviceCount: number;
  updatedAt: string;
}

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

/* ---------------- 工作日计算 ---------------- */

function isWeekend(date: Date): boolean {
  const d = date.getDay();
  return d === 0 || d === 6;
}

function workingDaysBetween(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  let count = 0;
  const d = new Date(s);
  while (d <= e) {
    if (!isWeekend(d)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ---------------- 统计计算（与 TaskStats.tsx 口径一致） ---------------- */

/** 从原始数据计算工程师任务统计（供 Schedule 推送和 TaskStats 本地回退复用） */
export function computeTaskStats(
  schedules: ScheduleItem[],
  samples: SampleRecord[],
  thresholds: CriteriaThresholds,
): CloudTaskStat[] {
  const today = todayStr();
  const map = new Map<string, {
    name: string;
    email: string;
    cycleDays: number[];
    pceValues: number[];
    totalTasks: number;
    completedTasks: number;
    overdueTasks: number;
    batchSet: Set<string>;
  }>();

  // 初始化工程师统计
  for (const s of schedules) {
    if (!map.has(s.engineer_name)) {
      map.set(s.engineer_name, {
        name: s.engineer_name,
        email: s.engineer_email,
        cycleDays: [],
        pceValues: [],
        totalTasks: 0,
        completedTasks: 0,
        overdueTasks: 0,
        batchSet: new Set(),
      });
    }
    const st = map.get(s.engineer_name)!;
    st.totalTasks++;
    if (s.status === 'completed') st.completedTasks++;
    if (s.status !== 'completed' && s.report_deadline < today) st.overdueTasks++;
    st.batchSet.add(s.batch_id);

    const days = workingDaysBetween(s.start_date, s.report_deadline);
    if (days > 0) st.cycleDays.push(days);
  }

  // 建立批次→工程师映射（仅该工程师独占的非基准批次才计入 PCE 统计）
  // - 基准批次（is_baseline=1）是公共参照物，不计入任何工程师个人效率
  // - 多人共享批次（同一 batch_id 挂多人）无法界定归属，不计入
  const batchOwners = new Map<string, { engineers: Set<string>; isBaseline: boolean }>();
  for (const s of schedules) {
    if (!batchOwners.has(s.batch_id)) {
      batchOwners.set(s.batch_id, { engineers: new Set(), isBaseline: false });
    }
    const entry = batchOwners.get(s.batch_id)!;
    entry.engineers.add(s.engineer_name);
    if (s.is_baseline) entry.isBaseline = true;
  }
  // 归属明确的批次：非基准 且 仅一名工程师负责
  const soleOwnerBatches = new Map<string, string>();
  for (const [batchId, entry] of batchOwners) {
    if (!entry.isBaseline && entry.engineers.size === 1) {
      soleOwnerBatches.set(batchId, [...entry.engineers][0]);
    }
  }

  // PCE 效率统计（仅有效器件，且批次归属明确）
  const validSamples = samples.filter((r) => isValidDevice(r, thresholds));
  for (const r of validSamples) {
    if (r.efficiency == null) continue;
    const owner = soleOwnerBatches.get(r.batch_id);
    if (!owner) continue;
    const st = map.get(owner);
    if (st) st.pceValues.push(r.efficiency);
  }

  // 聚合输出
  return Array.from(map.values())
    .map((st) => {
      const avgCycleDays =
        st.cycleDays.length > 0
          ? st.cycleDays.reduce((a, b) => a + b, 0) / st.cycleDays.length
          : null;
      const cycleStd =
        st.cycleDays.length > 1
          ? Math.sqrt(
              st.cycleDays.reduce(
                (sum, d) =>
                  sum +
                  Math.pow(
                    d - st.cycleDays.reduce((a, b) => a + b, 0) / st.cycleDays.length,
                    2,
                  ),
                0,
              ) / st.cycleDays.length,
            )
          : null;

      return {
        name: st.name,
        email: st.email,
        avgCycleDays: avgCycleDays != null ? parseFloat(avgCycleDays.toFixed(1)) : null,
        cycleStd: cycleStd != null ? parseFloat(cycleStd.toFixed(1)) : null,
        avgPce: st.pceValues.length > 0
          ? parseFloat((st.pceValues.reduce((a, b) => a + b, 0) / st.pceValues.length).toFixed(2))
          : null,
        medPce: st.pceValues.length > 0
          ? parseFloat(median(st.pceValues).toFixed(2))
          : null,
        maxPce: st.pceValues.length > 0
          ? parseFloat(Math.max(...st.pceValues).toFixed(2))
          : null,
        totalTasks: st.totalTasks,
        completedTasks: st.completedTasks,
        overdueTasks: st.overdueTasks,
        batchCount: st.batchSet.size,
        pceDeviceCount: st.pceValues.length,
        updatedAt: new Date().toISOString(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/* ---------------- 解析 ---------------- */

function parseCloudTaskStats(raw: string): CloudTaskStat[] | null {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    return arr.filter((it): it is CloudTaskStat => {
      if (!it || typeof it !== 'object') return false;
      const o = it as Record<string, unknown>;
      return typeof o.name === 'string';
    });
  } catch {
    return null;
  }
}

/* ---------------- 拉取 ---------------- */

/**
 * 拉取云端任务统计数据：
 * 1. GitHub Contents API（仓库实时内容，公开仓库匿名可读）
 * 2. 失败时回退已部署静态站点
 * 返回 null 表示无云端数据或网络失败
 */
export async function fetchCloudTaskStats(): Promise<CloudTaskStat[] | null> {
  const cfg = loadCloudConfig();
  const { owner, repo } = cfg;

  // 通道 1：Contents API（实时）
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${CLOUD_TASK_STATS_PATH}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (res.ok) {
      const data = (await res.json()) as { content?: string; encoding?: string };
      if (data.content && data.encoding === 'base64') {
        const parsed = parseCloudTaskStats(decodeBase64Utf8(data.content));
        if (parsed) return parsed;
      }
    }
  } catch {
    // 网络失败，尝试回退
  }

  // 通道 2：已部署静态站点
  try {
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    const res = await fetch(`${base}shared/taskStats.json?t=${Date.now()}`);
    if (res.ok) {
      const parsed = parseCloudTaskStats(await res.text());
      if (parsed) return parsed;
    }
  } catch {
    // 双通道均失败
  }
  return null;
}

/* ---------------- 推送 ---------------- */

/** 获取云端文件当前 sha（禁用缓存，避免拿到过期 sha 导致 409） */
async function fetchCloudTaskStatsSha(cfg: CloudConfig): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${CLOUD_TASK_STATS_PATH}?t=${Date.now()}`,
    {
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`读取云端任务统计文件失败（HTTP ${res.status}）`);
  const data = (await res.json()) as { sha?: string };
  return typeof data.sha === 'string' ? data.sha : null;
}

/**
 * 推送任务统计数据到 GitHub 仓库
 * 409/422 冲突自动重试（最多 3 次，每次重新获取 sha）
 */
export async function pushCloudTaskStats(items: CloudTaskStat[]): Promise<{ ok: boolean; message: string }> {
  const cfg = loadCloudConfig();
  if (!cfg.token) return { ok: false, message: 'not-configured' };

  const content = encodeBase64Utf8(JSON.stringify(items, null, 2) + '\n');

  const doPut = async (sha: string | null) =>
    fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${CLOUD_TASK_STATS_PATH}`,
      {
        method: 'PUT',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'chore: 更新任务统计数据',
          content,
          ...(sha ? { sha } : {}),
        }),
      },
    );

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sha = await fetchCloudTaskStatsSha(cfg);
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