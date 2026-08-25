/* ================= 数据库实体 ================= */

/** 材料批次（material_batch 表） */
export interface MaterialBatch {
  id: number;
  batch_id: string; // 材料批次号（材料码），如 CB615W1
  material_type: string; // 材料码，与 batch_id 一致
  batch_number: number | null; // 旧结构遗留列，恒为 NULL（器件号在样品名中）
  description: string | null;
  created_at: string;
}

/** 样品测试记录（sample_record 表） */
export interface SampleRecord {
  id: number;
  batch_id: string;
  sample_name: string;
  is_reverse: number; // 1=反扫(_r_) 0=正扫
  mode: string | null;
  sample_type: string | null;
  area_cm2: number | null;
  intensity: number | null; // 光强 mW/cm²
  isc_mA: number | null;
  voc_V: number | null;
  jsc_mA_cm2: number | null;
  pm_mW: number | null;
  im_mA: number | null;
  vm_V: number | null;
  ff: number | null;
  efficiency: number | null; // 效率 η，百分数（源文件小数 × 100）
  rsh_ohm: number | null; // 并联电阻
  rs_ohm: number | null; // 串联电阻
  test_date: string | null;
  operator: string | null;
  source_file: string | null;
}

/* ================= 解析相关 ================= */

/** IV 曲线数据点 */
export interface IVCurvePoint {
  voltage_V: number;
  current_density_mA_cm2: number;
  power_density_mW_cm2: number;
}

/** TXT 解析出的单个样本块 */
export interface ParsedSample {
  header: Record<string, string>; // 原始参数头键值对
  dataPoints: IVCurvePoint[];
  sampleName: string;
  batchId: string; // 材料批次号（材料码），如 CB615W1
  materialType: string;
  deviceNumber: number | null; // 器件号（样品名 -N 后缀，全局编号）
  isReverse: boolean;
  sequence: number | null;
}

/** 从参数头提取的标准化测试参数 */
export interface ExtractedParams {
  area: number | null;
  intensity: number | null;
  isc: number | null;
  voc: number | null;
  jsc: number | null;
  pm: number | null;
  im: number | null;
  vm: number | null;
  ff: number | null;
  efficiency: number | null; // 已转为百分数
  rsh: number | null;
  rs: number | null;
}

/** 导入结果 */
export interface ImportResult {
  totalBlocks: number;
  imported: number;
  skipped: number;
  errors: string[];
  batches: string[];
}

/* ================= 统计相关 ================= */

/** 箱线图统计量（Tukey 法） */
export interface BoxplotStats {
  min: number;
  max: number;
  q1: number;
  median: number;
  q3: number;
  lowerWhisker: number;
  upperWhisker: number;
  outliers: number[];
  mean: number;
  count: number;
}

/** 批次统计摘要 */
export interface BatchSummary {
  batch_id: string;
  material_type: string;
  batch_number: number | null;
  sample_count: number;
  forward_count: number;
  reverse_count: number;
  avg_efficiency: number | null;
  max_efficiency: number | null;
  avg_voc: number | null;
  avg_jsc: number | null;
  avg_ff: number | null;
  last_test_date: string | null;
}

/** 样本筛选条件 */
export interface SampleFilter {
  batchId?: string;
  direction?: 'all' | 'forward' | 'reverse';
  search?: string;
}

/* ================= 排产计划 ================= */

/** 排产计划条目 */
export interface ScheduleItem {
  id: number;
  batch_id: string;
  material_type: string;
  engineer_name: string;
  engineer_email: string;
  start_date: string; // YYYY-MM-DD
  report_deadline: string; // YYYY-MM-DD（自动 = start_date 后第 2 个工作日）
  status: 'planned' | 'in_progress' | 'completed';
  notes: string | null;
  created_at: string;
}

/* ================= 报告相关（Phase 3） ================= */

/** 报告元数据（手工录入部分） */
export interface ReportMetadata {
  id: number;
  report_date: string;
  reporter: string;
  research_purpose: string | null;
  process_method: string | null;
  key_parameters: string | null;
  discussion: string | null;
  conclusion: string | null;
  next_steps: string | null;
  created_at?: string;
}

/** 报告文字录入表单（不含 id，文本字段均为非空字符串，空为 ''） */
export type ReportMetaInput = Omit<
  ReportMetadata,
  'id' | 'created_at' | 'research_purpose' | 'process_method' | 'key_parameters' | 'discussion' | 'conclusion' | 'next_steps'
> & {
  research_purpose: string;
  process_method: string;
  key_parameters: string;
  discussion: string;
  conclusion: string;
  next_steps: string;
};
