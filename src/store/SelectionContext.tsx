import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * 跨页面共享的批次选择状态（Comparison ↔ ReportEditor 同步）
 *
 * 持久化于 localStorage，刷新页面后恢复到上次选择；
 * 任一页面修改选择后，另一页面即时同步。
 */
interface SelectionContextValue {
  /** 已选批次 ID 列表 */
  selectedBatchIds: string[];
  /** Baseline 基准批次 ID（null = 未选） */
  baselineBatchId: string | null;
  /** 设置已选批次列表 + 可选 baseline */
  setSelection: (batchIds: string[], baselineId?: string | null) => void;
  /** 切换单个批次 */
  toggleBatch: (batchId: string) => void;
  /** 设置 baseline */
  setBaseline: (batchId: string | null) => void;
  /** 清空全部选择 */
  clear: () => void;
}

const STORAGE_KEY = 'dv-selection-state';

function loadSelection(): { batchIds: string[]; baseline: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { batchIds: [], baseline: null };
    const parsed = JSON.parse(raw);
    return {
      batchIds: Array.isArray(parsed.batchIds) ? parsed.batchIds : [],
      baseline: typeof parsed.baseline === 'string' ? parsed.baseline : null,
    };
  } catch {
    return { batchIds: [], baseline: null };
  }
}

function saveSelection(batchIds: string[], baseline: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ batchIds, baseline }));
  } catch {
    // localStorage 不可用
  }
}

const SelectionContext = createContext<SelectionContextValue>({
  selectedBatchIds: [],
  baselineBatchId: null,
  setSelection: () => {},
  toggleBatch: () => {},
  setBaseline: () => {},
  clear: () => {},
});

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>(() => loadSelection().batchIds);
  const [baselineBatchId, setBaselineBatchId] = useState<string | null>(
    () => loadSelection().baseline,
  );

  // 持久化
  useEffect(() => {
    saveSelection(selectedBatchIds, baselineBatchId);
  }, [selectedBatchIds, baselineBatchId]);

  const setSelection = useCallback((batchIds: string[], baselineId?: string | null) => {
    setSelectedBatchIds(batchIds.filter(Boolean));
    if (baselineId !== undefined) {
      setBaselineBatchId(baselineId);
    } else if (batchIds.length > 0) {
      setBaselineBatchId((prev) => (prev && batchIds.includes(prev) ? prev : batchIds[0]));
    } else {
      setBaselineBatchId(null);
    }
  }, []);

  const toggleBatch = useCallback((batchId: string) => {
    setSelectedBatchIds((prev) => {
      const next = prev.includes(batchId)
        ? prev.filter((id) => id !== batchId)
        : [...prev, batchId];
      // 若 baseline 被取消勾选，自动切换到第一个
      setBaselineBatchId((cur) => {
        if (cur === batchId && next.length > 0) return next[0];
        if (cur === batchId) return null;
        return cur;
      });
      return next;
    });
  }, []);

  const setBaseline = useCallback((batchId: string | null) => {
    setBaselineBatchId(batchId);
  }, []);

  const clear = useCallback(() => {
    setSelectedBatchIds([]);
    setBaselineBatchId(null);
  }, []);

  return (
    <SelectionContext.Provider
      value={{ selectedBatchIds, baselineBatchId, setSelection, toggleBatch, setBaseline, clear }}
    >
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection(): SelectionContextValue {
  return useContext(SelectionContext);
}