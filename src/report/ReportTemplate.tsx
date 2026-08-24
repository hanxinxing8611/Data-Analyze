import { forwardRef, Fragment } from 'react';
import BoxplotChart from '../components/charts/BoxplotChart';
import { fmt } from '../utils/statistics';
import {
  batchLabelOf,
  buildOverviewSummary,
  buildSummaryGroups,
  criteriaTextShort,
  metricValue,
  scanLabelOf,
  verdictLabelOf,
  type DiffResult,
  type MetricDef,
  type ReportData,
} from './reportData';
import type { ReportMetaInput } from '../types';

/* ================= 报告模板 =================
 *
 * 预览与导出共用：
 * - PDF 导出：对 paper 元素整体截图后按 [data-block] 分块切页；
 *   表格块记录行边界（tr），超高时整行换页并在续页重复表头
 * - Excel 导出：多工作表（报告信息 / 数据汇总 / 分布图 / 样本明细），图表截图嵌入
 *
 * 统计口径：基于各批次有效测试记录（反扫且符合 PCE/FF/电阻阈值的记录）；
 * 冠军 = 有效测试记录中 PCE 最高（取该次扫描全部参数）；中位 = 各指标中位数；
 * 最优 = 各指标独立极值（Rs 取最小）；Δ = 目标（冠军/中位）− 基准（冠军/中位）；
 * 「有效 X/Y」= 符合统计口径的反扫测试数 / 反扫测试总数。
 *
 * 注意：块间间距使用块内 padding（rect 可见），保证截图切分完整；
 *      含表格的块保持"一块一表"，表头才能在 PDF 续页重复；
 *      汇总表批次列拆为 3 行独立单元格（不用 rowspan——html2canvas 无法垂直居中
 *      合并单元格内容）：内容置于中位行（= 组垂直中心），上下空行隐藏内部分隔线；
 *      组首行 data-group-first 标记使 PDF 断页仅发生在组边界，批次列不被截断。
 */

function SectionTitle({ no, children }: { no?: string; children: string }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold leading-none text-slate-900">
      <span className="inline-block h-[14px] w-1 shrink-0 rounded bg-blue-600" />
      {no ? `${no}、` : ''}{children}
    </h2>
  );
}

function Paragraph({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap text-[13px] leading-7 text-slate-700">{text}</div>
  );
}

/** 报告头信息项（不截断，长文本换行完整显示） */
function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[12.5px]">
      <span className="shrink-0 text-slate-500">{label}：</span>
      <span className="font-medium text-slate-800">{value}</span>
    </div>
  );
}

/** 差值文本与配色：>0 绿（目标更优），<0 红，=0 中性 */
function deltaTone(v: number): string {
  return v > 0 ? 'text-emerald-700' : v < 0 ? 'text-red-600' : 'text-slate-500';
}
function deltaText(v: number): string {
  return `${v > 0 ? '+' : ''}${fmt(v, 2)}`;
}

/** Baseline 基准行信息 */
interface BaselineInfo {
  batchId: string;
  champion: number;
  median: number;
  vocffMean: number;
}

