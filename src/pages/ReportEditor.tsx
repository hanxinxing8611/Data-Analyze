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
  criteriaTextShort,
  generateDiscussionDraft,
  isValidDevice,
  type ReportData,
} from '../report/reportData';
import { fmt } from '../utils/statistics';
import { loadMailRecipients } from '../utils/mailRecipients';
import { getCurrentEngineer, getCurrentEngineerEmail } from '../utils/permissions';
import { exportReportExcel, exportReportExcelBlob, exportReportPdf, buildReportFileName, type ChartImage } from '../report/exporters';
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
      // 优先使用侧边栏选择的当前身份，其次使用上次保存的报告人（兼容旧数据）
      init.reporter = getCurrentEngineer() || localStorage.getItem('lastReporter') || '';
      return init;
    }
    const t = JSON.parse(raw) as Partial<ReportMetaInput>;
    return {
      ...init,
      reporter: typeof t.reporter === 'string' ? t.reporter : (getCurrentEngineer() || localStorage.getItem('lastReporter') || ''),
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

/* ================= 邮件正文（报告总览 + 分析结论，文本 / HTML 双渲染） ================= */

/** 邮件正文内容块：纯文本与 HTML 富文本共用同一内容序列；
 *  meta 块渲染为报告头信息表（短字段两两并排，长字段整行）；
 *  overview 块在 HTML 中渲染为 PDF 报告总览截图（无截图时回退结构化表格），纯文本按列宽对齐；
 *  chart 块在 HTML 中渲染为内嵌箱线图图片，纯文本中以附件说明代替；
 *  criteria 块渲染为统计口径脚注小字 */
interface MetaRow {
  label: string;
  value: string;
  /** 值较长（如批次清单）时整行显示 */
  wide?: boolean;
}

type EmailBlock =
  | { kind: 'title'; text: string }
  | { kind: 'meta'; rows: MetaRow[] }
  | { kind: 'h2'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'overview'; header: string[]; rows: string[][]; summary?: string }
  | { kind: 'chart' }
  | { kind: 'criteria'; text: string };

/** 构建邮件正文内容块（精简版）：报告头关键信息 + 一、报告总览（含箱线图）+ 二、分析结论 + 口径脚注 */
function buildEmailBlocks(meta: ReportMetaInput, data: ReportData): EmailBlock[] {
  const blocks: EmailBlock[] = [];

  /* 报告头：信息表（短字段两两并排，批次清单等长字段整行） */
  blocks.push({ kind: 'title', text: '钙钛矿器件验证对比分析报告' });
  const metaRows: MetaRow[] = [
    { label: '汇报人', value: meta.reporter?.trim() || '—' },
    { label: '汇报日期', value: meta.report_date || '—' },
    {
      label: '参与批次',
      value: `${data.totals.batches} 个（${data.groups.map((g) => g.batchId).join('、') || '—'}）`,
      wide: true,
    },
  ];
  if (data.baseline) metaRows.push({ label: '基准批次', value: data.baseline.baselineBatchId });
  metaRows.push(
    { label: '测试记录', value: `${data.totals.samples} 条（反扫 ${data.totals.reverse} 条）` },
    { label: '有效测试记录', value: `${data.totals.valid}/${data.totals.reverse}（符合口径反扫数 / 反扫总数）` },
  );
  blocks.push({ kind: 'meta', rows: metaRows });

  /* 一、报告总览（HTML：PDF 报告总览块截图 + 箱线图；纯文本按列宽对齐矩阵） */
  if (data.groups.length > 0) {
    blocks.push({ kind: 'h2', text: '一、报告总览' });
    const header = ['批次', 'PCE冠军(%)', 'PCE中位(%)', 'Voc中位(V)', 'Jsc中位(mA/cm²)', 'FF', 'Voc·FF平均(V)', '判定'];
    const rows: string[][] = [];
    for (const g of data.groups) {
      const isBase = g.batchId === data.baseline?.baselineBatchId;
      const verdict = data.baseline?.diffs.find((d) => d.batchId === g.batchId)?.verdict;
      rows.push([
        `${isBase ? '⚑ ' : ''}${batchLabelOf(g.batchId)}`,
        fmt(g.champion?.efficiency ?? NaN),
        fmt(data.metricStats['efficiency'][g.batchId]?.median ?? NaN),
        fmt(data.metricStats['voc_V'][g.batchId]?.median ?? NaN),
        fmt(data.metricStats['jsc_mA_cm2'][g.batchId]?.median ?? NaN),
        fmt(data.metricStats['ff'][g.batchId]?.median ?? NaN),
        fmt(data.metricStats['vocff'][g.batchId]?.mean ?? NaN),
        isBase ? '基准' : verdict ?? '—',
      ]);
    }
    blocks.push({ kind: 'overview', header, rows, summary: buildOverviewSummary(data) || undefined });
    blocks.push({ kind: 'chart' });
  }

  /* 二、分析结论（Baseline 自动判定） */
  if (data.baseline?.conclusion) {
    blocks.push({ kind: 'h2', text: '二、分析结论' });
    blocks.push({ kind: 'p', text: data.baseline.conclusion });
  }

  /* 统计口径脚注 */
  blocks.push({ kind: 'criteria', text: `统计口径：有效测试记录 = ${criteriaTextShort(data.thresholds)}` });
  return blocks;
}

/* ---- 纯文本列对齐（中文按 2 字符宽计算，等宽字体下视觉对齐） ---- */

function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

function padEndW(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - dispWidth(s)));
}

