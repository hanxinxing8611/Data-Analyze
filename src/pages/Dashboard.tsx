import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../store/DataContext';
import { queryBatches, queryDashboardStats } from '../database/db';
import { fmt } from '../utils/statistics';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, StatCard } from '../components/ui';
import type { BatchSummary } from '../types';

export default function Dashboard() {
  const { dbReady, version } = useData();
  const [stats, setStats] = useState<ReturnType<typeof queryDashboardStats> | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);

  useEffect(() => {
    if (!dbReady) return;
    setStats(queryDashboardStats());
    setBatches(queryBatches());
  }, [dbReady, version]);

  if (!dbReady || !stats) return <Loading text="数据库初始化中…" />;

  const hasData = stats.totalSamples > 0;

  return (
    <div>
      <PageHeader
        title="数据总览"
        description="器件验证数据概况与快捷入口"
        actions={
          <>
            <Link to="/data">
              <Button variant="secondary">导入数据</Button>
            </Link>
            <Link to="/comparison">
              <Button>对比分析</Button>
            </Link>
          </>
        }
      />

      {!hasData ? (
        <Card>
          <EmptyState
            icon="database"
            title="暂无数据"
            description="请先导入 IV 测试导出的 TXT 源文件，系统将自动解析样本参数、识别材料批次并入库"
            action={
              <Link to="/data">
                <Button>
                  <span>前往导入</span>
                </Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          {/* 统计卡片 */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="样本总数" value={String(stats.totalSamples)} unit="条" />
            <StatCard label="材料批次" value={String(stats.totalBatches)} unit="个" />
            <StatCard
              label="平均效率"
              value={fmt(stats.avgEfficiency, 2)}
              unit="%"
              hint="全部样本平均"
            />
            <StatCard
              label="最高效率"
              value={fmt(stats.maxEfficiency, 2)}
              unit="%"
              hint="全部样本最优"
            />
          </div>

          {/* 批次概览 */}
          <Card title="批次概览" className="mt-6" bodyClassName="px-0 py-0">
            <div className="max-h-[520px] overflow-auto">
              <table className="data-table w-full">
                <thead className="sticky top-0 bg-slate-50">
                  <tr>
                    <th>批次</th>
                    <th>材料类型</th>
                    <th>样本数</th>
                    <th>正扫 / 反扫</th>
                    <th>平均效率 (%)</th>
                    <th>最高效率 (%)</th>
                    <th>最近测试日期</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {batches.map((b) => (
                    <tr key={b.batch_id}>
                      <td className="font-mono font-medium text-slate-900">{b.batch_id}</td>
                      <td>{b.material_type}</td>
                      <td className="font-mono">{b.sample_count}</td>
                      <td>
                        <span className="font-mono text-slate-500">
                          {b.forward_count} / {b.reverse_count}
                        </span>
                      </td>
                      <td className="font-mono">{fmt(b.avg_efficiency)}</td>
                      <td className="font-mono">
                        <Badge tone="green">{fmt(b.max_efficiency)}</Badge>
                      </td>
                      <td className="text-slate-500">{b.last_test_date || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