/** Baseline 差值行（PCE 与 Voc·FF 平均值对比） */
function BaselineDiffRow({
  d,
  isBaseline,
  baseline,
}: {
  d?: DiffResult;
  isBaseline?: boolean;
  baseline?: BaselineInfo;
}) {
  if (isBaseline && baseline) {
    return (
      <tr className="bg-amber-50/50">
        <td className="font-mono font-semibold text-amber-800">⚑ {baseline.batchId}</td>
        <td className="font-mono font-semibold text-amber-700">{fmt(baseline.champion)}</td>
        <td className="font-mono text-slate-400">—</td>
        <td className="font-mono font-semibold text-amber-700">{fmt(baseline.median)}</td>
        <td className="font-mono text-slate-400">—</td>
        <td className="font-mono font-semibold text-amber-700">{fmt(baseline.vocffMean)}</td>
        <td className="font-mono text-slate-400">—</td>
        <td className="text-xs font-semibold text-amber-700">基准</td>
      </tr>
    );
  }
  if (!d) return null;
  return (
    <tr>
      <td className="font-mono font-medium text-slate-900">{d.batchId}</td>
      <td className="font-mono">{fmt(d.champion)}</td>
      <td className={`font-mono font-semibold ${deltaTone(d.championDelta)}`}>
        {deltaText(d.championDelta)}
      </td>
      <td className="font-mono">{fmt(d.median)}</td>
      <td className={`font-mono font-semibold ${deltaTone(d.medianDelta)}`}>
        {deltaText(d.medianDelta)}
      </td>
      <td className="font-mono">{fmt(d.vocffMean)}</td>
      <td className={`font-mono font-semibold ${deltaTone(d.vocffMeanDelta ?? NaN)}`}>
        {deltaText(d.vocffMeanDelta ?? NaN)}
      </td>
      <td>
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
          d.verdict === '优秀'
            ? 'bg-emerald-50 text-emerald-700 ring-emerald-200/70'
            : 'bg-red-50 text-red-700 ring-red-200/70'
        }`}>
          {d.verdict}
        </span>
      </td>
    </tr>
  );
}

/* ---- 报告总览：批次 × 关键指标热力矩阵（先看结论再看细节） ---- */

/** 总览矩阵指标列（值列热力着色：底色浅 → 深 = 批次间低 → 高，加粗为该列最高批次） */
const OVERVIEW_METRIC_COLS = [
  { key: 'champion', label: 'PCE 冠军 (%)' },
  { key: 'medianEff', label: 'PCE 中位 (%)' },
  { key: 'medianVoc', label: 'Voc 中位 (V)' },
  { key: 'medianJsc', label: 'Jsc 中位 (mA/cm²)' },
  { key: 'medianFF', label: 'FF' },
  { key: 'vocffMean', label: 'Voc·FF 平均 (V)' },
] as const;

type OverviewRow = {
  batchId: string;
  isBaseline: boolean;
  champion: number;
  medianEff: number;
  medianVoc: number;
  medianJsc: number;
  medianFF: number;
  vocffMean: number;
  verdict?: '优秀' | '不合格';
};

/** 热力底色：值在批次间归一化后于蓝阶上取色（蓝-50 → 蓝-300）；该列有效值不足 2 个不着色 */
function heatBg(values: number[], v: number): string | undefined {
  if (!Number.isFinite(v)) return undefined;
  const finite = values.filter((x) => Number.isFinite(x));
  if (finite.length < 2) return undefined;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const t = max === min ? 0.5 : (v - min) / (max - min);
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${lerp(239, 147)}, ${lerp(246, 197)}, ${lerp(255, 254)})`;
}