function padStartW(s: string, w: number): string {
  return ' '.repeat(Math.max(0, w - dispWidth(s))) + s;
}

/** 渲染纯文本正文（mailto 与剪贴板 text/plain；overview 按列宽对齐，图表以附件说明代替） */
function renderEmailText(blocks: EmailBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'chart') continue;
    if (b.kind === 'title') {
      lines.push(b.text, '');
    } else if (b.kind === 'meta') {
      for (const r of b.rows) lines.push(`${r.label}：${r.value}`);
      lines.push('');
    } else if (b.kind === 'h2') {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(b.text);
    } else if (b.kind === 'overview') {
      /* 各列取最大显示宽度（表头与数据），首列与判定列左对齐、数值列右对齐 */
      const colW = b.header.map((h, i) =>
        Math.max(dispWidth(h), ...b.rows.map((r) => dispWidth(r[i] ?? ''))),
      );
      lines.push(b.header.map((h, i) => (i === 0 || i === b.header.length - 1 ? padEndW(h, colW[i]) : padStartW(h, colW[i]))).join('  '));
      for (const row of b.rows) {
        lines.push(row.map((c, i) => (i === 0 || i === row.length - 1 ? padEndW(c, colW[i]) : padStartW(c, colW[i]))).join('  '));
      }
      if (b.summary) lines.push('', b.summary);
    } else if (b.kind === 'criteria') {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(b.text);
    } else {
      lines.push(b.text);
    }
  }
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
  lines.push('（以上为报告总览与分析结论；箱线图等图表内容见附件 Excel 报告，PDF 版可于系统内导出）');
  lines.push('本报告由器件验证数据分析系统生成');
  return lines.join('\n');
}

/** HTML 转义（正文文本进入 HTML 前统一处理） */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 邮件正文字体（与报告导出一致：微软雅黑 / 方正雅黑） */
const EMAIL_FONT_STACK = `'Microsoft YaHei','方正雅黑','PingFang SC',sans-serif`;

