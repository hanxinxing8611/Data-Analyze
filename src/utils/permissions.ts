/**
 * 权限管理
 *
 * 规则：
 * - 管理员列表为空（云端未配置）→ 全员管理员（向后兼容）
 * - 当前工程师姓名在管理员列表中 → 管理员，拥有全部权限
 * - 当前工程师不在列表中（含未选择身份）→ 工程师，无增删改验证计划和修改系统设置的权限
 *
 * 管理员列表来源：云端 settings.json（adminNames 字段），
 * 页面打开时自动拉取并写入本地 localStorage。
 *
 * 身份切换入口在左侧边栏（身份下拉选择器）；
 * 身份或管理员列表变化时通过 window 事件通知所有 usePermission 实例实时刷新。
 */

import { useEffect, useMemo, useState } from 'react';
import { loadAdminNames } from './cloudSettings';

/** 当前工程师（登录身份）本地存储 key */
const CURRENT_ENGINEER_KEY = 'dv-current-engineer';

/** 工程师列表本地存储 key（验证计划页写入） */
const ENGINEERS_KEY = 'dv-engineers';

/** 身份/管理员列表变化事件（跨组件实时刷新权限） */
const PERMISSION_CHANGE_EVENT = 'dv-permission-change';

/** 已保存的工程师条目（验证计划页自动保存） */
export interface EngineerEntry {
  name: string;
  email: string;
}

/** 获取当前登录的工程师姓名 */
export function getCurrentEngineer(): string {
  try {
    return localStorage.getItem(CURRENT_ENGINEER_KEY) || '';
  } catch {
    return '';
  }
}

/** 设置当前登录的工程师姓名（并通知全站刷新权限） */
export function setCurrentEngineer(name: string): void {
  try {
    localStorage.setItem(CURRENT_ENGINEER_KEY, name);
  } catch {
    /* 忽略 */
  }
  notifyPermissionChanged();
}

/** 读取已保存的工程师列表 */
export function loadEngineerList(): EngineerEntry[] {
  try {
    const raw = localStorage.getItem(ENGINEERS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is EngineerEntry =>
        !!e && typeof (e as EngineerEntry).name === 'string',
    );
  } catch {
    return [];
  }
}

/** 身份下拉候选：工程师列表 ∪ 管理员列表（去重，保证管理员姓名始终可选） */
export function loadIdentityOptions(): string[] {
  const out: string[] = [];
  const push = (n: string) => {
    const t = n.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  loadEngineerList().forEach((e) => push(e.name));
  loadAdminNames().forEach(push);
  return out;
}

/** 通知所有 usePermission 实例重新读取身份与管理员列表 */
export function notifyPermissionChanged(): void {
  try {
    window.dispatchEvent(new Event(PERMISSION_CHANGE_EVENT));
  } catch {
    /* 忽略 */
  }
}

/** 判断当前用户是否为管理员 */
export function isAdmin(engineerName?: string): boolean {
  const name = (engineerName ?? getCurrentEngineer()).trim();
  if (!name) return false; // 未选择工程师身份 → 工程师
  const admins = loadAdminNames();
  if (admins.length === 0) return true; // 未配置管理员列表 → 全员管理员
  return admins.includes(name);
}

/** 判断当前用户是否有写权限（增删改验证计划、修改设置） */
export function canWrite(engineerName?: string): boolean {
  return isAdmin(engineerName);
}

/** React Hook：响应式权限判断（身份/管理员列表变化时自动刷新） */
export function usePermission(): {
  isAdmin: boolean;
  canWrite: boolean;
  engineerName: string;
} {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const handler = () => setVersion((v) => v + 1);
    window.addEventListener(PERMISSION_CHANGE_EVENT, handler);
    return () => window.removeEventListener(PERMISSION_CHANGE_EVENT, handler);
  }, []);

  const engineerName = useMemo(() => getCurrentEngineer(), [version]);
  const admin = useMemo(() => isAdmin(engineerName), [engineerName, version]);
  return { isAdmin: admin, canWrite: admin, engineerName };
}
