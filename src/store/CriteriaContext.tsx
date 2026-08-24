import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import {
  CRITERIA_STORAGE_KEY,
  DEFAULT_THRESHOLDS,
  loadThresholds,
  type CriteriaThresholds,
} from '../report/reportData';

/**
 * 统计口径全局状态：阈值由系统设置页配置，持久化于 localStorage。
 * 报告页 / 汇总 / 差分等所有统计随当前阈值实时重算。
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
