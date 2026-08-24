import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../store/DataContext';
import { useCriteria } from '../store/CriteriaContext';
import { useSelection } from '../store/SelectionContext';
import { queryBatches, querySamples, saveReportMeta, queryRecentReportMetas } from '../database/db';
import { Badge, Button, Card, EmptyState, Loading, PageHeader } from '../components/ui';
import ReportTemplate from '../report/ReportTemplate';
import {
  batchLabelOf,
  buildOverviewSummary,
  buildReportData,
  buildSummaryGroups,
  criteriaTextShort,
  generateDiscussionDraft,
  isValidDevice,
  metricValue,
  scanLabelOf,
  type ReportData,
} from '../report/reportData';
import { fmt } from '../utils/statistics';
import { loadMailRecipients } from '../utils/mailRecipients';
import { exportReportExcel, exportReportExcelBlob, exportReportPdf, buildReportFileName } from '../report/exporters';
import type { BatchSummary, ReportMetaInput, ReportMetadata, SampleRecord } from '../types';

/* ================= 表单字段定义 ================= */

const TEXT_FIELDS: {
  key: keyof ReportMetaInput;
  label: string;
  placeholder: string;
  rows: number;
  hint?: string;
}[] = [
  {
    key: 'research_purpose',
    label: '研究目的与意义',
    placeholder: '说明本批实验的研究背景、拟验证的假设及其意义…',
    rows: 4,
  },
  {
    key: 'process_method',
    label: '过程与方法',
    placeholder: '溶液配置、器件制备步骤、测试条件与关键工艺参数…',
    rows: 5,
  },
  {
    key: 'key_parameters',
    label: '关键工艺参数',
    placeholder: '如：前驱体浓度、退火温度/时间、旋涂转速、HTL 厚度等…',
    rows: 3,
  },
  {
    key: 'discussion',
    label: '结果讨论',
    placeholder: '可点击下方「生成初稿」基于统计数据自动起草，再人工修改…',
    rows: 6,
    hint: '支持自动生成初稿',
  },
  {
    key: 'conclusion',
    label: '研究结论',
    placeholder: '总结批次间性能差异及可能原因…',
    rows: 4,
  },
  {
    key: 'next_steps',
    label: '下一步计划',
    placeholder: '后续实验安排、优化方向…',
    rows: 3,
  },
];

function emptyMeta(): ReportMetaInput {
  return {
    report_date: new Date().toISOString().slice(0, 10),
    reporter: '',
    research_purpose: '',
    process_method: '',
    key_parameters: '',
    discussion: '',
    conclusion: '',
    next_steps: '',
  };
}

/* ================= 默认模板持久化 ================= */

const DEFAULT_META_KEY = 'dv-default-report-meta';

function loadDefaultMeta(): ReportMetaInput {
  const init = emptyMeta();
  try {
    const raw = localStorage.getItem(DEFAULT_META_KEY);
    if (!raw) {
      init.reporter = localStorage.getItem('lastReporter') || '';
      return init;
    }
    const t = JSON.parse(raw) as Partial<ReportMetaInput>;
    return {
      ...init,
      reporter: typeof t.reporter === 'string' ? t.reporter : '',
      research_purpose: typeof t.research_purpose === 'string' ? t.research_purpose : '',
      process_method: typeof t.process_method === 'string' ? t.process_method : '',
      key_parameters: typeof t.key_parameters === 'string' ? t.key_parameters : '',
      discussion: typeof t.discussion === 'string' ? t.discussion : '',
      conclusion: typeof t.conclusion === 'string' ? t.conclusion : '',
      next_steps: typeof t.next_steps === 'string' ? t.next_steps : '',
    };
  } catch {
    return init;
  }
}

/* ================= 邮件正文（报告全文） ================= */

/** 差值文本：>0 带 + 号，保留两位小数 */
function deltaStr(v: number): string {
  return `${v > 0 ? '+' : ''}${fmt(v, 2)}`;
}

