import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  CRITERIA_STORAGE_KEY,
  DEFAULT_THRESHOLDS,
  loadThresholds,
  type CriteriaThresholds,
} from '../report/reportData';
import { applyCloudSettings, fetchCloudSettings } from '../utils/cloudSettings';
import { notifyPermissionChanged } from '../utils/permissions';

/**
 * 统计口径全局状态：阈值由系统设置页配置，持久化于 localStorage。
 * 报告页 / 汇总 / 差分等所有统计随当前阈值实时重算。
 * 云端共享：打开页面时自动拉取 shared/settings.json，云端值优先应用
 *（统计口径影响全部报告统计，团队须保持一致；收件人同步写入本地）。
 */
interface CriteriaContextValue {
  thresholds: CriteriaThresholds;
  /** 保存新阈值（含持久化） */
  saveThresholds: (t: CriteriaThresholds) => void;
  /** 恢复默认阈值 */
  resetThresholds: () => void;
}

const CriteriaContext = createContext<CriteriaContextValue>({
  thresholds: DEFAULT_THRESHOLDS,
  saveThresholds: () => {},
  resetThresholds: () => {},
});

export function CriteriaProvider({ children }: { children: ReactNode }) {
  const [thresholds, setThresholds] = useState<CriteriaThresholds>(() => loadThresholds());

  /** 打开页面时拉取云端设置：有则应用（云端优先，保持团队口径一致），失败静默保留本地 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cloud = await fetchCloudSettings();
      if (!cloud || cancelled) return;
      const applied = applyCloudSettings(cloud);
      if (applied.criteria && cloud.criteria) {
        setThresholds(cloud.criteria);
      }
      // 云端管理员列表（如有）已写入本地，通知全站刷新权限判断
      if (applied.roles) {
        notifyPermissionChanged();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveThresholds = useCallback((t: CriteriaThresholds) => {
    setThresholds(t);
    try {
      localStorage.setItem(CRITERIA_STORAGE_KEY, JSON.stringify(t));
    } catch {
      // localStorage 不可用（隐私模式等）时仅保留内存态
    }
  }, []);

  const resetThresholds = useCallback(() => {
    setThresholds({ ...DEFAULT_THRESHOLDS });
    try {
      localStorage.removeItem(CRITERIA_STORAGE_KEY);
    } catch {
      // 同上
    }
  }, []);

  return (
    <CriteriaContext.Provider value={{ thresholds, saveThresholds, resetThresholds }}>
      {children}
    </CriteriaContext.Provider>
  );
}

export function useCriteria(): CriteriaContextValue {
  return useContext(CriteriaContext);
}
