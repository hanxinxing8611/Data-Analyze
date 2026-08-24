import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../store/DataContext';
import { useCriteria } from '../store/CriteriaContext';
import { queryBatches, queryDashboardStats, querySamples } from '../database/db';
import { fmt, median } from '../utils/statistics';
import { isValidDevice, metricValue } from '../report/reportData';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, StatCard } from '../components/ui';
import type { BatchSummary, SampleRecord } from '../types';

export default function Dashboard() {
  const { dbReady, version } = useData();
  const { thresholds } = useCriteria();
  const [stats, setStats] = useState<ReturnType<typeof queryDashboardStats> | null>(null);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [records, setRecords] = useState<SampleRecord[]>([]);

  useEffect(() => {
    if (!dbReady) return;
    setStats(queryDashboardStats());
    setBatches(queryBatches());
    setRecords(querySamples());
  }, [dbReady, version]);

  /* 各批次关键指标（PCE 冠军/中位、Voc*FF 平均），基于有效测试记录随口径实时重算，与报告页口径一致 */
  const batchMetrics = useMemo(() => {
    const m = new Map<
      string,
      { champion: number | null; medianPce: number | null; vocffMean: number | null }
    >();
    for (const b of batches) {
      const valid = records.filter((r) => r.batch_id === b.batch_id && isValidDevice(r, thresholds));
      const effs = valid.map((r) => r.efficiency).filter((v): v is number => v != null);
      const vocffs = valid
        .map((r) => metricValue(r, 'vocff'))
        .filter((v) => !isNaN(v));
      m.set(b.batch_id, {
        champion: effs.length > 0 ? Math.max(...effs) : null,
        medianPce: effs.length > 0 ? median(effs) : null,
        vocffMean: vocffs.length > 0 ? vocffs.reduce((a, c) => a + c, 0) / vocffs.length : null,
      });
    }
    return m;
  }, [batches, records, thresholds]);

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
                    <th>PCE冠军 (%)</th>
                    <th>PCE中位 (%)</th>
                    <th>VOC*FF平均 (V)</th>
                    <th>最近测试日期</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {batches.map((b) => {
                    const m = batchMetrics.get(b.batch_id);
                    return (
                      <tr key={b.batch_id}>
                        <td className="font-mono font-medium text-slate-900">{b.batch_id}</td>
                        <td>{b.material_type}</td>
                        <td className="font-mono">{b.sample_count}</td>
                        <td>
                          <span className="font-mono text-slate-500">
                            {b.forward_count} / {b.reverse_count}
                          </span>
                        </td>
                        <td className="font-mono">
                          <Badge tone="green">{fmt(m?.champion ?? NaN)}</Badge>
                        </td>
                        <td className="font-mono">{fmt(m?.medianPce ?? NaN)}</td>
                        <td className="font-mono">{fmt(m?.vocffMean ?? NaN, 3)}</td>
                        <td className="text-slate-500">{b.last_test_date || '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="border-t border-slate-100 px-5 py-2.5 text-[11px] text-slate-400">
              PCE冠军 / PCE中位 / VOC*FF平均 均基于各批次有效测试记录统计（口径可在「报告生成」页调整）
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