/** 单批次指标行（冠军 / 中位 / 最优共用格式） */
function summaryRow(
  label: string,
  v: { eff: number; voc: number; jsc: number; ff: number; rs: number; rsh: number; vocff: number },
  suffix = '',
): string {
  return `  ${label}${suffix}：PCE ${fmt(v.eff)}% | Voc ${fmt(v.voc)}V | Jsc ${fmt(v.jsc)}mA/cm² | FF ${fmt(v.ff)} | Rs ${fmt(v.rs)}Ω | Rsh ${fmt(v.rsh)}Ω | Voc·FF ${fmt(v.vocff)}V`;
}

/** 构建邮件正文：与 PDF 报告正文一致的全部内容（箱线图等图表除外，正文末尾注明见附件） */
function buildReportEmailBody(meta: ReportMetaInput, data: ReportData): string {
  const lines: string[] = [];
  const hasText = (s: string | null | undefined) => !!s && !!s.trim();

  /* 报告头 */
  lines.push('钙钛矿器件验证对比分析报告');
  lines.push('');
  lines.push(`汇报人：${meta.reporter?.trim() || '—'}`);
  lines.push(`汇报日期：${meta.report_date || '—'}`);
  lines.push(
    `参与批次：${data.totals.batches} 个（${data.groups.map((g) => g.batchId).join('、') || '—'}）`,
  );
  if (data.baseline) lines.push(`基准批次：${data.baseline.baselineBatchId}`);
  lines.push(`测试记录：${data.totals.samples} 条（反扫 ${data.totals.reverse} 条）`);
  lines.push(`有效测试记录：${data.totals.valid}/${data.totals.reverse}（符合口径反扫数 / 反扫总数）`);
  lines.push('');

  /* 报告总览 */
  if (data.groups.length > 0) {
    lines.push('【报告总览】');
    lines.push(
      '批次 | PCE冠军(%) | PCE中位(%) | Voc中位(V) | Jsc中位(mA/cm²) | FF | Voc·FF平均(V) | 判定',
    );
    for (const g of data.groups) {
      const isBase = g.batchId === data.baseline?.baselineBatchId;
      const verdict = data.baseline?.diffs.find((d) => d.batchId === g.batchId)?.verdict;
      const cols = [
        fmt(g.champion?.efficiency ?? NaN),
        fmt(data.metricStats['efficiency'][g.batchId]?.median ?? NaN),
        fmt(data.metricStats['voc_V'][g.batchId]?.median ?? NaN),
        fmt(data.metricStats['jsc_mA_cm2'][g.batchId]?.median ?? NaN),
        fmt(data.metricStats['ff'][g.batchId]?.median ?? NaN),
        fmt(data.metricStats['vocff'][g.batchId]?.mean ?? NaN),
      ].join(' | ');
      lines.push(
        `${isBase ? '⚑ ' : ''}${batchLabelOf(g.batchId)} | ${cols} | ${isBase ? '基准' : verdict ?? '—'}`,
      );
    }
    lines.push('');
    const overview = buildOverviewSummary(data);
    if (overview) {
      lines.push(overview);
      lines.push('');
    }
  }

  /* 一 ~ 三：文字章节 */
  if (hasText(meta.research_purpose)) {
    lines.push('一、研究目的与意义');
    lines.push(meta.research_purpose!.trim());
    lines.push('');
  }
  if (hasText(meta.process_method)) {
    lines.push('二、过程与方法');
    lines.push(meta.process_method!.trim());
    lines.push('');
  }
  if (hasText(meta.key_parameters)) {
    lines.push('三、关键工艺参数');
    lines.push(meta.key_parameters!.trim());
    lines.push('');
  }

  /* 四、实验数据 */
  if (data.groups.length > 0) {
    lines.push('四、实验数据');
    lines.push(
      `本节共 ${data.totals.samples} 条测试记录（其中反扫 ${data.totals.reverse} 条），全部统计均基于符合统计口径的有效测试记录 ${data.totals.valid} 条（口径：${criteriaTextShort(data.thresholds)}）。`,
    );
    lines.push('');

    /* 4.5 汇总表 */
    const summaryGroups = buildSummaryGroups(data);
    if (summaryGroups.length > 0) {
      lines.push('4.5 各批次关键参数汇总表（冠军 / 中位 / 最优）');
      for (const g of summaryGroups) {
        lines.push(`${batchLabelOf(g.batchId)}（有效 ${g.validCount}/${g.totalCount}）`);
        if (g.champion) {
          const c = g.champion;
          lines.push(
            `  冠军（${scanLabelOf(c.sample_name, g.batchId)}）：PCE ${fmt(c.efficiency)}% | Voc ${fmt(c.voc_V)}V | Jsc ${fmt(c.jsc_mA_cm2)}mA/cm² | FF ${fmt(c.ff)} | Rs ${fmt(c.rs_ohm)}Ω | Rsh ${fmt(c.rsh_ohm)}Ω | Voc·FF ${fmt(metricValue(c, 'vocff'))}V`,
          );
        } else {
          lines.push('  无 PCE 测试数据');
        }
        lines.push(summaryRow('中位', g.median));
        lines.push(summaryRow('最优', g.best));
      }
      lines.push('');
    }

    /* 4.6 Baseline 差值对比 */
    if (data.baseline && data.baseline.diffs.length > 0) {
      lines.push(`4.6 Baseline 差值对比（基准：${data.baseline.baselineBatchId}）`);
      lines.push(
        `⚑ ${data.baseline.baselineBatchId}（基准）：冠军 PCE ${fmt(data.baseline.baselineChampion)}% | 中位 PCE ${fmt(data.baseline.baselineMedian)}% | 平均 Voc·FF ${fmt(data.baseline.baselineVocffMean)}V`,
      );
      for (const d of data.baseline.diffs) {
        lines.push(
          `${d.batchId}：冠军 PCE ${fmt(d.champion)}%（Δ${deltaStr(d.championDelta)}）| 中位 PCE ${fmt(d.median)}%（Δ${deltaStr(d.medianDelta)}）| 平均 Voc·FF ${fmt(d.vocffMean)}V（Δ${deltaStr(d.vocffMeanDelta ?? NaN)}）| 判定：${d.verdict}`,
        );
      }
      lines.push('');
    }

    /* 4.7 分析结论 */
    if (data.baseline?.conclusion) {
      lines.push('4.7 分析结论（Baseline 自动判定）');
      lines.push(data.baseline.conclusion);
      lines.push('');
    }
  }

  /* 五 ~ 七：文字章节 */
  if (hasText(meta.discussion)) {
    lines.push('五、结果讨论');
    lines.push(meta.discussion!.trim());
    lines.push('');
  }
  if (hasText(meta.conclusion)) {
    lines.push('六、研究结论');
    lines.push(meta.conclusion!.trim());
    lines.push('');
  }
  if (hasText(meta.next_steps)) {
    lines.push('七、下一步计划');
    lines.push(meta.next_steps!.trim());
    lines.push('');
  }

  lines.push('（箱线图等图表内容见附件 Excel 报告，PDF 版可于系统内导出）');
  lines.push('本报告由器件验证数据分析系统生成');
  return lines.join('\n');
}

