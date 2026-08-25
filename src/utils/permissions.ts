/**
 * 权限管理
 *
 * 规则：
 * - 管理员列表为空（云端未配置）→ 全员管理员（向后兼容）
 * - 当前工程师姓名在管理员列表中 → 管理员，拥有全部权限
 * - 当前工程师不在列表中 → 工程师，无增删改验证计划和修改系统设置的权限
 *
 * 管理员列表来源：云端 settings.json（adminNames 字段），
 * 页面打开时自动拉取并写入本地 localStorage。
 */

import { useCallback, useMemo, useState } from 'react';
import { loadAdminNames } from './cloudSettings';

/** 当前工程师本地存储 key */
const CURRENT_ENGINEER_KEY = 'dv-current-engineer';

/** 获取当前登录的工程师姓名 */
export function getCurrentEngineer(): string {
  try {
    return localStorage.getItem(CURRENT_ENGINEER_KEY) || '';
  } catch {
    return '';
  }
}

/** 设置当前登录的工程师姓名 */
export function setCurrentEngineer(name: string): void {
  try {
    localStorage.setItem(CURRENT_ENGINEER_KEY, name);
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

/** React Hook：响应式权限判断 */
export function usePermission(): {
  isAdmin: boolean;
  canWrite: boolean;
  engineerName: string;
  /** 刷新权限（管理员列表变化后调用） */
  refresh: () => void;
} {
  const [version, setVersion] = useState(0);
  const engineerName = useMemo(() => getCurrentEngineer(), [version]);
  const admin = useMemo(() => isAdmin(engineerName), [engineerName, version]);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { isAdmin: admin, canWrite: admin, engineerName, refresh };
}