/** 渲染 HTML 富文本正文：报告总览块与箱线图以 base64 内嵌（粘贴到飞书 / Gmail 等邮件客户端即带图） */
function renderEmailHtml(blocks: EmailBlock[], charts: ChartImage[], overview?: ChartImage): string {
  const parts: string[] = [];
  let chartIdx = 0;
  for (const b of blocks) {
    if (b.kind === 'title') {
      parts.push(
        `<h1 style="margin:0 0 16px;font-size:18px;line-height:1.4;font-weight:700;color:#0f172a;">${escapeHtml(b.text)}</h1>`,
      );
    } else if (b.kind === 'meta') {
      /* 报告头信息表：短字段两两并排、长字段整行（浅灰底卡片） */
      const cells: string[] = [];
      const td = (r: MetaRow, wide: boolean) =>
        `<td${wide ? ' colspan="2"' : ''} style="padding:6px 12px;vertical-align:top;">` +
        `<span style="font-size:12px;color:#64748b;">${escapeHtml(r.label)}：</span>` +
        `<span style="font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(r.value)}</span>` +
        `</td>`;
      const shortRows: MetaRow[] = [];
      for (const r of b.rows) {
        if (r.wide) {
          if (shortRows.length > 0) {
            cells.push(shortRows.map((s) => td(s, false)).join(''));
            shortRows.length = 0;
          }
          cells.push(td(r, true));
        } else {
          shortRows.push(r);
          if (shortRows.length === 2) {
            cells.push(shortRows.map((s) => td(s, false)).join(''));
            shortRows.length = 0;
          }
        }
      }
      if (shortRows.length > 0) cells.push(shortRows.map((s) => td(s, false)).join('<td style="padding:6px 12px;"></td>'));
      parts.push(
        `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px;border-collapse:separate;background:#f8fafc;border-radius:8px;">` +
          `<tr>${cells.join('</tr><tr>')}</tr>` +
          `</table>`,
      );
    } else if (b.kind === 'h2') {
      /* 章节标题：上方细分隔线 + 左侧主题色竖条 */
      parts.push(
        `<h2 style="margin:24px 0 10px;padding:14px 0 0 10px;border-top:1px solid #e2e8f0;border-left:3px solid #2563eb;font-size:15px;line-height:1.4;font-weight:700;color:#0f172a;">${escapeHtml(b.text)}</h2>`,
      );
    } else if (b.kind === 'p') {
      /* pre-wrap 保留汇总行的对齐空格与缩进 */
      parts.push(
        `<p style="margin:4px 0;font-size:13px;line-height:1.7;color:#1e293b;white-space:pre-wrap;">${escapeHtml(b.text)}</p>`,
      );
    } else if (b.kind === 'overview') {
      if (overview) {
        /* PDF 报告总览块截图（热力矩阵 + 汇总文字） */
        parts.push(
          `<div style="margin:12px 0 20px;">` +
            `<img src="data:${overview.mime};base64,${overview.base64}" width="${overview.width}" height="${overview.height}" ` +
            `style="display:block;width:100%;max-width:${overview.width}px;height:auto;border:1px solid #e2e8f0;border-radius:8px;" />` +
            `</div>`,
        );
      } else {
        /* 截图不可用时回退结构化表格 */
        parts.push(
          `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:12px 0 20px;font-size:12px;color:#1e293b;">` +
            `<tr>${b.header.map((h) => `<th style="border:1px solid #e2e8f0;padding:6px 8px;background:#f1f5f9;font-weight:600;">${escapeHtml(h)}</th>`).join('')}</tr>` +
            b.rows
              .map(
                (row) =>
                  `<tr>${row.map((c) => `<td style="border:1px solid #e2e8f0;padding:6px 8px;text-align:center;">${escapeHtml(c)}</td>`).join('')}</tr>`,
              )
              .join('') +
            `</table>`,
        );
      }
      if (b.summary) {
        parts.push(
          `<p style="margin:8px 0 20px;font-size:13px;line-height:1.7;color:#1e293b;white-space:pre-wrap;">${escapeHtml(b.summary)}</p>`,
        );
      }
    } else if (b.kind === 'criteria') {
      parts.push(
        `<p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#94a3b8;">${escapeHtml(b.text)}</p>`,
      );
    } else {
      const c = charts[chartIdx++];
      if (!c) continue;
      parts.push(
        `<div style="margin:12px 0 20px;">` +
          `<div style="font-size:13px;font-weight:600;color:#334155;margin-bottom:6px;">${escapeHtml(c.title)}</div>` +
          `<img src="data:${c.mime};base64,${c.base64}" width="${c.width}" height="${c.height}" ` +
          `style="display:block;width:100%;max-width:${c.width}px;height:auto;border:1px solid #e2e8f0;border-radius:8px;" />` +
          `</div>`,
      );
    }
  }
  parts.push(
    `<p style="margin:12px 0 0;font-size:12px;color:#64748b;">（以上为报告总览与分析结论；完整报告（含各章节明细与图表）请查看附件 Excel，PDF 版可于系统内导出）</p>` +
      `<p style="margin:4px 0 0;font-size:12px;color:#94a3b8;">本报告由器件验证数据分析系统生成</p>`,
  );
  return `<div style="font-family:${EMAIL_FONT_STACK};max-width:760px;">${parts.join('')}</div>`;
}

/* ================= 判定标准选择（只读，由系统设置维护） ================= */