/* ================= 主组件 ================= */

export default function ReportEditor() {
  const { dbReady, version } = useData();
  const { thresholds } = useCriteria();
  const { selectedBatchIds, baselineBatchId, toggleBatch, setBaseline, setSelection } =
    useSelection();

  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [records, setRecords] = useState<SampleRecord[]>([]);
  const [batchQuery, setBatchQuery] = useState('');
  const [meta, setMeta] = useState<ReportMetaInput>(() => loadDefaultMeta());
  const [templates, setTemplates] = useState<ReportMetadata[]>([]);
  const [exporting, setExporting] = useState<'pdf' | 'excel' | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [savedTip, setSavedTip] = useState('');

  const paperRef = useRef<HTMLDivElement>(null);

  const selected = selectedBatchIds;
  const baseline = baselineBatchId;

  /* 数据加载 */
  useEffect(() => {
    if (!dbReady) return;
    setBatches(queryBatches());
    setTemplates(queryRecentReportMetas(8));
  }, [dbReady, version]);

  useEffect(() => {
    if (!dbReady) return;
    setRecords(querySamples());
  }, [dbReady, version]);

  /* 各批次有效测试记录数与反扫记录数（用于批次标签「有效 X/Y」显示，随口径实时重算） */
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

  /* 首次加载默认勾选（仅在 SelectionContext 为空时触发） */
  useEffect(() => {
    if (batches.length > 0 && records.length > 0 && selected.length === 0) {
      const withValid = batches.filter((b) => (validCounts.get(b.batch_id) ?? 0) > 0);
      const pool = withValid.length > 0 ? withValid : batches;
      const init = pool.slice(0, Math.min(4, pool.length)).map((b) => b.batch_id);
      setSelection(init, init[0]);
    }
  }, [batches, records]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 报告数据（实时计算） */
  const reportData = useMemo(
    () => buildReportData(selected, records, thresholds, baseline),
    [selected, records, thresholds, baseline],
  );

  const setField = (key: keyof ReportMetaInput, value: string) => {
    setMeta((prev) => ({ ...prev, [key]: value }));
    if (key === 'reporter' && value.trim()) {
      localStorage.setItem('lastReporter', value.trim());
    }
  };

  /* 批量操作 */
  const selectAllBatches = () => setSelection(batches.map((b) => b.batch_id));
  const clearSelection = () => setSelection([]);
  const selectValidBatches = () =>
    setSelection(
      batches.filter((b) => (validCounts.get(b.batch_id) ?? 0) > 0).map((b) => b.batch_id),
    );

  /* 批次搜索过滤 */
  const visibleBatches = useMemo(() => {
    const q = batchQuery.trim().toLowerCase();
    if (!q) return batches;
    return batches.filter(
      (b) =>
        b.batch_id.toLowerCase().includes(q) ||
        (b.material_type ?? '').toLowerCase().includes(q),
    );
  }, [batches, batchQuery]);

  /* 错误提示 6 秒后自动消失 */
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const generateDraft = () => {
    if (reportData.totals.valid === 0) {
      setError('当前选择批次在统计口径下无有效测试记录，无法生成讨论初稿');
      return;
    }
    const draft = generateDiscussionDraft(reportData);
    if (meta.discussion.trim() && !confirm('结果讨论已有内容，确定要覆盖吗？')) return;
    setField('discussion', draft);
  };

  const saveTemplate = async () => {
    try {
      await saveReportMeta(meta);
      setTemplates(queryRecentReportMetas(8));
      setSavedTip('文字模板已保存');
      setTimeout(() => setSavedTip(''), 2000);
    } catch (e) {
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const loadTemplate = (t: ReportMetadata) => {
    setMeta({
      report_date: meta.report_date,
      reporter: t.reporter || meta.reporter,
      research_purpose: t.research_purpose || '',
      process_method: t.process_method || '',
      key_parameters: t.key_parameters || '',
      discussion: t.discussion || '',
      conclusion: t.conclusion || '',
      next_steps: t.next_steps || '',
    });
    setSavedTip(`已载入 ${t.report_date} 的模板`);
    setTimeout(() => setSavedTip(''), 2000);
  };

  const setDefaultTemplate = (t: ReportMetadata) => {
    try {
      localStorage.setItem(DEFAULT_META_KEY, JSON.stringify({
        report_date: t.report_date, reporter: t.reporter,
        research_purpose: t.research_purpose, process_method: t.process_method,
        key_parameters: t.key_parameters, discussion: t.discussion,
        conclusion: t.conclusion, next_steps: t.next_steps,
      }));
      setSavedTip(`已将 ${t.report_date} 的模板设为默认`);
    } catch {
      setError('默认模板保存失败（浏览器存储不可用）');
      return;
    }
    setTimeout(() => setSavedTip(''), 2000);
  };

  const clearDefaultTemplate = () => {
    try { localStorage.removeItem(DEFAULT_META_KEY); } catch { /* 忽略 */ }
    setSavedTip('已取消默认模板');
    setTimeout(() => setSavedTip(''), 2000);
  };

  const defaultTemplateDate = (() => {
    try {
      const raw = localStorage.getItem(DEFAULT_META_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw) as Partial<ReportMetaInput>;
      return typeof t.report_date === 'string' ? t.report_date : null;
    } catch { return null; }
  })();

  const handleExport = async (kind: 'pdf' | 'excel') => {
    if (!paperRef.current) return;
    if (reportData.totals.valid === 0) {
      setError('请至少选择一个包含有效测试记录的批次后再导出');
      return;
    }
    setError('');
    setExporting(kind);
    setProgress('正在准备…');
    await new Promise((r) => setTimeout(r, 60));
    try {
      if (kind === 'pdf') {
        await exportReportPdf(paperRef.current, meta, reportData, { onProgress: setProgress });
      } else {
        await exportReportExcel(paperRef.current, meta, reportData, { onProgress: setProgress });
      }
    } catch (e) {
      setError(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(null);
      setProgress('');
    }
  };

  /** 一键发送邮件：生成 Excel 附件 → 自动下载 → 打开默认邮件客户端
   *  邮件正文为 PDF 报告的全部内容（图表除外，见附件说明），
   *  用户需手动将已下载的 Excel 文件粘贴到邮件附件中。 */
  const handleSendEmail = async () => {
    if (!paperRef.current) return;
    if (reportData.totals.valid === 0) {
      setError('请至少选择一个包含有效测试记录的批次后再发送');
      return;
    }
    setError('');
    setEmailing(true);
    setProgress('正在生成报告…');
    await new Promise((r) => setTimeout(r, 60));
    try {
      // 生成 Excel 并触发下载
      const blob = await exportReportExcelBlob(paperRef.current, meta, reportData, {
        onProgress: setProgress,
      });
      const filename = buildReportFileName(
        meta,
        reportData.groups.map((g) => g.batchId),
        'xlsx',
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      // 邮件正文：PDF 报告全文
      const subject = `器件分析报告 - ${reportData.groups.map((g) => g.batchId).join(' vs ')}`;
      const body = encodeURIComponent(buildReportEmailBody(meta, reportData));
      // 默认收件人：系统设置中增删，发送前可在飞书写信窗口中修改
      const recipients = loadMailRecipients().join(',');
      const mailto = `mailto:${recipients}?subject=${encodeURIComponent(subject)}&body=${body}`;

      // 打开邮件客户端
      window.open(mailto, '_blank');

      setProgress('Excel 已下载，请在邮件客户端中粘贴为附件');
      setTimeout(() => {
        setProgress('');
        setEmailing(false);
      }, 3000);
    } catch (e) {
      setError(`发送失败：${e instanceof Error ? e.message : String(e)}`);
      setEmailing(false);
      setProgress('');
    }
  };

  if (!dbReady) return <Loading text="数据库初始化中…" />;

  /* ======== 左侧表单 ======== */
  const formSection = (
    <div className="space-y-5">
      {/* 数据选择 */}
      <Card
        title="数据选择"
        extra={
          <span className="text-[11px] text-slate-400">
            已选 {selected.length}/{batches.length} 个批次
          </span>
        }
        bodyClassName="px-5 py-4"
      >
        {/* 批量操作 + 搜索 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <button
              onClick={selected.length === batches.length ? clearSelection : selectAllBatches}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-blue-400 hover:text-blue-600"
            >
              {selected.length === batches.length && batches.length > 0 ? '取消全选' : '全选'}
            </button>
            <button
              onClick={selectValidBatches}
              disabled={reportData.totals.validBatches === 0 && selected.length === 0}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-emerald-400 hover:text-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              仅选有效批次
            </button>
            <button
              onClick={clearSelection}
              disabled={selected.length === 0}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-red-300 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              清空
            </button>
          </div>
          <div className="relative ml-auto">
            <input
              type="text"
              value={batchQuery}
              onChange={(e) => setBatchQuery(e.target.value)}
              placeholder="搜索批次…"
              className="w-36 rounded-md border border-slate-200 px-2.5 py-1 text-xs focus:border-blue-400 focus:outline-none"
            />
            {batchQuery && (
              <button
                onClick={() => setBatchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Baseline 说明 */}
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="shrink-0 font-semibold">⚑ Baseline</span>
          <span>
            当前基准：{baseline ? <span className="font-mono font-semibold">{baseline}</span> : '未选择'}
            ；点击右侧「设为基准」切换
          </span>
        </div>

        {/* 批次标签 */}
        <div className="max-h-56 overflow-y-auto pr-1">
          {visibleBatches.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {visibleBatches.map((b) => {
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
                      <span className={active ? 'text-blue-200' : valid > 0 ? 'text-emerald-600' : 'text-red-400'}>
                        {valid}/{reverse}
                      </span>
                    </button>
                    {active && (
                      <button
                        onClick={() => setBaseline(b.batch_id)}
                        className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                          isBase ? 'text-amber-700' : 'text-blue-200 hover:bg-blue-500 hover:text-white'
                        }`}
                      >
                        {isBase ? '★ 基准' : '设为基准'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-slate-400">没有匹配「{batchQuery}」的批次</p>
          )}
        </div>
        <p className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
          <span>标签显示「有效 / 反扫总数」（符合口径反扫数 / 反扫总数）</span>
          <Link
            to="/settings"
            className="text-blue-600 transition-colors hover:text-blue-700 hover:underline"
          >
            口径与判定设置 →
          </Link>
        </p>
      </Card>

      {/* 当前选择统计摘要（精简版） */}
      <div className="rounded-xl border border-slate-200 bg-white px-5 py-3 shadow-sm">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">
            口径：{criteriaTextShort(thresholds)}
          </span>
          <span className="font-mono text-slate-700">
            有效 {reportData.totals.valid}/{reportData.totals.reverse}（符合口径反扫数 / 反扫总数）
          </span>
        </div>
      </div>

      {/* 报告信息 */}
      <Card title="报告信息（手工录入）" bodyClassName="px-5 py-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">汇报人</span>
            <input
              type="text"
              value={meta.reporter}
              onChange={(e) => setField('reporter', e.target.value)}
              placeholder="姓名"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">汇报日期</span>
            <input
              type="date"
              value={meta.report_date}
              onChange={(e) => setField('report_date', e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </label>
        </div>

        {TEXT_FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">{f.label}</span>
              {f.key === 'discussion' && (
                <button
                  onClick={generateDraft}
                  type="button"
                  className="text-xs font-medium text-blue-600 hover:text-blue-700"
                >
                  生成初稿
                </button>
              )}
            </span>
            <textarea
              rows={f.rows}
              value={meta[f.key] as string}
              onChange={(e) => setField(f.key, e.target.value)}
              placeholder={f.placeholder}
              className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm leading-6 text-slate-700 focus:border-blue-500 focus:outline-none"
            />
          </label>
        ))}
      </Card>

      {/* 文字模板 */}
      <Card title="文字模板" bodyClassName="px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={saveTemplate} disabled={!meta.reporter.trim()}>
            保存当前文字为模板
          </Button>
          {defaultTemplateDate ? (
            <button
              onClick={clearDefaultTemplate}
              className="text-xs text-amber-600 transition-colors hover:text-amber-700 hover:underline"
            >
              ★ 默认：{defaultTemplateDate}（点击取消）
            </button>
          ) : (
            <span className="text-[11px] text-slate-400">可将某份模板设为默认，新建报告自动填充</span>
          )}
          {savedTip && <Badge tone="green">{savedTip}</Badge>}
        </div>
        {templates.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <div className="text-xs font-medium text-slate-500">最近保存（点击载入）：</div>
            {templates.map((t) => {
              const isDefault = t.report_date === defaultTemplateDate;
              return (
                <div
                  key={t.id}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs ${
                    isDefault ? 'border-amber-200 bg-amber-50' : 'border-slate-100 bg-slate-50 hover:border-blue-300 hover:bg-blue-50'
                  }`}
                >
                  <button onClick={() => loadTemplate(t)} className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="font-medium text-slate-700">
                      {isDefault && <span className="text-amber-500">★ </span>}
                      {t.report_date} · {t.reporter || '未署名'}
                    </span>
                    <span className="truncate text-slate-400">
                      {(t.research_purpose || t.conclusion || '').slice(0, 24) || '（空模板）'}
                    </span>
                  </button>
                  <button
                    onClick={() => (isDefault ? clearDefaultTemplate() : setDefaultTemplate(t))}
                    className={`ml-3 shrink-0 transition-colors ${
                      isDefault ? 'text-amber-600 hover:text-amber-700' : 'text-slate-400 hover:text-amber-600'
                    }`}
                  >
                    {isDefault ? '取消默认' : '设为默认'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );

  if (batches.length === 0) {
    return (
      <div>
        <PageHeader title="报告生成" description="按批次对比生成器件验证报告，导出 PDF 或 Excel" />
        <Card>
          <EmptyState
            icon="file"
            title="暂无数据，无法生成报告"
            description="请先导入 TXT 源文件"
            action={<Link to="/data"><Button>前往导入</Button></Link>}
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="报告生成"
        description={`口径：${criteriaTextShort(thresholds)}；支持导出 PDF / Excel`}
        actions={
          <>
            {(exporting || emailing || error) && (
              <span className={`text-xs ${error ? 'text-red-600' : 'text-slate-500'}`}>
                {error || progress}
              </span>
            )}
            <Button
              variant="secondary"
              onClick={() => handleExport('excel')}
              disabled={exporting !== null || emailing}
            >
              {exporting === 'excel' ? '导出中…' : '导出 Excel'}
            </Button>
            <Button onClick={() => handleExport('pdf')} disabled={exporting !== null || emailing}>
              {exporting === 'pdf' ? '导出中…' : '导出 PDF'}
            </Button>
            <Button
              onClick={handleSendEmail}
              disabled={exporting !== null || emailing}
              variant="secondary"
            >
              {emailing ? '发送中…' : '发送邮件'}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[400px_minmax(0,1fr)]">
        {/* 左：表单 */}
        <div className="xl:sticky xl:top-6 xl:max-h-[calc(100vh-140px)] xl:overflow-y-auto xl:pr-1">
          {formSection}
        </div>

        {/* 右：报告预览 */}
        <div
          className="overflow-x-auto rounded-xl p-6"
          style={{
            backgroundColor: '#e8ebf1',
            backgroundImage: 'radial-gradient(rgba(15,23,42,0.055) 1px, transparent 1px)',
            backgroundSize: '18px 18px',
          }}
        >
          <div className="shadow-[0_1px_3px_rgba(15,23,42,0.12),0_24px_48px_-24px_rgba(15,23,42,0.35)]">
            <ReportTemplate ref={paperRef} meta={meta} data={reportData} />
          </div>
        </div>
      </div>
    </div>
  );
}