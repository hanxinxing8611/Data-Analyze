import type { BoxplotData } from '../components/charts/BoxplotChart';
import type { SampleRecord } from '../types';
import { computeBoxplot, fmt, median } from '../utils/statistics';

/* ================= 统计口径 ================= */

/** 统计口径配置（可在系统设置中配置，持久化于 localStorage） */
export interface CriteriaThresholds {
  /** 优秀判定方式：champion_and_median = 冠军Δ>0 且中位Δ>0 */
  verdictMode: 'champion_and_median' | 'champion_only' | 'median_only';
  /** 优秀判定阈值：Δ > 该值（默认 0，即优于基准即可） */
  verdictThreshold: number;
  /** 有效测试记录效率下限（PCE ≥ 该值，%） */
  pceMin: number;
  /** 有效测试记录填充因子下限（FF ≥ 该值） */
  ffMin: number;
  /** 有效测试记录电阻下限（Rs、Rsh > 该值，Ω） */
  resistanceMin: number;
}

/** 默认口径 */
export const DEFAULT_THRESHOLDS: CriteriaThresholds = {
  verdictMode: 'champion_and_median',
  verdictThreshold: 0,
  pceMin: 15,
  ffMin: 0.5,
  resistanceMin: 0,
};

/** localStorage 持久化键 */
export const CRITERIA_STORAGE_KEY = 'dv-criteria-thresholds';

/** 口径字段防御性校验（非法/缺失回退默认值），localStorage 与云端解析共用 */
export function sanitizeThresholds(
  parsed: Partial<CriteriaThresholds> | null | undefined,
): CriteriaThresholds {
  const num = (v: unknown) => (typeof v === 'number' && !isNaN(v) ? v : null);
  const p = parsed ?? {};
  return {
    verdictMode: (
      p.verdictMode === 'champion_only' ||
      p.verdictMode === 'median_only'
        ? p.verdictMode
        : DEFAULT_THRESHOLDS.verdictMode
    ),
    verdictThreshold: num(p.verdictThreshold) ?? DEFAULT_THRESHOLDS.verdictThreshold,
    pceMin: num(p.pceMin) ?? DEFAULT_THRESHOLDS.pceMin,
    ffMin: num(p.ffMin) ?? DEFAULT_THRESHOLDS.ffMin,
    resistanceMin: num(p.resistanceMin) ?? DEFAULT_THRESHOLDS.resistanceMin,
  };
}

