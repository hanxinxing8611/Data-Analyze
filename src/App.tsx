import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DataProvider } from './store/DataContext';
import { CriteriaProvider } from './store/CriteriaContext';
import { SelectionProvider } from './store/SelectionContext';
import AppLayout from './components/layout/AppLayout';
import Dashboard from './pages/Dashboard';
import DataImport from './pages/DataImport';
import DataBrowser from './pages/DataBrowser';
import Comparison from './pages/Comparison';
import ReportEditor from './pages/ReportEditor';
import Settings from './pages/Settings';

export default function App() {
  return (
    <DataProvider>
      <CriteriaProvider>
        <SelectionProvider>
          <HashRouter>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/import" element={<DataImport />} />
                <Route path="/browser" element={<DataBrowser />} />
                <Route path="/comparison" element={<Comparison />} />
                <Route path="/report" element={<ReportEditor />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </HashRouter>
        </SelectionProvider>
      </CriteriaProvider>
    </DataProvider>
  );
}