function CriteriaSelectorCard() {
  const { thresholds, activeName, criteriaSets, setActiveCriteria } = useCriteria();
  const names = Object.keys(criteriaSets);

  /** 当前套的规则摘要（勾选项 + 阈值） */
  const ruleSummary = useMemo(() => {
    const parts: string[] = [];
    if (thresholds.championRule.enabled) parts.push(`PCE冠军 Δ≥${thresholds.championRule.threshold}`);
    if (thresholds.medianRule.enabled) parts.push(`PCE中位 Δ≥${thresholds.medianRule.threshold}`);
    if (thresholds.vocffRule.enabled) parts.push(`VOC*FF平均 Δ≥${thresholds.vocffRule.threshold}`);
    return parts.join(' 且 ');
  }, [thresholds]);

  return (
    <Card
      title="判定标准"
      extra={<span className="text-[11px] text-slate-400">选择后自动重算</span>}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {names.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setActiveCriteria(name)}
              className={`rounded-lg border px-4 py-1.5 text-sm font-medium transition-colors ${
                activeName === name
                  ? 'border-blue-500 bg-blue-50 text-blue-600 shadow-sm'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700'
              }`}
            >
              {name}
            </button>
          ))}
        </div>

        {/* 当前标准信息（只读） */}
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-4 py-3 text-xs leading-6 text-slate-500">
          <div className="mb-1 text-sm font-medium text-slate-700">
            当前使用：「{activeName || '（未选择）'}」
          </div>
          <p>
            有效测试记录 = 反扫 且 PCE≥{thresholds.pceMin}%、FF≥{thresholds.ffMin}
            {thresholds.resistanceMin > 0 ? `、Rs/Rsh>${thresholds.resistanceMin}Ω` : ''}；
          </p>
          <p>优秀判定：{ruleSummary || '（未启用任何规则）'}；不满足则判「不合格」。</p>
          <p className="mt-1 text-[11px] text-slate-400">
            判定标准由管理员在「系统设置」中增改删并云端共享，工程师在此仅可选择与查看。
          </p>
        </div>
      </div>
    </Card>
  );
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

  /** 一键发送邮件：生成 Excel 附件 → 自动下载 → 富文本正文（图表内嵌图片）复制到剪贴板 → 打开默认邮件客户端
   *  mailto 协议无法携带图片，正文图片通过剪贴板传递：在邮件正文中粘贴（Ctrl+V）即得带图富文本；
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
      // 生成 Excel（同时得到总览块与图表截图，供正文内嵌复用）并触发下载
      const { blob, charts, overview } = await exportReportExcelBlob(paperRef.current, meta, reportData, {
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

      // 正文：报告总览 + 分析结论（图表内嵌）以富文本写入剪贴板，粘贴到邮件客户端即带图
      const blocks = buildEmailBlocks(meta, reportData);
      const text = renderEmailText(blocks);
      /* 主题带日期与汇报人：器件分析报告(YYMMDD)-A vs B-汇报人（缺省段自动省略） */
      const dateDigits = (meta.report_date || '').replace(/\D/g, '');
      const dateTag = dateDigits.length >= 8 ? `(${dateDigits.slice(2, 8)})` : '';
      const reporterTag = meta.reporter?.trim() ? ` - ${meta.reporter.trim()}` : '';
      const subject = `器件分析报告${dateTag} - ${reportData.groups.map((g) => g.batchId).join(' vs ')}${reporterTag}`;
      let richCopied = false;
      if (charts.length > 0 || overview) {
        try {
          if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
            await navigator.clipboard.write([
              new ClipboardItem({
                'text/html': new Blob([renderEmailHtml(blocks, charts, overview)], { type: 'text/html' }),
                'text/plain': new Blob([text], { type: 'text/plain' }),
              }),
            ]);
            richCopied = true;
          }
        } catch {
          /* 剪贴板不可用（权限/非安全上下文）：回退 mailto 纯文本正文 */
        }
      }

      // 打开邮件客户端（正文为纯文本兜底；富文本版已在剪贴板，粘贴即覆盖为带图版本）
      const recipients = loadMailRecipients().join(',');
      const mailto = `mailto:${recipients}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
      window.open(mailto, '_blank');

      setProgress(
        richCopied
          ? '正文已复制（含图表图片）：在邮件正文中粘贴（Ctrl+V）即带图发送；Excel 已下载，请添加为附件'
          : 'Excel 已下载，请在邮件客户端中粘贴为附件',
      );
      setTimeout(() => {
        setProgress('');
        setEmailing(false);
      }, 5000);
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
        <p className="mt-2 text-[11px] text-slate-400">
          标签显示「有效 / 反扫总数」（符合口径反扫数 / 反扫总数）；判定标准可在下方选择，或由管理员在「系统设置」中调整
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

      {/* 判定标准选择（选择后数据自动重算、报告自动更新） */}
      <CriteriaSelectorCard />

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
            <span className="text-[10px] text-slate-400">
              {String(meta[f.key] || '').length} 字
            </span>
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