import type { BoxplotStats } from '../types';

/** 计算分位数（线性插值法），入参需为已升序排列的数组 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** 中位数 */
export function median(values: number[]): number {
  const sorted = values.filter((v) => !isNaN(v)).sort((a, b) => a - b);
  return percentile(sorted, 50);
}

/**
 * 箱线图统计（Tukey 法）
 * 箱体 = Q1~Q3，须 = 1.5×IQR 范围内的最值，超出者为异常值
 */
export function computeBoxplot(values: number[]): BoxplotStats {
  const sorted = values.filter((v) => !isNaN(v)).sort((a, b) => a - b);
  const count = sorted.length;
  const mean = count > 0 ? sorted.reduce((a, b) => a + b, 0) / count : NaN;

  if (count === 0) {
    return {
      min: NaN, max: NaN, q1: NaN, median: NaN, q3: NaN,
      lowerWhisker: NaN, upperWhisker: NaN, outliers: [], mean: NaN, count: 0,
    };
  }

  const q1 = percentile(sorted, 25);
  const med = percentile(sorted, 50);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;

  const lowerLimit = q1 - 1.5 * iqr;
  const upperLimit = q3 + 1.5 * iqr;

  // 须端：限制范围内实际存在的最小/最大值
  const within = sorted.filter((v) => v >= lowerLimit && v <= upperLimit);
  const lowerWhisker = within.length > 0 ? within[0] : sorted[0];
  const upperWhisker = within.length > 0 ? within[within.length - 1] : sorted[sorted.length - 1];

  const outliers = sorted.filter((v) => v < lowerLimit || v > upperLimit);

  return {
    min: sorted[0],
    max: sorted[count - 1],
    q1,
    median: med,
    q3,
    lowerWhisker,
    upperWhisker,
    outliers,
    mean,
    count,
  };
}

/** 数值格式化：空值显示 "-"，其余保留指定位小数 */
export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return n.toFixed(digits);
}
