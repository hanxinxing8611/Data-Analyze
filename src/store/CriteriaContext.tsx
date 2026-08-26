import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  CRITERIA_STORAGE_KEY,
  DEFAULT_THRESHOLDS,
  loadActiveCriteriaName,
  loadCriteriaSets,
  loadThresholds,
  saveActiveCriteriaName,
  saveCriteriaSets,
  type CriteriaThresholds,
} from '../report/reportData';
import { applyCloudSettings, fetchCloudSettings } from '../utils/cloudSettings';
import { notifyPermissionChanged } from '../utils/permissions';

/**
 * 统计口径全局状态：多套判定标准（如 微晶 / 盐 / 其他），由系统设置页（管理员）增改删，
 * 持久化于 localStorage；报告生成页按需选择当前生效的一套，所有统计实时重算。
 * 云端共享：打开页面时自动拉取 shared/settings.json 的 criteriaSets，云端值优先应用
 *（判定标准影响全部报告统计，团队须保持一致）。
 */
interface CriteriaContextValue {
  /** 当前生效的一套判定标准 */
  thresholds: CriteriaThresholds;
  /** 当前生效的判定标准名称 */
  activeName: string;
  /** 全部判定标准（名称 → 口径） */
  criteriaSets: Record<string, CriteriaThresholds>;
  /** 保存到指定一套（管理员在系统设置中调用；含持久化与全局刷新） */
  saveCriteriaSet: (name: string, t: CriteriaThresholds) => void;
  /** 删除一套（至少保留一套；删除当前套时自动切到第一套） */
  deleteCriteriaSet: (name: string) => void;
  /** 切换当前生效的判定标准（报告生成页选择） */
  setActiveCriteria: (name: string) => void;
  /** 兼容旧接口：保存到当前生效的一套 */
  saveThresholds: (t: CriteriaThresholds) => void;
  /** 兼容旧接口：当前套恢复默认 */
  resetThresholds: () => void;
}

const CriteriaContext = createContext<CriteriaContextValue>({
  thresholds: DEFAULT_THRESHOLDS,
  activeName: '',
  criteriaSets: {},
  saveCriteriaSet: () => {},
  deleteCriteriaSet: () => {},
  setActiveCriteria: () => {},
  saveThresholds: () => {},
  resetThresholds: () => {},
});

export function CriteriaProvider({ children }: { children: ReactNode }) {
  const [criteriaSets, setCriteriaSets] = useState<Record<string, CriteriaThresholds>>(() => loadCriteriaSets());
  const [activeName, setActiveName] = useState<string>(() => loadActiveCriteriaName());

  /** 打开页面时拉取云端设置：有则应用（云端优先，保持团队口径一致），失败静默保留本地 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cloud = await fetchCloudSettings();
      if (!cloud || cancelled) return;
      const applied = applyCloudSettings(cloud);
      if (applied.criteria) {
        // 云端判定标准已写入 localStorage（多套优先，旧版单套已迁移），重新加载
        setCriteriaSets(loadCriteriaSets());
        setActiveName(loadActiveCriteriaName());
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

  const saveCriteriaSet = useCallback(
    (name: string, t: CriteriaThresholds) => {
      setCriteriaSets((prev) => {
        const next = { ...prev, [name]: t };
        saveCriteriaSets(next);
        return next;
      });
      // 同步旧版单套键（兼容云端旧字段读取）
      try {
        if (name === activeName) {
          localStorage.setItem(CRITERIA_STORAGE_KEY, JSON.stringify(t));
        }
      } catch {
        // 忽略
      }
    },
    [activeName],
  );

  const deleteCriteriaSet = useCallback(
    (name: string) => {
      setCriteriaSets((prev) => {
        const names = Object.keys(prev);
        if (names.length <= 1) return prev; // 至少保留一套
        const next = { ...prev };
        delete next[name];
        saveCriteriaSets(next);
        if (name === activeName) {
          const first = Object.keys(next)[0];
          saveActiveCriteriaName(first);
          setActiveName(first);
        }
        return next;
      });
    },
    [activeName],
  );

  const setActiveCriteria = useCallback((name: string) => {
    saveActiveCriteriaName(name);
    setActiveName(name);
  }, []);

  const saveThresholds = useCallback(
    (t: CriteriaThresholds) => {
      saveCriteriaSet(activeName, t);
    },
    [activeName, saveCriteriaSet],
  );

  const resetThresholds = useCallback(() => {
    saveCriteriaSet(activeName, { ...DEFAULT_THRESHOLDS });
  }, [activeName, saveCriteriaSet]);

  const thresholds = criteriaSets[activeName] ?? loadThresholds();

  return (
    <CriteriaContext.Provider
      value={{
        thresholds,
        activeName,
        criteriaSets,
        saveCriteriaSet,
        deleteCriteriaSet,
        setActiveCriteria,
        saveThresholds,
        resetThresholds,
      }}
    >
      {children}
    </CriteriaContext.Provider>
  );
}

export function useCriteria(): CriteriaContextValue {
  return useContext(CriteriaContext);
}
