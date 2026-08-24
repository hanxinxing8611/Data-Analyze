import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { FONT_STACK } from '../../utils/font';

export interface BoxplotData {
  /** 分类轴（批次 ID） */
  categories: string[];
  /** 箱体数据：每项为 [下须, Q1, 中位, Q3, 上须] */
  boxes: (number | null)[][];
  /** 原始数据点：[分类索引, 数值]，叠加在箱体上展示分布（含异常值） */
  points: [number, number][];
}

/**
 * 箱线图组件（基于 ECharts）
 * 用于不同材料批次关键指标（EFF / VOC·FF / VOC / JSC 等）的分布对比，
 * 箱体上方叠加原始数据点（带横向抖动），直观展示样本分布密度。
 */
export default function BoxplotChart({
  title,
  unit,
  data,
}: {
  title: string;
  unit: string;
  data: BoxplotData;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // 初始化 / 销毁图表
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current);
    chartRef.current = chart;

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // 更新配置
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // 数据点横向抖动（黄金比例序列，确定性展开，避免点重叠成竖线）
    const jitter = (i: number) => (((i * 0.6180339887498949) % 1) - 0.5) * 0.5;

    chart.setOption({
      animationDuration: 420,
      animationEasing: 'cubicOut',
      title: {
        text: unit ? `${title} (${unit})` : title,
        left: 8,
        top: 6,
        textStyle: {
          fontSize: 13,
          fontWeight: 600,
          color: '#1e293b',
          fontFamily: FONT_STACK,
        },
      },
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#e2e8f0',
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: '#334155', fontSize: 12, fontFamily: FONT_STACK },
        extraCssText:
          'box-shadow: 0 4px 16px -6px rgba(15,23,42,0.18); border-radius: 8px; backdrop-filter: blur(4px);',
        formatter: (p: unknown) => {
          const param = p as {
            seriesType: string;
            name: string;
            value: number[] | [number, number];
          };
          if (param.seriesType === 'boxplot') {
            const d = param.value as number[];
            return (
              `<b>${param.name}</b><br/>` +
              `上须: ${d[4]?.toFixed(2)}<br/>` +
              `Q3: ${d[3]?.toFixed(2)}<br/>` +
              `中位: ${d[2]?.toFixed(2)}<br/>` +
              `Q1: ${d[1]?.toFixed(2)}<br/>` +
              `下须: ${d[0]?.toFixed(2)}`
            );
          }
          const v = param.value as [number, number];
          return `<b>${param.name}</b><br/>数据点: ${v[1].toFixed(2)}`;
        },
      },
      grid: { left: 56, right: 16, top: 46, bottom: 60 },
      xAxis: {
        type: 'category',
        data: data.categories,
        axisLabel: { rotate: 32, fontSize: 11, color: '#475569', fontFamily: FONT_STACK },
        axisLine: { lineStyle: { color: '#cbd5e1' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        name: unit,
        nameTextStyle: { color: '#64748b', fontSize: 11, fontFamily: FONT_STACK },
        axisLabel: { color: '#475569', fontSize: 11, fontFamily: FONT_STACK },
        splitLine: { lineStyle: { color: '#e2e8f0' } },
      },
      series: [
        {
          name: title,
          type: 'boxplot',
          data: data.boxes,
          itemStyle: {
            color: 'rgba(37, 99, 235, 0.12)',
            borderColor: '#2563eb',
            borderWidth: 1.5,
          },
          emphasis: { itemStyle: { color: 'rgba(37, 99, 235, 0.25)' } },
        },
        {
          name: '数据点',
          type: 'scatter',
          data: data.points.map(([ci, v], i) => [ci + jitter(i), v]),
          symbolSize: 5,
          itemStyle: {
            color: 'rgba(29, 78, 216, 0.45)',
            borderColor: 'rgba(29, 78, 216, 0.85)',
            borderWidth: 0.5,
          },
        },
      ],
    });
  }, [title, unit, data]);

  return <div ref={containerRef} className="h-72 w-full" />;
}
