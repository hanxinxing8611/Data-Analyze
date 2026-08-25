import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DataProvider } from './store/DataContext';
import { CriteriaProvider } from './store/CriteriaContext';
import { SelectionProvider } from './store/SelectionContext';
import { ToastProvider } from './components/Toast';
import AppLayout from './components/layout/AppLayout';
import Dashboard from './pages/Dashboard';
import DataManagement from './pages/DataManagement';
import Comparison from './pages/Comparison';
import ReportEditor from './pages/ReportEditor';
import Schedule from './pages/Schedule';
import TaskStats from './pages/TaskStats';
import Settings from './pages/Settings';

export default function App() {
  return (
    <ToastProvider>
    <DataProvider>
      <CriteriaProvider>
        <SelectionProvider>
          <HashRouter>
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
          </HashRouter>
        </SelectionProvider>
      </CriteriaProvider>
    </DataProvider>
    </ToastProvider>
  );
}
