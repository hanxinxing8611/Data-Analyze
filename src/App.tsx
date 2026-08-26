import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DataProvider } from './store/DataContext';
import { CriteriaProvider } from './store/CriteriaContext';
import { SelectionProvider } from './store/SelectionContext';
import { ToastProvider } from './components/Toast';
import AppLayout from './components/layout/AppLayout';
import { Loading } from './components/ui';

/* 路由级代码分割：首屏只加载当前页面所需的依赖
   （报告页的 jspdf/exceljs/html2canvas、对比页的 echarts 等 heavyweight
   依赖拆到独立 chunk，访问对应页面时才下载） */
const Dashboard = lazy(() => import('./pages/Dashboard'));
const DataManagement = lazy(() => import('./pages/DataManagement'));
const Comparison = lazy(() => import('./pages/Comparison'));
const ReportEditor = lazy(() => import('./pages/ReportEditor'));
const Schedule = lazy(() => import('./pages/Schedule'));
const TaskStats = lazy(() => import('./pages/TaskStats'));
const Settings = lazy(() => import('./pages/Settings'));

export default function App() {
  return (
    <ToastProvider>
    <DataProvider>
      <CriteriaProvider>
        <SelectionProvider>
          <HashRouter>
            <Suspense fallback={<Loading text="正在加载页面…" />}>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/data" element={<DataManagement />} />
                <Route path="/import" element={<Navigate to="/data" replace />} />
                <Route path="/browser" element={<Navigate to="/data" replace />} />
                <Route path="/storage" element={<Navigate to="/" replace />} />
                <Route path="/comparison" element={<Comparison />} />
                <Route path="/report" element={<ReportEditor />} />
                <Route path="/schedule" element={<Schedule />} />
                <Route path="/stats" element={<TaskStats />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
            </Suspense>
          </HashRouter>
        </SelectionProvider>
      </CriteriaProvider>
    </DataProvider>
    </ToastProvider>
  );
}
