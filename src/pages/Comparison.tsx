import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../store/DataContext';
import { useSelection } from '../store/SelectionContext';
import { useCriteria } from '../store/CriteriaContext';
import { queryBatches, querySamples } from '../database/db';
import { computeBoxplot, fmt, median } from '../utils/statistics';
import {
  criteriaTextShort,
  getVerdict,
  isValidDevice,
  verdictLabelOf,
  type CriteriaThresholds,
} from '../report/reportData';
import { Button, Card, EmptyState, Loading, PageHeader, Badge } from '../components/ui';
import BoxplotChart, { type BoxplotData } from '../components/charts/BoxplotChart';
import type { BatchSummary, SampleRecord } from '../types';

/** 对比指标定义 */
const METRICS = [
  { key: 'efficiency', label: 'EFF', unit: '%' },
  { key: 'vocff', label: 'VOC·FF', unit: 'V' },
  { key: 'voc_V', label: 'VOC', unit: 'V' },
  { key: 'jsc_mA_cm2', label: 'JSC', unit: 'mA/cm²' },
] as const;

type MetricKey = (typeof METRICS)[number]['key'];

function metricValue(record: SampleRecord, key: MetricKey): number {
  if (key === 'vocff') {
    return record.voc_V != null && record.ff != null ? record.voc_V * record.ff : NaN;
  }
  const v = record[key];
  return v != null ? v : NaN;
}

/* ================= 判定逻辑（统一使用 reportData 中的 getVerdict） ================= */

interface BatchPceStats {
  champion: number;
  median: number;
  /** 有效测试记录平均 Voc·FF（V） */
  vocffMean: number;
  /** 有效测试记录数（符合口径的反扫记录数） */
  count: number;
  /** 反扫测试记录总数 */
  total: number;
}

interface DiffResult {
  batchId: string;
  champion: number;
  championDelta: number;
  median: number;
  medianDelta: number;
  /** 有效测试记录平均 Voc·FF（V）及相对基准差值 */
  vocffMean: number;
  vocffMeanDelta: number;
  /** 有效测试记录数（符合口径的反扫记录数） */
  validCount: number;
  /** 反扫测试记录总数 */
  totalCount: number;
  verdict: '优秀' | '不合格';
}

/** 差值配色：>0 绿（更优），<0 红，=0 中性 */
function deltaTone(v: number): string {
  return v > 0 ? 'text-emerald-600' : v < 0 ? 'text-red-500' : 'text-slate-400';
}
function deltaText(v: number): string {
  return `${v > 0 ? '+' : ''}${fmt(v, 2)}`;
}

function generateConclusion(
  baselineId: string,
  baselineChampion: number,
  baselineMedian: number,
  diffs: DiffResult[],
  thresholds: CriteriaThresholds,
): string {
  if (diffs.length === 0) return '请选择至少 1 个对比批次。';
  const excellent = diffs.filter((d) => d.verdict === '优秀');
  const unqualified = diffs.filter((d) => d.verdict === '不合格');
  const verdictLabel = verdictLabelOf(thresholds);
  const lines: string[] = [];
  lines.push(
    `以「${baselineId}」为基准（冠军 PCE = ${fmt(baselineChampion)}%，中位 PCE = ${fmt(baselineMedian)}%，基于有效测试记录统计），` +
      `对 ${diffs.length} 个对比样品批次进行判定（优秀判定：${verdictLabel}）。`,
  );
  if (excellent.length > 0) {
    lines.push(
      `优秀批次 ${excellent.length} 个：${excellent.map((d) => `「${d.batchId}」`).join('、')}。` +
      `满足${verdictLabel}，综合性能优于基准。`,
    );
  } else {
    lines.push('本轮无批次达到优秀标准。');
  }
  if (unqualified.length > 0) {
    const reasons = unqualified
      .map((d) => {
        const parts: string[] = [];
        if (thresholds.championRule.enabled && d.championDelta < thresholds.championRule.threshold)
          parts.push(`PCE冠军 Δ=${fmt(d.championDelta, 2)}＜${thresholds.championRule.threshold}`);
        if (thresholds.medianRule.enabled && d.medianDelta < thresholds.medianRule.threshold)
          parts.push(`PCE中位 Δ=${fmt(d.medianDelta, 2)}＜${thresholds.medianRule.threshold}`);
        if (thresholds.vocffRule.enabled && d.vocffMeanDelta < thresholds.vocffRule.threshold)
          parts.push(`Voc*FF平均 Δ=${fmt(d.vocffMeanDelta, 2)}＜${thresholds.vocffRule.threshold}`);
        if (parts.length === 0) parts.push('Δ 未达判定阈值');
        return `「${d.batchId}」（${parts.join('，')}）`;
      })
      .join('；');
    lines.push(
      `不合格批次 ${unqualified.length} 个：${unqualified.map((d) => `「${d.batchId}」`).join('、')}。` +
      `未满足 ${verdictLabel}（${reasons}）。`,
    );
  }
  /* Voc·FF 对比（平均值口径，参考指标，不参与优秀判定） */
  const meanBetter = diffs.filter((d) => d.vocffMeanDelta > 0);
  lines.push(
    `Voc·FF 对比：平均 Voc·FF 优于基准的批次 ${meanBetter.length}/${diffs.length} 个` +
      (meanBetter.length > 0
        ? `（${meanBetter.map((d) => `「${d.batchId}」Δ=${fmt(d.vocffMeanDelta)}`).join('、')}）`
        : '') +
      '。',
  );
  return lines.join('\n\n');
}

