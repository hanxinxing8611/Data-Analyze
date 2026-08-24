import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../store/DataContext';
import { importSamples } from '../database/db';
import { extractParams, parseIVFile, readFileText } from '../parser/ivParser';
import { fmt } from '../utils/statistics';
import { Badge, Button, Card, PageHeader } from '../components/ui';
import Icon from '../components/layout/Icon';
import type { ImportResult, ParsedSample } from '../types';

export default function DataImport() {
  const { refresh } = useData();
  const inputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState('');
  const [samples, setSamples] = useState<ParsedSample[] | null>(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');

  /** 解析上传的 TXT 文件 */
  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setImportResult(null);
    setSamples(null);
    setParsing(true);
    try {
      const text = await readFileText(file);
      const parsed = parseIVFile(text);
      if (parsed.length === 0) {
        setError('未解析到有效数据，请确认文件为 IV 测试导出的 TXT 格式（应包含 #mode=IV 样本块）');
        return;
      }
      setFileName(file.name);
      setSamples(parsed);
    } catch (e) {
      setError(`文件解析失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setParsing(false);
    }
  };

  /** 确认导入数据库 */
  const handleImport = async () => {
    if (!samples) return;
    setImporting(true);
    try {
      const result = await importSamples(samples, fileName);
      setImportResult(result);
      refresh();
    } catch (e) {
      setError(`导入失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  };

  /** 重置，重新选择文件 */
  const handleReset = () => {
    setSamples(null);
    setFileName('');
    setImportResult(null);
    setError('');
    if (inputRef.current) inputRef.current.value = '';
  };

  /** 批次汇总预览 */
  const batchSummary = useMemo(() => {
    if (!samples) return [];
    const map = new Map<string, { total: number; forward: number; reverse: number }>();
    for (const s of samples) {
      const item = map.get(s.batchId) ?? { total: 0, forward: 0, reverse: 0 };
      item.total++;
      if (s.isReverse) item.reverse++;
      else item.forward++;
      map.set(s.batchId, item);
    }
    return [...map.entries()].map(([batchId, v]) => ({ batchId, ...v }));
  }, [samples]);

  /** 样本参数预览（前 8 条） */
  const previewRows = useMemo(() => {
    if (!samples) return [];
    return samples.slice(0, 8).map((s) => {
      const p = extractParams(s.header);
      return { name: s.sampleName, batch: s.batchId, reverse: s.isReverse, params: p, points: s.dataPoints.length };
    });
  }, [samples]);

  return (
    <div>
      <PageHeader
        title="数据导入"
        description="上传 IV 测试导出的 TXT 源文件，自动解析样本参数、识别材料批次并写入数据库"
      />

      {/* 上传区 */}
      {!samples && !importResult && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFile(e.dataTransfer.files[0]);
          }}
          className={`group cursor-pointer rounded-2xl border-2 border-dashed bg-white px-8 py-16 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] transition-all duration-200 ${
            dragOver
              ? 'scale-[1.01] border-blue-500 bg-blue-50/50 shadow-[0_0_0_4px_rgba(37,99,235,0.10)]'
              : 'border-slate-300 hover:border-blue-400'
          }`}
          onClick={(e) => {
            // 按钮自身会打开对话框，避免冒泡导致双次触发
            if ((e.target as HTMLElement).closest('button')) return;
            if (!parsing) inputRef.current?.click();
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".txt"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <div
            className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl transition-all duration-200 ${
              dragOver
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30'
                : 'bg-blue-50 text-blue-600 group-hover:bg-blue-100'
            }`}
          >
            <Icon name="upload" className="h-7 w-7" />
          </div>
          <p className="text-sm font-medium text-slate-700">
            {parsing ? '正在解析文件…' : '拖拽 TXT 文件到此处，或点击选择文件'}
          </p>
          <p className="mt-1.5 text-xs text-slate-400">
            支持设备导出的 IV 测试数据（自动识别 UTF-8 / GBK 编码），单文件可包含多个样本块
          </p>
          <div className="mt-6">
            <Button onClick={() => inputRef.current?.click()} disabled={parsing}>
              {parsing ? '解析中…' : '选择文件'}
            </Button>
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-4">
          <Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
          <div className="text-sm text-red-700">{error}</div>
        </div>
      )}

      {/* 解析预览 */}
      {samples && !importResult && (
        <div className="space-y-6">
          <Card
            title={`解析结果 — ${fileName}`}
            extra={
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={handleReset}>
                  重新选择
                </Button>
                <Button onClick={handleImport} disabled={importing}>
                  {importing ? '导入中…' : `导入 ${samples.length} 条样本`}
                </Button>
              </div>
            }
            bodyClassName="px-0 py-0"
          >
            {/* 批次汇总 */}
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="mb-3 text-xs font-medium text-slate-500">
                共识别 {samples.length} 个样本块，{batchSummary.length} 个材料批次：
              </div>
              <div className="flex flex-wrap gap-2">
                {batchSummary.map((b) => (
                  <span
                    key={b.batchId}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs"
                  >
                    <span className="font-mono font-medium text-slate-800">{b.batchId}</span>
                    <span className="text-slate-500">
                      {b.total} 样本（正扫 {b.forward} / 反扫 {b.reverse}）
                    </span>
                  </span>
                ))}
              </div>
            </div>

            {/* 样本参数预览表 */}
            <div className="overflow-x-auto">
              <table className="data-table w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <th>样本名称</th>
                    <th>批次</th>
                    <th>方向</th>
                    <th>Voc (V)</th>
                    <th>Jsc (mA/cm²)</th>
                    <th>FF</th>
                    <th>η (%)</th>
                    <th>Rsh (Ω)</th>
                    <th>数据点</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {previewRows.map((row) => (
                    <tr key={row.name}>
                      <td className="font-mono font-medium text-slate-900">{row.name}</td>
                      <td className="font-mono">{row.batch}</td>
                      <td>
                        <Badge tone={row.reverse ? 'blue' : 'slate'}>
                          {row.reverse ? '反扫' : '正扫'}
                        </Badge>
                      </td>
                      <td className="font-mono">{fmt(row.params.voc)}</td>
                      <td className="font-mono">{fmt(row.params.jsc)}</td>
                      <td className="font-mono">{fmt(row.params.ff)}</td>
                      <td className="font-mono">{fmt(row.params.efficiency)}</td>
                      <td className="font-mono">{fmt(row.params.rsh)}</td>
                      <td className="font-mono text-slate-500">{row.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {samples.length > 8 && (
              <div className="border-t border-slate-100 px-5 py-2.5 text-center text-xs text-slate-400">
                仅预览前 8 条，导入后将写入全部 {samples.length} 条
              </div>
            )}
          </Card>
        </div>
      )}

      {/* 导入结果 */}
      {importResult && (
        <Card>
          <div className="flex flex-col items-center py-8 text-center">
            <div
              className={`mb-4 flex h-14 w-14 items-center justify-center rounded-full ${
                importResult.errors.length === 0
                  ? 'bg-emerald-50 text-emerald-600'
                  : 'bg-amber-50 text-amber-600'
              }`}
            >
              <Icon name={importResult.errors.length === 0 ? 'check' : 'alert'} className="h-7 w-7" />
            </div>
            <h3 className="text-base font-semibold text-slate-900">
              {importResult.errors.length === 0 ? '导入完成' : '导入完成（部分失败）'}
            </h3>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-sm text-slate-600">
              <span>
                共解析 <b className="font-mono">{importResult.totalBlocks}</b> 块
              </span>
              <span className="text-slate-300">|</span>
              <span>
                新增 <b className="font-mono text-emerald-600">{importResult.imported}</b> 条
              </span>
              <span className="text-slate-300">|</span>
              <span>
                跳过（重复）<b className="font-mono text-slate-500">{importResult.skipped}</b> 条
              </span>
              {importResult.errors.length > 0 && (
                <>
                  <span className="text-slate-300">|</span>
                  <span>
                    失败 <b className="font-mono text-red-600">{importResult.errors.length}</b> 条
                  </span>
                </>
              )}
            </div>
            {importResult.batches.length > 0 && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {importResult.batches.map((b) => (
                  <Badge key={b} tone="blue">
                    {b}
                  </Badge>
                ))}
              </div>
            )}
            {importResult.errors.length > 0 && (
              <div className="mt-4 max-h-32 w-full max-w-lg overflow-auto rounded-lg bg-red-50 p-3 text-left text-xs text-red-600">
                {importResult.errors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </div>
            )}
            <div className="mt-6 flex items-center gap-3">
              <Button variant="secondary" onClick={handleReset}>
                继续导入其他文件
              </Button>
              <Link to="/comparison">
                <Button>前往对比分析</Button>
              </Link>
              <Link to="/browser">
                <Button variant="secondary">查看数据</Button>
              </Link>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
