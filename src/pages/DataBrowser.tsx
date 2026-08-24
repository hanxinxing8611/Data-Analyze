import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../store/DataContext';
import { deleteSample, queryBatches, querySamples } from '../database/db';
import { fmt } from '../utils/statistics';
import { Badge, Button, Card, EmptyState, Loading, PageHeader } from '../components/ui';
import Icon from '../components/layout/Icon';
import type { BatchSummary, SampleFilter, SampleRecord } from '../types';

export default function DataBrowser() {
  const { dbReady, version, refresh } = useData();
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [samples, setSamples] = useState<SampleRecord[]>([]);
  const [filter, setFilter] = useState<SampleFilter>({ direction: 'all' });

  useEffect(() => {
    if (!dbReady) return;
    setBatches(queryBatches());
  }, [dbReady, version]);

  useEffect(() => {
    if (!dbReady) return;
    setSamples(querySamples(filter));
  }, [dbReady, version, filter]);

  if (!dbReady) return <Loading text="数据库初始化中…" />;

  const handleDelete = async (record: SampleRecord) => {
    if (!window.confirm(`确认删除样本「${record.sample_name}」？此操作不可撤销。`)) return;
    await deleteSample(record.id);
    refresh();
  };

  return (
    <div>
      <PageHeader
        title="数据管理"
        description="浏览、筛选已入库的样本测试记录"
        actions={
          <Link to="/import">
            <Button variant="secondary">导入数据</Button>
          </Link>
        }
      />

      {/* 筛选栏 */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={filter.batchId ?? ''}
          onChange={(e) => setFilter((f) => ({ ...f, batchId: e.target.value || undefined }))}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
        >
          <option value="">全部批次</option>
          {batches.map((b) => (
            <option key={b.batch_id} value={b.batch_id}>
              {b.batch_id}（{b.sample_count} 样本）
            </option>
          ))}
        </select>

        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
          {(
            [
              { key: 'all', label: '全部' },
              { key: 'forward', label: '正扫' },
              { key: 'reverse', label: '反扫' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setFilter((f) => ({ ...f, direction: opt.key }))}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                (filter.direction ?? 'all') === opt.key
                  ? 'bg-blue-600 font-medium text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="搜索样本名称…"
          value={filter.search ?? ''}
          onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value || undefined }))}
          className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
        />

        <span className="ml-auto text-xs text-slate-400">
          共 <b className="font-mono text-slate-600">{samples.length}</b> 条记录
        </span>
      </div>

      {/* 数据表 */}
      <Card bodyClassName="px-0 py-0">
        {samples.length === 0 ? (
          <EmptyState
            icon="database"
            title="暂无匹配数据"
            description="调整筛选条件，或导入新的 TXT 源文件"
            action={
              <Link to="/import">
                <Button>前往导入</Button>
              </Link>
            }
          />
        ) : (
          <div className="max-h-[calc(100vh-260px)] overflow-auto">
            <table className="data-table w-full">
              <thead className="sticky top-0 z-10 bg-slate-50">
                <tr>
                  <th>样本名称</th>
                  <th>批次</th>
                  <th>方向</th>
                  <th>Voc (V)</th>
                  <th>Jsc (mA/cm²)</th>
                  <th>FF</th>
                  <th>η (%)</th>
                  <th>Pm (mW)</th>
                  <th>测试日期</th>
                  <th>操作员</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {samples.map((s) => (
                  <tr key={s.id}>
                    <td className="font-mono font-medium text-slate-900">{s.sample_name}</td>
                    <td className="font-mono text-slate-500">{s.batch_id}</td>
                    <td>
                      <Badge tone={s.is_reverse ? 'blue' : 'slate'}>
                        {s.is_reverse ? '反扫' : '正扫'}
                      </Badge>
                    </td>
                    <td className="font-mono">{fmt(s.voc_V)}</td>
                    <td className="font-mono">{fmt(s.jsc_mA_cm2)}</td>
                    <td className="font-mono">{fmt(s.ff)}</td>
                    <td className="font-mono font-medium text-slate-900">{fmt(s.efficiency)}</td>
                    <td className="font-mono">{fmt(s.pm_mW)}</td>
                    <td className="text-slate-500">{s.test_date || '-'}</td>
                    <td className="text-slate-500">{s.operator || '-'}</td>
                    <td>
                      <button
                        onClick={() => handleDelete(s)}
                        className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                        title="删除该样本"
                      >
                        <Icon name="trash" className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