/** 报告总览矩阵：批次（基准在前，⚑ 标记）× 关键指标，末列为质量判定（无基准时不显示） */
function OverviewMatrix({ data }: { data: ReportData }) {
  const rows: OverviewRow[] = data.groups.map((g) => ({
    batchId: g.batchId,
    isBaseline: data.baseline?.baselineBatchId === g.batchId,
    champion: g.champion?.efficiency ?? NaN,
    medianEff: data.metricStats['efficiency'][g.batchId]?.median ?? NaN,
    medianVoc: data.metricStats['voc_V'][g.batchId]?.median ?? NaN,
    medianJsc: data.metricStats['jsc_mA_cm2'][g.batchId]?.median ?? NaN,
    medianFF: data.metricStats['ff'][g.batchId]?.median ?? NaN,
    vocffMean: data.metricStats['vocff'][g.batchId]?.mean ?? NaN,
    verdict: data.baseline?.diffs.find((d) => d.batchId === g.batchId)?.verdict,
  }));
  const hasBaseline = !!data.baseline;
  const colValues = Object.fromEntries(
    OVERVIEW_METRIC_COLS.map((c) => [c.key, rows.map((r) => r[c.key] as number)]),
  ) as Record<(typeof OVERVIEW_METRIC_COLS)[number]['key'], number[]>;
  const colMax = Object.fromEntries(
    OVERVIEW_METRIC_COLS.map((c) => {
      const finite = colValues[c.key].filter((v) => Number.isFinite(v));
      return [c.key, finite.length > 0 ? Math.max(...finite) : NaN];
    }),
  ) as Record<(typeof OVERVIEW_METRIC_COLS)[number]['key'], number>;
  return (
    <table className="report-table w-full">
      <thead>
        <tr>
          <th>批次</th>
          {OVERVIEW_METRIC_COLS.map((c) => (
            <th key={c.key}>{c.label}</th>
          ))}
          {hasBaseline && <th>判定</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.batchId}>
            <td
              className={`font-mono font-medium ${
                r.isBaseline ? 'font-semibold text-amber-800' : 'text-slate-900'
              }`}
            >
              {r.isBaseline ? `⚑ ${batchLabelOf(r.batchId)}` : batchLabelOf(r.batchId)}
            </td>
            {OVERVIEW_METRIC_COLS.map((c) => {
              const v = r[c.key] as number;
              const bg = heatBg(colValues[c.key], v);
              const isMax = Number.isFinite(v) && v === colMax[c.key];
              return (
                <td
                  key={c.key}
                  className={`font-mono ${isMax ? 'font-semibold text-slate-900' : ''}`}
                  style={bg ? { backgroundColor: bg } : undefined}
                >
                  {Number.isFinite(v) ? fmt(v) : <span className="text-slate-300">—</span>}
                </td>
              );
            })}
            {hasBaseline && (
              <td>
                {r.isBaseline ? (
                  <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200/70">
                    基准
                  </span>
                ) : r.verdict ? (
                  <span
                    className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                      r.verdict === '优秀'
                        ? 'bg-emerald-50 text-emerald-700 ring-emerald-200/70'
                        : 'bg-red-50 text-red-700 ring-red-200/70'
                    }`}
                  >
                    {r.verdict}
                  </span>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface ReportTemplateProps {
  meta: ReportMetaInput;
  data: ReportData;
}

const ReportTemplate = forwardRef<HTMLDivElement, ReportTemplateProps>(
  function ReportTemplate({ meta, data }, ref) {
    const summaryGroups = buildSummaryGroups(data);
    const empty = (s: string | null | undefined) => !s || !s.trim();

    const chartTitle = (m: MetricDef, idx: number) =>
      `4.${idx + 1} ${m.label}${m.unit ? `（${m.unit}）` : ''} 分布对比（箱线图）`;

    return (
      <div
        ref={ref}
        className="report-paper mx-auto w-[794px] bg-white px-12 py-10 text-slate-900"
      >
        {/* ============ 报告头 ============ */}
        <div data-block="header" data-block-kind="text" className="pb-6">
          <h1 className="text-center text-[22px] font-semibold tracking-wide text-slate-900">
            钙钛矿器件验证对比分析报告
          </h1>
          <div className="mt-1 text-center text-[12px] text-slate-400">
            Device Validation Comparative Analysis Report
          </div>
          <div className="mt-5 flex justify-center gap-x-8">
            <MetaItem label="汇报人" value={meta.reporter || '—'} />
            <MetaItem label="汇报日期" value={meta.report_date || '—'} />
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-x-8">
            <MetaItem label="参与批次" value={`${data.totals.batches} 个`} />
            <MetaItem label="测试记录" value={`${data.totals.samples} 条（反扫 ${data.totals.reverse} 条）`} />
            <MetaItem label="有效测试记录" value={`${data.totals.valid}/${data.totals.reverse} 条`} />
          </div>
          <div className="mt-5 border-t border-slate-200" />
        </div>

        {/* ============ 报告总览（批次 × 关键指标热力矩阵 + 判定汇总，先看结论再看细节） ============ */}
        {data.groups.length > 0 && (
          <section data-block="overview" data-block-kind="table" className="pb-6">
            <SectionTitle>报告总览</SectionTitle>
            <OverviewMatrix data={data} />
            <div className="mt-3 whitespace-pre-line rounded-lg border border-blue-200 bg-blue-50/50 px-4 py-3 text-[13px] leading-7 text-slate-700">
              {buildOverviewSummary(data)}
            </div>
            <p className="mt-2 text-[11px] leading-5 text-slate-400">
              注：底色深浅表示该指标在批次间的相对水平（浅 → 深 = 低 → 高，加粗为该指标最高批次）；
              统计基于各批次有效测试记录（{criteriaTextShort(data.thresholds)}）；
              各指标详细统计与差值对比见第四部分。
            </p>
          </section>
        )}

        {/* ============ 一、研究目的与意义 ============ */}
        {!empty(meta.research_purpose) && (
          <section data-block="purpose" data-block-kind="text" className="pb-6">
            <SectionTitle no="一">研究目的与意义</SectionTitle>
            <Paragraph text={meta.research_purpose!} />
          </section>
        )}

        {/* ============ 二、过程与方法 ============ */}
        {!empty(meta.process_method) && (
          <section data-block="method" data-block-kind="text" className="pb-6">
            <SectionTitle no="二">过程与方法</SectionTitle>
            <Paragraph text={meta.process_method!} />
          </section>
        )}

        {/* ============ 三、关键工艺参数 ============ */}
        {!empty(meta.key_parameters) && (
          <section data-block="keyparams" data-block-kind="text" className="pb-6">
            <SectionTitle no="三">关键工艺参数</SectionTitle>
            <Paragraph text={meta.key_parameters!} />
          </section>
        )}

        {/* ============ 四、实验数据 ============ */}
        {data.groups.length > 0 && (
          <section data-block="data-intro" data-block-kind="text" className="pb-5">
            <SectionTitle no="四">实验数据</SectionTitle>
            <Paragraph
              text={`本节共 ${data.totals.samples} 条测试记录（其中反扫 ${data.totals.reverse} 条），全部统计均基于符合统计口径的有效测试记录 ${data.totals.valid} 条（有效 ${data.totals.valid}/${data.totals.reverse} = 符合口径反扫数 / 反扫总数；口径：${criteriaTextShort(data.thresholds)}）。箱线图给出各批次有效测试记录关键参数的分布（箱体为 Q1~Q3，须为 1.5×IQR 范围内最值，红点为离群值）。`}
            />
          </section>
        )}

        {data.boxplots.map(({ metric, data: bd }, i) =>
          bd.categories.length > 0 ? (
            <div
              key={metric.key}
              data-block={`chart-${metric.key}`}
              data-block-kind="chart"
              className="pb-6"
            >
              <h3 className="mb-2 text-[13px] font-semibold text-slate-800">
                {chartTitle(metric, i)}
              </h3>
              <div className="rounded-lg border border-slate-200 p-2">
                <BoxplotChart title="" unit={metric.unit} data={bd} />
              </div>
            </div>
          ) : null,
        )}

        {/* 4.5 数据汇总表（冠军 / 中位 / 最优） */}
        {summaryGroups.length > 0 && (
          <div data-block="summary" data-block-kind="table" className="pb-6">
            <h3 className="mb-2 text-[13px] font-semibold text-slate-800">
              4.5 各批次关键参数汇总表（冠军 / 中位 / 最优）
            </h3>
            <table className="report-table w-full">
              <thead>
                <tr>
                  <th>批次</th>
                  <th>口径</th>
                  <th>PCE (%)</th>
                  <th>Voc (V)</th>
                  <th>Jsc (mA/cm²)</th>
                  <th>FF</th>
                  <th>Rs (Ω)</th>
                  <th>Rsh (Ω)</th>
                  <th>Voc·FF (V)</th>
                </tr>
              </thead>
              <tbody>
                {summaryGroups.map((g) => {
                  const c = g.champion;
                  const hasChampion = c != null;
                  return (
                    <Fragment key={g.batchId}>
                      {/* 组首行（冠军行）：批次列拆为 3 行独立单元格（不用 rowspan——
                          html2canvas 无法垂直居中合并单元格内容），冠军行置空格
                          batch-void-top（隐藏下边线）；组首行以 data-group-first
                          标记供 PDF 分页按组切开，断页仅发生在组边界 */}
                      <tr data-group-first>
                        {hasChampion ? (
                          <td className="batch-void-top" />
                        ) : (
                          <td className="batch-cell">
                            <div className="font-mono font-medium">{batchLabelOf(g.batchId)}</div>
                            <div className="text-[10px] text-slate-400">
                              有效 {g.validCount}/{g.totalCount}
                            </div>
                          </td>
                        )}
                        {hasChampion && c ? (
                          <>
                            <td className="wrap-cell font-medium">
                              冠军·{scanLabelOf(c.sample_name, g.batchId)}
                            </td>
                            <td className="font-mono font-semibold text-emerald-700">
                              {fmt(c.efficiency)}
                            </td>
                            <td className="font-mono">{fmt(c.voc_V)}</td>
                            <td className="font-mono">{fmt(c.jsc_mA_cm2)}</td>
                            <td className="font-mono">{fmt(c.ff)}</td>
                            <td className="font-mono">{fmt(c.rs_ohm)}</td>
                            <td className="font-mono">{fmt(c.rsh_ohm)}</td>
                            <td className="font-mono">{fmt(metricValue(c, 'vocff'))}</td>
                          </>
                        ) : (
                          <td colSpan={8} className="text-slate-400">
                            无 PCE 测试数据
                          </td>
                        )}
                      </tr>
                      {hasChampion && (
                        <tr>
                          {/* 中位行 = 3 行组的垂直中心：批次号 + 有效测试记录数 */}
                          <td className="batch-cell batch-mid">
                            <div className="font-mono font-medium">{batchLabelOf(g.batchId)}</div>
                            <div className="text-[10px] text-slate-400">
                              有效 {g.validCount}/{g.totalCount}
                            </div>
                          </td>
                          <td className="text-slate-500">中位</td>
                          <td className="font-mono">{fmt(g.median.eff)}</td>
                          <td className="font-mono">{fmt(g.median.voc)}</td>
                          <td className="font-mono">{fmt(g.median.jsc)}</td>
                          <td className="font-mono">{fmt(g.median.ff)}</td>
                          <td className="font-mono">{fmt(g.median.rs)}</td>
                          <td className="font-mono">{fmt(g.median.rsh)}</td>
                          <td className="font-mono">{fmt(g.median.vocff)}</td>
                        </tr>
                      )}
                      {hasChampion && (
                        <tr>
                          {/* 最优行置空格 batch-void-bottom，其下边线兼作组分隔线 */}
                          <td className="batch-void-bottom" />
                          <td className="text-slate-500">最优</td>
                          <td className="font-mono">{fmt(g.best.eff)}</td>
                          <td className="font-mono">{fmt(g.best.voc)}</td>
                          <td className="font-mono">{fmt(g.best.jsc)}</td>
                          <td className="font-mono">{fmt(g.best.ff)}</td>
                          <td className="font-mono">{fmt(g.best.rs)}</td>
                          <td className="font-mono">{fmt(g.best.rsh)}</td>
                          <td className="font-mono">{fmt(g.best.vocff)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] leading-5 text-slate-400">
              注：统计基于各批次有效测试记录（{criteriaTextShort(data.thresholds)}）；冠军 =
              有效测试记录中 PCE 最高（取该次扫描全部参数）；中位 = 各指标中位数；最优 =
              各指标独立极值（Rs 取最小）；有效 X/Y = 符合口径反扫数 / 反扫总数。
            </p>
          </div>
        )}

        {/* 4.6 Baseline 差值对比（若已选基准）：PCE 与 Voc·FF 平均值 */}
        {data.baseline && data.baseline.diffs.length > 0 && (
          <div data-block="baseline-diff" data-block-kind="table" className="pb-6">
            <h3 className="mb-2 text-[13px] font-semibold text-slate-800">
              4.6 Baseline 差值对比（基准：{data.baseline.baselineBatchId}）
            </h3>
            <table className="report-table w-full">
              <thead>
                <tr>
                  <th>批次</th>
                  <th>冠军 PCE (%)</th>
                  <th>Δ 冠军</th>
                  <th>中位 PCE (%)</th>
                  <th>Δ 中位</th>
                  <th>平均 Voc·FF (V)</th>
                  <th>Δ 平均</th>
                  <th>判定</th>
                </tr>
              </thead>
              <tbody>
                <BaselineDiffRow
                  isBaseline
                  baseline={{
                    batchId: data.baseline.baselineBatchId,
                    champion: data.baseline.baselineChampion,
                    median: data.baseline.baselineMedian,
                    vocffMean: data.baseline.baselineVocffMean,
                  }}
                />
                {data.baseline.diffs.map((d) => (
                  <BaselineDiffRow key={d.batchId} d={d} />
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] leading-5 text-slate-400">
              Δ = 目标批次 − 基准批次（差值 &lt;0 红色、&gt;0 绿色）；Voc·FF
              为批次有效测试记录平均值（参考指标，不参与判定）；优秀判定：{verdictLabelOf(data.thresholds)}
            </p>
          </div>
        )}

        {/* 4.7 分析结论（若已选基准） */}
        {data.baseline && data.baseline.conclusion && (
          <section data-block="baseline-conclusion" data-block-kind="text" className="pb-6">
            <h3 className="mb-2 text-[13px] font-semibold text-slate-800">
              4.7 分析结论（Baseline 自动判定）
            </h3>
            <div className="whitespace-pre-line rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-[13px] leading-7 text-slate-700">
              {data.baseline.conclusion}
            </div>
          </section>
        )}

        {/* ============ 五、结果讨论 ============ */}
        {!empty(meta.discussion) && (
          <section data-block="discussion" data-block-kind="text" className="pb-6">
            <SectionTitle no="五">结果讨论</SectionTitle>
            <Paragraph text={meta.discussion!} />
          </section>
        )}

        {/* ============ 六、研究结论 ============ */}
        {!empty(meta.conclusion) && (
          <section data-block="conclusion" data-block-kind="text" className="pb-6">
            <SectionTitle no="六">研究结论</SectionTitle>
            <Paragraph text={meta.conclusion!} />
          </section>
        )}

        {/* ============ 七、下一步计划 ============ */}
        {!empty(meta.next_steps) && (
          <section data-block="nextsteps" data-block-kind="text" className="pb-2">
            <SectionTitle no="七">下一步计划</SectionTitle>
            <Paragraph text={meta.next_steps!} />
          </section>
        )}
      </div>
    );
  },
);

export default ReportTemplate;
