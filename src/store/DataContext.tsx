import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getDB } from '../database/db';

interface DataContextValue {
  /** 数据库是否初始化完成 */
  dbReady: boolean;
  /** 数据版本号：每次数据变更后递增，页面据此重新查询 */
  version: number;
  /** 数据变更后调用，触发所有订阅页面刷新 */
  refresh: () => void;
}

const DataContext = createContext<DataContextValue>({
  dbReady: false,
  version: 0,
  refresh: () => {},
});

export function DataProvider({ children }: { children: ReactNode }) {
  const [dbReady, setDbReady] = useState(false);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDB()
      .then(() => setDbReady(true))
      .catch((e) => {
        console.error('数据库初始化失败', e);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const refresh = () => setVersion((v) => v + 1);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-100 p-8">
        <div className="max-w-md rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <h2 className="text-base font-semibold text-red-700">数据库初始化失败</h2>
          <p className="mt-2 text-sm text-red-600">{error}</p>
          <p className="mt-3 text-xs text-red-500">请刷新页面重试，或检查浏览器是否支持 WebAssembly</p>
        </div>
      </div>
    );
  }

  return (
    <DataContext.Provider value={{ dbReady, version, refresh }}>
      {children}
    </DataContext.Provider>
  );
}

export function useData(): DataContextValue {
  return useContext(DataContext);
}