/* ======================================== */

export default function Comparison() {
  const { dbReady, version } = useData();
  const { selectedBatchIds, baselineBatchId, toggleBatch, setBaseline, setSelection } =
    useSelection();
  const { thresholds } = useCriteria();

  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [records, setRecords] = useState<SampleRecord[]>([]);

  useEffect(() => {
    if (!dbReady) return;
    setBatches(queryBatches());
  }, [dbReady, version]);

  useEffect(() => {
    if (!dbReady) return;
    setRecords(querySamples({ direction: 'all' }));
  }, [dbReady, version]);

  // 首次加载时，若从未选择过批次，默认勾选前 4 个
  useEffect(() => {
    if (batches.length > 0 && selectedBatchIds.length === 0) {
      const init = batches.slice(0, Math.min(4, batches.length)).map((b) => b.batch_id);
      setSelection(init, init[0]);
    }
  }, [batches]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = selectedBatchIds;
  const baseline = baselineBatchId;

  /* 各批次有效测试记录数与反扫记录数（批次标签「有效 X/Y」显示，随口径实时重算，与报告页一致） */
  const validCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of records) {
      if (isValidDevice(r, thresholds)) m.set(r.batch_id, (m.get(r.batch_id) ?? 0) + 1);
    }
    return m;
  }, [records, thresholds]);
  const reverseCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of records) {
      if (r.is_reverse === 1) m.set(r.batch_id, (m.get(r.batch_id) ?? 0) + 1);
    }
    return m;
  }, [records]);

  /** 选中批次的样本（Baseline 永远排在最前，其余按选择顺序） */
  const selectedRecords = useMemo(() => {
    const map = new Map<string, SampleRecord[]>();
    for (const r of records) {
      if (!selected.includes(r.batch_id)) continue;
      const list = map.get(r.batch_id) ?? [];
      list.push(r);
      map.set(r.batch_id, list);
    }
    const ids =
      baseline && selected.includes(baseline)
        ? [baseline, ...selected.filter((id) => id !== baseline)]
        : selected;
    return ids
      .map((batchId) => ({ batchId, records: map.get(batchId) ?? [] }))
      .filter((g) => g.records.length > 0);
  }, [records, selected, baseline]);

  /** 各批次 PCE / Voc·FF 统计（基于有效测试记录 = 符合口径的反扫记录，与报告统计口径一致） */
  const batchStats = useMemo(() => {
    const map = new Map<string, BatchPceStats>();
    for (const g of selectedRecords) {
      // 统计基于有效测试记录（反扫且满足 PCE/FF/电阻阈值）；「有效 X/Y」= 符合口径反扫数 / 反扫总数
      const valid = g.records.filter((r) => isValidDevice(r, thresholds));
      const eff = valid.map((r) => r.efficiency).filter((v): v is number => v != null);
      const vocff = valid
        .map((r) => metricValue(r, 'vocff'))
        .filter((v) => !isNaN(v));
      map.set(g.batchId, {
        champion: eff.length > 0 ? Math.max(...eff) : NaN,
        median: median(eff),
        vocffMean: vocff.length > 0 ? vocff.reduce((a, b) => a + b, 0) / vocff.length : NaN,
        count: valid.length,
        total: g.records.filter((r) => r.is_reverse === 1).length,
      });
    }
    return map;
  }, [selectedRecords, thresholds]);

  /** Baseline 统计 */
  const baselineStats = useMemo(() => {
    if (!baseline) return null;
    return batchStats.get(baseline) ?? null;
  }, [baseline, batchStats]);

  /** 各批次 vs Baseline 的差值（PCE 与 Voc·FF 平均值，统一使用 getVerdict）；
   *  守卫：基准批次无有效测试记录（冠军/中位为 NaN）时不计算，避免 NaN 差值误判 */
  const diffResults = useMemo(() => {
    if (!baselineStats || !baseline) return [];
    if (isNaN(baselineStats.champion) || isNaN(baselineStats.median)) return [];
    const results: DiffResult[] = [];
    for (const g of selectedRecords) {
      if (g.batchId === baseline) continue;
      const s = batchStats.get(g.batchId);
      if (!s || isNaN(s.champion)) continue;
      const championDelta = s.champion - baselineStats.champion;
      const medianDelta = s.median - baselineStats.median;
      const vocffMeanDelta = s.vocffMean - baselineStats.vocffMean;
      results.push({
        batchId: g.batchId,
        champion: s.champion,
        championDelta,
        median: s.median,
        medianDelta,
        vocffMean: s.vocffMean,
        vocffMeanDelta,
        validCount: s.count,
        totalCount: s.total,
        verdict: getVerdict(championDelta, medianDelta, vocffMeanDelta, thresholds),
      });
    }
    return results;
  }, [baseline, baselineStats, selectedRecords, batchStats, thresholds]);

  /** 分析结论（基准批次无有效测试记录时给出明确提示，而非误报"请选择批次"） */
  const conclusion = useMemo(() => {
    if (!baseline || !baselineStats) return '';
    if (isNaN(baselineStats.champion) || isNaN(baselineStats.median)) {
      return `基准批次「${baseline}」在当前统计口径下无有效测试记录，无法进行差值对比；请调整统计口径（报告生成页）或更换基准批次。`;
    }
    return generateConclusion(baseline, baselineStats.champion, baselineStats.median, diffResults, thresholds);
  }, [baseline, baselineStats, diffResults, thresholds]);

  /** 箱线图数据 */
  const chartData = useMemo(() => {
    const build = (key: MetricKey): BoxplotData => {
      const categories: string[] = [];
      const boxes: (number | null)[][] = [];
      const points: [number, number][] = [];
      for (const group of selectedRecords) {
        // 箱线图与报告一致：统计有效测试记录（反扫且符合口径阈值）
        const values = group.records
          .filter((r) => isValidDevice(r, thresholds))
          .map((r) => metricValue(r, key))
          .filter((v) => !isNaN(v));
        if (values.length === 0) continue;
        const stats = computeBoxplot(values);
        categories.push(group.batchId);
        boxes.push([stats.lowerWhisker, stats.q1, stats.median, stats.q3, stats.upperWhisker]);
        values.forEach((v) => points.push([categories.length - 1, v]));
      }
      return { categories, boxes, points };
    };
    return METRICS.map((m) => ({ metric: m, data: build(m.key) }));
  }, [selectedRecords, thresholds]);

  if (!dbReady) return <Loading text="数据库初始化中…" />;

  const allSelected = selected.length === batches.length && batches.length > 0;

  return (
    <div>
      <PageHeader
        title="对比分析"
        description={`选择 Baseline 基准批次，对比其他材料批次的综合性能。统计基于各批次有效测试记录 = ${criteriaTextShort(thresholds)}；有效 X/Y = 符合口径反扫数 / 反扫总数`}
      />

      {batches.length === 0 ? (
        <Card>
          <EmptyState
            icon="chart"
            title="暂无可对比的数据"
            description="请先导入 TXT 源文件"
            action={<Link to="/data"><Button>前往导入</Button></Link>}
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {/* 批次选择 + Baseline */}
          <Card
            title="批次选择与 Baseline"
            extra={
              <span className="text-[11px] text-slate-400">
                已选 {selected.length}/{batches.length} 个批次
              </span>
            }
            bodyClassName="px-5 py-4"
          >
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <button
                onClick={() =>
                  setSelection(allSelected ? [] : batches.map((b) => b.batch_id))
                }
                className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-600"
              >
                {allSelected ? '取消全选' : '全选'}
              </button>
              <button
                onClick={() => setSelection([])}
                disabled={selected.length === 0}
                className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-red-300 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                清空
              </button>
            </div>

            {/* Baseline 说明 */}
            <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span className="shrink-0 font-semibold">⚑ Baseline</span>
              <span>
                当前基准：{baseline ? <span className="font-mono font-semibold">{baseline}</span> : '未选择'}
                ；点击批次标签右侧「设为基准」切换
              </span>
            </div>

            {/* 批次标签 */}
            <div className="flex flex-wrap gap-2">
              {batches.map((b) => {
                const active = selected.includes(b.batch_id);
                const valid = validCounts.get(b.batch_id) ?? 0;
                const reverse = reverseCounts.get(b.batch_id) ?? 0;
                const isBase = b.batch_id === baseline;
                return (
                  <div
                    key={b.batch_id}
                    className={`inline-flex items-center divide-x rounded-lg border transition-colors ${
                      isBase
                        ? 'border-amber-400 bg-amber-50'
                        : active
                          ? 'border-blue-600 bg-blue-600'
                          : 'border-slate-200 bg-white hover:border-blue-400'
                    }`}
                  >
                    <button
                      onClick={() => toggleBatch(b.batch_id)}
                      title={b.material_type ? `材料：${b.material_type}` : undefined}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs ${
                        active ? 'font-medium text-white' : 'text-slate-700'
                      }`}
                    >
                      <span className="font-mono">{b.batch_id}</span>
                      <span
                        className={active ? 'text-blue-200' : valid > 0 ? 'text-emerald-600' : 'text-red-400'}
                        title="有效 / 反扫总数（符合口径反扫数 / 反扫总数）"
                      >
                        {valid}/{reverse}
                      </span>
                    </button>
                    {active && (
                      <button
                        onClick={() => setBaseline(b.batch_id)}
                        className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          isBase
                            ? 'text-amber-700'
                            : 'text-blue-200 hover:bg-blue-500 hover:text-white'
                        }`}
                      >
                        {isBase ? '★ 基准' : '设为基准'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* 无数据 */}
          {selectedRecords.length === 0 ? (
            <Card>
              <EmptyState
                icon="chart"
                title="请选择要对比的批次"
                description="在上方批次列表中勾选至少 2 个批次，并指定一个为 Baseline 基准"
              />
            </Card>
          ) : (
            <>
              {/* 箱线图 2×2 */}
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                {chartData.map(({ metric, data }) =>
                  data.categories.length > 0 ? (
                    <Card key={metric.key} bodyClassName="px-2 py-2">
                      <BoxplotChart title={metric.label} unit={metric.unit} data={data} />
                    </Card>
                  ) : null,
                )}
              </div>

              {/* Baseline 差值对比表（PCE 与 Voc·FF 平均值） */}
              {baselineStats && diffResults.length > 0 && (
                <Card title="Baseline 差值对比" bodyClassName="px-0 py-0">
                  <div className="overflow-x-auto">
                    <table className="data-table w-full">
                      <thead>
                        <tr>
                          <th>批次</th>
                          <th>有效 / 总数</th>
                          <th>冠军 PCE</th>
                          <th>Δ 冠军</th>
                          <th>中位 PCE</th>
                          <th>Δ 中位</th>
                          <th>平均 Voc·FF</th>
                          <th>Δ 平均</th>
                          <th>判定</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="bg-amber-50/50">
                          <td className="font-mono font-semibold text-amber-800">⚑ {baseline}</td>
                          <td className="font-mono text-amber-700">
                            {baselineStats.count}/{baselineStats.total}
                          </td>
                          <td className="font-mono font-semibold text-amber-700">{fmt(baselineStats.champion)}</td>
                          <td className="font-mono text-slate-400">—</td>
                          <td className="font-mono font-semibold text-amber-700">{fmt(baselineStats.median)}</td>
                          <td className="font-mono text-slate-400">—</td>
                          <td className="font-mono font-semibold text-amber-700">{fmt(baselineStats.vocffMean)}</td>
                          <td className="font-mono text-slate-400">—</td>
                          <td><Badge tone="amber">基准</Badge></td>
                        </tr>
                        {diffResults.map((d) => (
                          <tr key={d.batchId}>
                            <td className="font-mono font-medium text-slate-900">{d.batchId}</td>
                            <td className="font-mono">{d.validCount}/{d.totalCount}</td>
                            <td className="font-mono">{fmt(d.champion)}</td>
                            <td className={`font-mono font-semibold ${deltaTone(d.championDelta)}`}>
                              {deltaText(d.championDelta)}
                            </td>
                            <td className="font-mono">{fmt(d.median)}</td>
                            <td className={`font-mono font-semibold ${deltaTone(d.medianDelta)}`}>
                              {deltaText(d.medianDelta)}
                            </td>
                            <td className="font-mono">{fmt(d.vocffMean)}</td>
                            <td className={`font-mono font-semibold ${deltaTone(d.vocffMeanDelta)}`}>
                              {deltaText(d.vocffMeanDelta)}
                            </td>
                            <td><Badge tone={d.verdict === '优秀' ? 'green' : 'red'}>{d.verdict}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="border-t border-slate-100 px-5 py-2 text-[11px] text-slate-400">
                    Δ = 目标 − 基准（基于各批次有效测试记录统计，差值 &lt;0 红色、&gt;0 绿色）；Voc·FF 为有效测试记录平均值（参考指标）；「有效 / 总数」= 符合口径反扫数 / 反扫总数；优秀判定口径见「系统设置」
                  </div>
                </Card>
              )}

              {/* 分析结论 */}
              {conclusion && (
                <Card title="分析结论" bodyClassName="px-5 py-4">
                  <div className="whitespace-pre-line text-sm leading-7 text-slate-700">{conclusion}</div>
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}