/** 从 localStorage 读取口径（非法/缺失时回退默认值） */
export function loadThresholds(): CriteriaThresholds {
  try {
    const raw = localStorage.getItem(CRITERIA_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THRESHOLDS };
    return sanitizeThresholds(JSON.parse(raw) as Partial<CriteriaThresholds>);
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

/** 有效测试记录 = 代表扫描（反扫）且满足统计口径阈值（PCE/FF/电阻）的记录：
 *  正扫/反扫成对测试，反扫为代表测试结果；「有效 X/Y」= 符合口径反扫数 / 反扫总数 */
export function isValidDevice(r: SampleRecord, t: CriteriaThresholds = DEFAULT_THRESHOLDS): boolean {
  return (
    r.is_reverse === 1 &&
    r.efficiency != null && r.efficiency >= t.pceMin &&
    r.ff != null && r.ff >= t.ffMin &&
    r.rs_ohm != null && r.rs_ohm > t.resistanceMin &&
    r.rsh_ohm != null && r.rsh_ohm > t.resistanceMin
  );
}

/** 口径文字描述（界面与报告共用，随配置动态生成） */
export function criteriaText(t: CriteriaThresholds): string {
  const parts = [
    `统计基于各批次有效测试记录（${criteriaTextShort(t)}），有效 X/Y = 符合口径反扫数 / 反扫总数`,
  ];
  parts.push(`优秀判定：${verdictLabelOf(t)}`);
  return parts.join('；');
}

/** 优秀判定文字描述（随判定配置生成，报告表格注释 / Excel 注释 / 结论文案共用） */
export function verdictLabelOf(t: CriteriaThresholds): string {
  const th = t.verdictThreshold !== 0 ? `（Δ>${t.verdictThreshold}）` : '';
  if (t.verdictMode === 'champion_only') return `冠军 Δ>0${th}`;
  if (t.verdictMode === 'median_only') return `中位 Δ>0${th}`;
  return `冠军 Δ>0 且 中位 Δ>0${th}`;
}

/** 口径文字描述（仅有效测试记录判定部分，不含统计口径与判定逻辑） */
export function criteriaTextShort(t: CriteriaThresholds = DEFAULT_THRESHOLDS): string {
  return `反扫且 PCE≥${t.pceMin}%、FF≥${t.ffMin}、Rs/Rsh>${t.resistanceMin}Ω 的测试记录`;
}

/** 优秀判定结果（基于口径配置） */
export function getVerdict(
  championDelta: number,
  medianDelta: number,
  t: CriteriaThresholds = DEFAULT_THRESHOLDS,
): '优秀' | '不合格' {
  const th = t.verdictThreshold;
  switch (t.verdictMode) {
    case 'champion_only':
      return championDelta > th ? '优秀' : '不合格';
    case 'median_only':
      return medianDelta > th ? '优秀' : '不合格';
    case 'champion_and_median':
    default:
      return championDelta > th && medianDelta > th ? '优秀' : '不合格';
  }
}

/** 默认口径文字（向后兼容：未传阈值时的展示文案） */
export const CRITERIA_TEXT = criteriaText(DEFAULT_THRESHOLDS);

/* ================= 指标定义 ================= */

/** 报告中的对比指标（与验证报告模板的 4 项箱线图一致） */
export interface MetricDef {
  key: string;
  label: string;
  unit: string;
  digits: number;
  /** 是否为派生指标（VOC·FF） */
  derived?: boolean;
}

export const REPORT_METRICS: MetricDef[] = [
  { key: 'efficiency', label: 'EFF', unit: '%', digits: 2 },
  { key: 'vocff', label: 'VOC·FF', unit: 'V', digits: 2, derived: true },
  { key: 'voc_V', label: 'VOC', unit: 'V', digits: 2 },
  { key: 'jsc_mA_cm2', label: 'JSC', unit: 'mA/cm²', digits: 2 },
];

/** 汇总表参与中位统计的指标（不含箱线图） */
export const SUMMARY_ONLY_METRICS: MetricDef[] = [
  { key: 'ff', label: 'FF', unit: '', digits: 2 },
];

/** 汇总表参与中位统计的电阻指标 */
export const RESISTANCE_METRICS: MetricDef[] = [
  { key: 'rs_ohm', label: 'Rs', unit: 'Ω', digits: 2 },
  { key: 'rsh_ohm', label: 'Rsh', unit: 'Ω', digits: 2 },
];

/** 取一条记录的指标值（派生指标单独计算） */
export function metricValue(record: SampleRecord, key: string): number {
  if (key === 'vocff') {
    return record.voc_V != null && record.ff != null ? record.voc_V * record.ff : NaN;
  }
  const v = record[key as keyof SampleRecord];
  return typeof v === 'number' ? v : NaN;
}

/* ================= 报告数据结构 ================= */

/** 单批次单指标的统计量 */
export interface BatchMetricStats {
  count: number;
  median: number;
  mean: number;
  max: number;
  min: number;
  q1: number;
  q3: number;
}

/** 各指标独立极值（最优口径，Rs 取最小） */
export interface BestStats {
  eff: number;
  voc: number;
  jsc: number;
  ff: number;
  rs: number; // 取最小
  rsh: number; // 取最大
  vocff: number;
}

/** 批次分组 */
export interface BatchGroup {
  batchId: string;
  /** 该批次全部测试记录（含正扫/反扫，仅用于明细展示与「有效 X/Y」分母基数） */
  records: SampleRecord[];
  /** 该批次反扫记录（「有效 X/Y」分母） */
  reverseRecords: SampleRecord[];
  /** 有效测试记录（反扫且符合统计口径阈值）—— 全部统计的唯一数据基础 */
  validRecords: SampleRecord[];
  /** 冠军记录：有效测试记录中 PCE 最高（取该次扫描全部参数） */
  champion: SampleRecord | null;
}

/** 报告全量数据（由数据库记录实时计算，统计均基于有效测试记录） */
export interface ReportData {
  /** 本次统计使用的口径阈值 */
  thresholds: CriteriaThresholds;
  /** 口径文字描述（随阈值生成，模板/导出/初稿共用） */
  criteriaText: string;
  groups: BatchGroup[];
  /** metricKey -> batchId -> 统计量（基于有效测试记录） */
  metricStats: Record<string, Record<string, BatchMetricStats>>;
  /** batchId -> 各指标独立极值（基于有效测试记录） */
  bests: Record<string, BestStats>;
  /** 箱线图数据（4 项，基于有效测试记录） */
  boxplots: { metric: MetricDef; data: BoxplotData }[];
  totals: {
    batches: number;
    validBatches: number;
    /** 全部测试记录数（含正扫/反扫） */
    samples: number;
    /** 反扫测试记录总数 */
    reverse: number;
    /** 有效测试记录数（符合口径的反扫记录） */
    valid: number;
  };
  /** Baseline 对比（若未选 baseline 则为 null） */
  baseline: BaselineResult | null;
}

/* ================= Baseline 对比 ================= */

/** 与 Baseline 的差值 */
export interface DiffResult {
  batchId: string;
  champion: number;
  championDelta: number;
  median: number;
  medianDelta: number;
  /** 平均 Voc·FF（批次有效测试记录平均值）与相对基准差值（供结论文本使用） */
  vocffMean?: number;
  vocffMeanDelta?: number;
  verdict: '优秀' | '不合格';
}

/** 样品名去除批次号前缀（汇总表口径/样品列使用，批次号由批次列单独显示） */
export function scanLabelOf(sampleName: string, batchId: string): string {
  return sampleName.startsWith(batchId)
    ? sampleName.slice(batchId.length).replace(/^[_\-]+/, '')
    : sampleName;
}

/** 批次号去除尾部批次序号后缀（汇总表批次列显示用：CB615W1-1 → CB615W1） */
export function batchLabelOf(batchId: string): string {
  return batchId.replace(/-\d+$/, '');
}

export interface BaselineResult {
  baselineBatchId: string;
  baselineChampion: number;
  baselineMedian: number;
  /** 基准批次有效测试记录平均 Voc·FF（V） */
  baselineVocffMean: number;
  diffs: DiffResult[];
  conclusion: string;
}

/* ================= 计算逻辑 ================= */

function statsOf(values: number[]): BatchMetricStats {
  const valid = values.filter((v) => !isNaN(v));
  if (valid.length === 0) {
    return { count: 0, median: NaN, mean: NaN, max: NaN, min: NaN, q1: NaN, q3: NaN };
  }
  const bp = computeBoxplot(valid);
  return {
    count: valid.length,
    median: bp.median,
    mean: bp.mean,
    max: bp.max,
    min: bp.min,
    q1: bp.q1,
    q3: bp.q3,
  };
}

/** 各指标独立极值（Rs 取最小，其余取最大） */
function bestOf(records: SampleRecord[]): BestStats {
  const values = (fn: (r: SampleRecord) => number) =>
    records.map(fn).filter((v) => !isNaN(v));
  const extremum = (arr: number[], mode: 'max' | 'min') =>
    arr.length === 0 ? NaN : mode === 'max' ? Math.max(...arr) : Math.min(...arr);
  return {
    eff: extremum(values((r) => r.efficiency ?? NaN), 'max'),
    voc: extremum(values((r) => r.voc_V ?? NaN), 'max'),
    jsc: extremum(values((r) => r.jsc_mA_cm2 ?? NaN), 'max'),
    ff: extremum(values((r) => r.ff ?? NaN), 'max'),
    rs: extremum(values((r) => r.rs_ohm ?? NaN), 'min'),
    rsh: extremum(values((r) => r.rsh_ohm ?? NaN), 'max'),
    vocff: extremum(values((r) => metricValue(r, 'vocff')), 'max'),
  };
}

/** 根据选中批次与记录构建报告数据（统计基于有效测试记录 = 符合口径的反扫记录） */
export function buildReportData(
  selectedBatchIds: string[],
  records: SampleRecord[],
  thresholds: CriteriaThresholds = DEFAULT_THRESHOLDS,
  baselineBatchId: string | null = null,
): ReportData {
  // Baseline 永远排在最前（表格、箱线图、差分矩阵均以基准为第一列/行）
  const orderedIds =
    baselineBatchId && selectedBatchIds.includes(baselineBatchId)
      ? [baselineBatchId, ...selectedBatchIds.filter((id) => id !== baselineBatchId)]
      : selectedBatchIds;

  // 分组（保留有记录的批次；有效测试记录 = 反扫且符合口径阈值，是全部统计的基础）
  const map = new Map<string, SampleRecord[]>();
  for (const r of records) {
    if (!orderedIds.includes(r.batch_id)) continue;
    const list = map.get(r.batch_id) ?? [];
    list.push(r);
    map.set(r.batch_id, list);
  }
  const groups: BatchGroup[] = orderedIds
    .map((batchId) => {
      const rs = map.get(batchId) ?? [];
      const reverseRecords = rs.filter((r) => r.is_reverse === 1);
      const validRecords = rs.filter((r) => isValidDevice(r, thresholds));
      // 冠军：有效测试记录中 PCE 最高，取该次扫描全部参数
      const effRecords = validRecords.filter((r) => r.efficiency != null);
      const champion =
        effRecords.length > 0
          ? effRecords.reduce((a, b) => ((b.efficiency as number) > (a.efficiency as number) ? b : a))
          : null;
      return { batchId, records: rs, reverseRecords, validRecords, champion };
    })
    .filter((g) => g.records.length > 0);

  // 全部指标统计（基于有效测试记录）
  const allMetrics = [...REPORT_METRICS, ...SUMMARY_ONLY_METRICS, ...RESISTANCE_METRICS];
  const metricStats: Record<string, Record<string, BatchMetricStats>> = {};
  for (const m of allMetrics) {
    metricStats[m.key] = {};
    for (const g of groups) {
      metricStats[m.key][g.batchId] = statsOf(g.validRecords.map((r) => metricValue(r, m.key)));
    }
  }

  // 各批次最优（独立极值，Rs 取最小，基于有效测试记录）
  const bests: Record<string, BestStats> = {};
  for (const g of groups) bests[g.batchId] = bestOf(g.validRecords);

  // 箱线图数据（基于有效测试记录；叠加原始数据点展示分布）
  const boxplots = REPORT_METRICS.map((metric) => {
    const categories: string[] = [];
    const boxes: (number | null)[][] = [];
    const points: [number, number][] = [];
    for (const g of groups) {
      const values = g.validRecords
        .map((r) => metricValue(r, metric.key))
        .filter((v) => !isNaN(v));
      if (values.length === 0) continue;
      const bp = computeBoxplot(values);
      categories.push(g.batchId);
      boxes.push([bp.lowerWhisker, bp.q1, bp.median, bp.q3, bp.upperWhisker]);
      values.forEach((v) => points.push([categories.length - 1, v]));
    }
    return { metric, data: { categories, boxes, points } };
  });

  const totals = {
    batches: groups.length,
    validBatches: groups.filter((g) => g.validRecords.length > 0).length,
    samples: groups.reduce((s, g) => s + g.records.length, 0),
    reverse: groups.reduce((s, g) => s + g.reverseRecords.length, 0),
    valid: groups.reduce((s, g) => s + g.validRecords.length, 0),
  };

  // Baseline 对比（冠军/中位 Δ 与优秀/不合格判定，基于有效测试记录）
  // 守卫：基准批次无有效测试记录时 baseline = null（Δ 全为 NaN 会把所有批次误判为不合格）
  let baseline: BaselineResult | null = null;
  if (baselineBatchId && groups.some((g) => g.batchId === baselineBatchId)) {
    const baselineGroup = groups.find((g) => g.batchId === baselineBatchId)!;
    const baselineEFFs = baselineGroup.validRecords
      .map((r) => r.efficiency)
      .filter((v): v is number => v != null);
    if (baselineEFFs.length > 0) {
      const baselineChampion = baselineGroup.champion?.efficiency ?? NaN;
      const baselineMedian = median(baselineEFFs);
      const baselineVocffMean = metricStats['vocff'][baselineBatchId]?.mean ?? NaN;
      const diffs: DiffResult[] = [];
      for (const g of groups) {
        if (g.batchId === baselineBatchId) continue;
        const effs = g.validRecords
          .map((r) => r.efficiency)
          .filter((v): v is number => v != null);
        if (effs.length === 0) continue;
        const champion = g.champion?.efficiency ?? NaN;
        const championDelta = champion - baselineChampion;
        const med = median(effs);
        const medianDelta = med - baselineMedian;
        const vocffMean = metricStats['vocff'][g.batchId]?.mean ?? NaN;
        diffs.push({
          batchId: g.batchId,
          champion,
          championDelta,
          median: med,
          medianDelta,
          vocffMean,
          vocffMeanDelta: vocffMean - baselineVocffMean,
          verdict: getVerdict(championDelta, medianDelta, thresholds),
        });
      }
      baseline = {
        baselineBatchId,
        baselineChampion,
        baselineMedian,
        baselineVocffMean,
        diffs,
        conclusion: buildBaselineConclusion(baselineBatchId, diffs),
      };
    }
  }

  return {
    thresholds: { ...thresholds },
    criteriaText: criteriaText(thresholds),
    groups,
    metricStats,
    bests,
    boxplots,
    totals,
    baseline,
  };
}

/* ================= Baseline 结论生成 ================= */

/** 单项指标差值短语："{label}低于/高于 {baseline} {绝对值}{unit}"（无有效数据时返回空） */
function deltaPhrase(
  label: string,
  baselineId: string,
  delta: number | undefined,
  digits: number,
  unit: string,
): string {
  const v = delta ?? NaN;
  if (!Number.isFinite(v)) return '';
  return `${label}${v > 0 ? '高于' : '低于'} ${baselineId} ${Math.abs(v).toFixed(digits)}${unit}`;
}

/**
 * 基于 baseline 差值自动生成分析结论（供报告模板与讨论初稿共用）。
 * 逐批次一句话：三项指标差值（最高/中位数效率、平均 Voc*FF）+ 质量判定，
 * 格式与人工验证报告一致，如：
 *   A|806Y2 微晶电池的最高效率低于 131S-01 0.20%，中位数效率低于 131S-01 0.35%，
 *   平均 Voc*FF 低于 131S-01 0.012，质量优秀；
 */
export function buildBaselineConclusion(baselineId: string, diffs: DiffResult[]): string {
  if (diffs.length === 0) return '';
  return diffs
    .map((d, i) => {
      const clauses = [
        deltaPhrase('最高效率', baselineId, d.championDelta, 2, '%'),
        deltaPhrase('中位数效率', baselineId, d.medianDelta, 2, '%'),
        deltaPhrase('平均 Voc*FF', baselineId, d.vocffMeanDelta, 2, ''),
      ]
        .filter(Boolean)
        .join('，');
      const end = i === diffs.length - 1 ? '。' : '；';
      return `${d.batchId} 微晶电池的${clauses}，质量${d.verdict}${end}`;
    })
    .join('\n');
}

/* ================= 报告总览（首页速览） ================= */

/**
 * 报告总览判定汇总（首页速览文字，供模板「报告总览」区与验证脚本共用）：
 * - 有基准：优秀/不合格计数与批次清单 + 各关键指标最优批次；
 * - 无基准：仅各关键指标最优批次 + 未选基准提示；
 * - 无有效测试记录：提示调整统计口径。
 */
export function buildOverviewSummary(data: ReportData): string {
  if (data.groups.length === 0) return '';
  if (data.totals.valid === 0) {
    return `当前选择批次共 ${data.totals.samples} 条测试记录（其中反扫 ${data.totals.reverse} 条），` +
      `但无符合统计口径的有效测试记录（${criteriaTextShort(data.thresholds)}），请调整统计口径或核对数据。`;
  }
  const parts: string[] = [];
  if (data.baseline && data.baseline.diffs.length > 0) {
    const { baselineBatchId, diffs } = data.baseline;
    const excellent = diffs.filter((d) => d.verdict === '优秀');
    const failed = diffs.filter((d) => d.verdict === '不合格');
    const counts: string[] = [];
    if (excellent.length > 0) {
      counts.push(`优秀 ${excellent.length} 个（${excellent.map((d) => d.batchId).join('、')}）`);
    }
    if (failed.length > 0) {
      counts.push(`不合格 ${failed.length} 个（${failed.map((d) => d.batchId).join('、')}）`);
    }
    parts.push(`以 ${baselineBatchId} 为基准的 ${diffs.length} 个对比批次中：${counts.join('，')}。`);
  }
  const bestOf = (label: string, unit: string, pick: (g: BatchGroup) => number): string => {
    const list = data.groups
      .map((g) => ({ batchId: g.batchId, v: pick(g) }))
      .filter((x) => Number.isFinite(x.v));
    if (list.length === 0) return '';
    const best = list.reduce((a, b) => (b.v > a.v ? b : a));
    /* 标签以拉丁字母/数字结尾时补空格，避免「Voc·FF最高为」类拥挤拼接 */
    const sep = /[A-Za-z0-9]$/.test(label) ? ' ' : '';
    return `${label}${sep}最高为 ${best.batchId}（${fmt(best.v, 2)}${unit}）`;
  };
  const champs = [
    bestOf('PCE 冠军', '%', (g) => g.champion?.efficiency ?? NaN),
    bestOf('PCE 中位', '%', (g) => data.metricStats['efficiency'][g.batchId]?.median ?? NaN),
    bestOf('平均 Voc·FF', ' V', (g) => data.metricStats['vocff'][g.batchId]?.mean ?? NaN),
  ].filter(Boolean);
  if (champs.length > 0) parts.push(`${champs.join('；')}。`);
  if (!data.baseline) {
    parts.push('（未选择基准批次，无 Δ 差值与质量判定，详见「实验数据」）');
  }
  return parts.join('');
}

/* ================= 结果讨论初稿 ================= */

/** 批次排名：按指定指标中位数降序（基于有效测试记录） */
function rankByMedian(
  data: ReportData,
  key: string,
): { batchId: string; median: number }[] {
  return data.groups
    .map((g) => ({ batchId: g.batchId, median: data.metricStats[key][g.batchId]?.median ?? NaN }))
    .filter((x) => !isNaN(x.median))
    .sort((a, b) => b.median - a.median);
}

function fmtRange(list: number[], digits = 2): string {
  if (list.length === 0) return '-';
  return `${Math.min(...list).toFixed(digits)}~${Math.max(...list).toFixed(digits)}`;
}

/**
 * 基于有效测试记录统计结果生成「结果讨论」初稿（全部为真实数据描述，供人工编辑）
 */
export function generateDiscussionDraft(data: ReportData): string {
  if (data.totals.samples === 0) {
    return `当前选择批次无测试记录，请核对数据或调整批次选择。`;
  }
  if (data.totals.valid === 0) {
    return `当前选择批次共 ${data.totals.samples} 条测试记录（其中反扫 ${data.totals.reverse} 条），` +
      `但无符合统计口径的有效测试记录（${criteriaTextShort(data.thresholds)}），` +
      `请调整统计口径或核对数据。`;
  }

  const lines: string[] = [];
  lines.push(
    `本次对比分析涵盖 ${data.totals.batches} 个材料批次共 ${data.totals.samples} 条测试记录` +
      `（其中反扫 ${data.totals.reverse} 条），` +
      `以下统计均基于符合统计口径的有效测试记录 ${data.totals.valid} 条` +
      `（有效 ${data.totals.valid}/${data.totals.reverse} = 符合口径反扫数 / 反扫总数，` +
      `口径：${criteriaTextShort(data.thresholds)}）。`,
  );

  // 效率排名（中位口径）
  const effRank = rankByMedian(data, 'efficiency');
  if (effRank.length >= 2) {
    const best = effRank[0];
    const second = effRank[1];
    const worst = effRank[effRank.length - 1];
    const gap = best.median - second.median;
    lines.push(
      `效率方面：批次 ${best.batchId} 的 EFF 中位数最高（${best.median.toFixed(2)}%），` +
        `较次优批次 ${second.batchId}（${second.median.toFixed(2)}%）高 ${gap.toFixed(2)} 个百分点，` +
        `较最低批次 ${worst.batchId}（${worst.median.toFixed(2)}%）高 ${(best.median - worst.median).toFixed(2)} 个百分点。`,
    );
  } else if (effRank.length === 1) {
    lines.push(
      `效率方面：批次 ${effRank[0].batchId} 的 EFF 中位数为 ${effRank[0].median.toFixed(2)}%。`,
    );
  }

  // 冠军器件（有效测试记录中 PCE 最高，取该次扫描全部参数）
  let champion: SampleRecord | null = null;
  for (const g of data.groups) {
    if (
      g.champion &&
      (!champion || (g.champion.efficiency ?? -Infinity) > (champion.efficiency ?? -Infinity))
    ) {
      champion = g.champion;
    }
  }
  if (champion) {
    const c = champion;
    lines.push(
      `冠军器件为批次 ${c.batch_id} 的 ${c.sample_name}（PCE = ${fmt(c.efficiency)}%，Voc = ${fmt(c.voc_V)} V，` +
        `Jsc = ${fmt(c.jsc_mA_cm2)} mA/cm²，FF = ${fmt(c.ff)}，Rs = ${fmt(c.rs_ohm)} Ω，Rsh = ${fmt(c.rsh_ohm)} Ω），取该次扫描全部参数。`,
    );
  }

  // 其他指标区间（中位口径）
  const vocMedians = rankByMedian(data, 'voc_V').map((x) => x.median);
  const jscMedians = rankByMedian(data, 'jsc_mA_cm2').map((x) => x.median);
  const ffMedians = rankByMedian(data, 'ff').map((x) => x.median);
  // VOC·FF 按平均值口径排名（与 Baseline 差值对比一致）
  const vocffMeans = data.groups
    .map((g) => data.metricStats['vocff'][g.batchId]?.mean ?? NaN)
    .filter((v) => !isNaN(v));
  const vocffMeanRank = data.groups
    .map((g) => ({ batchId: g.batchId, mean: data.metricStats['vocff'][g.batchId]?.mean ?? NaN }))
    .filter((x) => !isNaN(x.mean))
    .sort((a, b) => b.mean - a.mean);
  lines.push(
    `其他参数方面：VOC 中位数介于 ${fmtRange(vocMedians)} V，` +
      `JSC 中位数介于 ${fmtRange(jscMedians)} mA/cm²，FF 中位数介于 ${fmtRange(ffMedians)}。` +
      (vocffMeanRank.length >= 2 && vocffMeans.length === vocffMeanRank.length
        ? `VOC·FF 平均值介于 ${fmtRange(vocffMeans)} V，平均值最高者为批次 ${vocffMeanRank[0].batchId}（${vocffMeanRank[0].mean.toFixed(2)} V），最低者为批次 ${vocffMeanRank[vocffMeanRank.length - 1].batchId}（${vocffMeanRank[vocffMeanRank.length - 1].mean.toFixed(2)} V）。`
        : ''),
  );

  // 离散度提示（EFF IQR 最大的批次）
  const iqrList = data.groups
    .map((g) => {
      const s = data.metricStats['efficiency'][g.batchId];
      return s && !isNaN(s.q1) && !isNaN(s.q3) ? { batchId: g.batchId, iqr: s.q3 - s.q1 } : null;
    })
    .filter((x): x is { batchId: string; iqr: number } => x != null)
    .sort((a, b) => b.iqr - a.iqr);
  if (iqrList.length >= 2 && iqrList[0].iqr > iqrList[iqrList.length - 1].iqr * 1.5) {
    lines.push(
      `离散度方面：批次 ${iqrList[0].batchId} 的 EFF 四分位距最大（${iqrList[0].iqr.toFixed(2)} 个百分点），批次间一致性存在差异，建议结合工艺条件进一步分析。`,
    );
  }

  lines.push('（以上内容由系统根据有效测试记录统计数据自动生成，请结合实验实际进行修改补充。）');

  return lines.join('\n');
}

/* ================= 汇总表（冠军 / 中位 / 最优） ================= */

/** 单批次汇总：冠军器件 + 各指标中位数 + 各指标独立极值 */
export interface SummaryGroup {
  batchId: string;
  /** 反扫测试记录总数（「有效 X/Y」分母） */
  totalCount: number;
  /** 有效测试记录数（符合口径的反扫记录，「有效 X/Y」分子） */
  validCount: number;
  champion: SampleRecord | null;
  /** 中位：各指标中位数（基于有效测试记录） */
  median: {
    eff: number;
    voc: number;
    jsc: number;
    ff: number;
    rs: number;
    rsh: number;
    vocff: number;
  };
  /** 最优：各指标独立极值（Rs 取最小，基于有效测试记录） */
  best: BestStats;
}

export function buildSummaryGroups(data: ReportData): SummaryGroup[] {
  return data.groups.map((g) => ({
    batchId: g.batchId,
    totalCount: g.reverseRecords.length,
    validCount: g.validRecords.length,
    champion: g.champion,
    median: {
      eff: data.metricStats['efficiency'][g.batchId]?.median ?? NaN,
      voc: data.metricStats['voc_V'][g.batchId]?.median ?? NaN,
      jsc: data.metricStats['jsc_mA_cm2'][g.batchId]?.median ?? NaN,
      ff: data.metricStats['ff'][g.batchId]?.median ?? NaN,
      rs: data.metricStats['rs_ohm'][g.batchId]?.median ?? NaN,
      rsh: data.metricStats['rsh_ohm'][g.batchId]?.median ?? NaN,
      vocff: data.metricStats['vocff'][g.batchId]?.median ?? NaN,
    },
    best: data.bests[g.batchId],
  }));
}
