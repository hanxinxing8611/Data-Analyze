import type { ExtractedParams, IVCurvePoint, ParsedSample } from '../types';

/**
 * 解析 IV 测试导出的 TXT 文件
 *
 * 文件由多个样本块组成，每块以 "#mode=IV" 开始，结构：
 *   #mode=IV
 *   #sample type=bat
 *   #sample name=CB615W1-1_9
 *   #Area(cm2)=...
 *   ...（若干数值参数头，其中 η / Ω 键名可能因编码出现乱码）
 *   #data
 *   Voltage(V)	J(mA/cm2)	Voltage(V)	P(mW/cm2)
 *   -0.2	25.76	-0.2	-5.15
 *   ...（Tab 分隔的曲线数据行）
 */
export function parseIVFile(content: string): ParsedSample[] {
  // 统一换行符后按 "#mode=IV" 分块
  const normalized = content.replace(/\r\n/g, '\n');
  const blocks = normalized.split('#mode=IV').filter((b) => b.trim().length > 0);

  const samples: ParsedSample[] = [];
  for (const block of blocks) {
    const sample = parseBlock(block);
    if (sample) samples.push(sample);
  }
  return samples;
}

/** 解析单个样本块 */
function parseBlock(block: string): ParsedSample | null {
  const header: Record<string, string> = {};
  const dataPoints: IVCurvePoint[] = [];
  const lines = block.split('\n');
  let inData = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      // 参数头: #key=value
      const match = line.match(/^#([^=]+)=(.*)$/);
      if (match) {
        header[match[1].trim()] = match[2].trim();
      }
    } else if (inData) {
      // 数据行: Voltage  J  Voltage  P（Tab 分隔）
      const parts = line.split(/\t+/).map(Number);
      if (parts.length >= 4 && parts.slice(0, 4).every((n) => !isNaN(n))) {
        dataPoints.push({
          voltage_V: parts[0],
          current_density_mA_cm2: parts[1],
          power_density_mW_cm2: parts[3],
        });
      }
    } else if (line.includes('Voltage(V)')) {
      // 曲线表头行，其后为数据行
      inData = true;
    }
  }

  const sampleName = header['sample name'];
  if (!sampleName || dataPoints.length === 0) return null;

  const { materialType, deviceNumber, isReverse, sequence } = parseSampleName(sampleName);

  return {
    header,
    dataPoints,
    sampleName,
    // 批次 = 材料批次（材料码，如 CB615W1）；器件号（-N）保留在样品名中用于区分器件
    batchId: materialType,
    materialType,
    deviceNumber,
    isReverse,
    sequence,
  };
}

/**
 * 解析样本名称，识别材料批次 / 器件号 / 扫描方向 / 序号
 *
 * 命名规则：{材料批次}-{器件号}_{序号}，反扫在序号前加 r_ 前缀
 * 材料批次 = 材料码（如 CB615W1），器件号为其下器件的全局编号（如 -1 ~ -4）
 *
 * 示例：
 *   CB615W1-1_9     → 批次=CB615W1  器件=1  正扫  seq=9
 *   CB615W1-1_r_10  → 批次=CB615W1  器件=1  反扫  seq=10
 *   YAN-13_157      → 批次=YAN      器件=13 正扫  seq=157
 */
export function parseSampleName(name: string): {
  materialType: string;
  deviceNumber: number | null;
  isReverse: boolean;
  sequence: number | null;
} {
  const underscoreIdx = name.indexOf('_');
  const base = underscoreIdx > 0 ? name.slice(0, underscoreIdx) : name;
  const rest = underscoreIdx > 0 ? name.slice(underscoreIdx + 1) : '';

  // "_r_" 前缀代表反扫（reverse scan）
  const isReverse = /^r(_|$)/i.test(rest);

  // 尾部数字为序号
  const seqMatch = rest.match(/(\d+)$/);
  const sequence = seqMatch ? parseInt(seqMatch[1], 10) : null;

  // "材料批次-器件号" 结构（器件号为该批次器件的全局编号）
  const dashMatch = base.match(/^(.+)-(\d+)$/);
  if (dashMatch) {
    return {
      materialType: dashMatch[1],
      deviceNumber: parseInt(dashMatch[2], 10),
      isReverse,
      sequence,
    };
  }

  return { materialType: base, deviceNumber: null, isReverse, sequence };
}

/** 已知的标准参数键名 */
const KNOWN_KEYS = new Set([
  'mode',
  'sample type',
  'sample name',
  'Area(cm2)',
  'Intensity(mW/cm2)',
  'Isc(mA)',
  'Voc(V)',
  'Jsc(mA/cm2)',
  'Pm(mW)',
  'Im(mA)',
  'Vm(V)',
  'FF',
]);

/**
 * 从参数头提取标准化测试参数
 *
 * 兼容编码问题：源文件常为 GBK 编码，"η"、"Ω" 等字符在解码异常时
 * 键名会变成乱码，因此 Rsh / Rs / η 按前缀与排除法识别。
 */
export function extractParams(header: Record<string, string>): ExtractedParams {
  const num = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  // Rsh 前缀匹配；Rs 需排除 Rsh（"Rsh" 同样以 "Rs" 开头）
  const rshKey = Object.keys(header).find((k) => k.startsWith('Rsh'));
  const rsKey = Object.keys(header).find((k) => k.startsWith('Rs') && !k.startsWith('Rsh'));

  // η 键：非已知键、非 Rsh/Rs 的剩余数值键（正常解码时键名即 "η"）
  const etaKey = Object.keys(header).find(
    (k) => !KNOWN_KEYS.has(k) && k !== rshKey && k !== rsKey,
  );

  const eta = num(etaKey !== undefined ? header[etaKey] : undefined);

  return {
    area: num(header['Area(cm2)']),
    intensity: num(header['Intensity(mW/cm2)']),
    isc: num(header['Isc(mA)']),
    voc: num(header['Voc(V)']),
    jsc: num(header['Jsc(mA/cm2)']),
    pm: num(header['Pm(mW)']),
    im: num(header['Im(mA)']),
    vm: num(header['Vm(V)']),
    ff: num(header['FF']),
    // 源文件中 η 为小数（如 0.061 = 6.1%），入库统一转为百分数
    efficiency: eta !== null ? eta * 100 : null,
    rsh: num(rshKey !== undefined ? header[rshKey] : undefined),
    rs: num(rsKey !== undefined ? header[rsKey] : undefined),
  };
}

/**
 * 读取文件文本内容，自动识别编码
 * 优先按 UTF-8 严格解码，失败（测试设备常导出 GBK/ANSI）则回退 GBK
 */
export async function readFileText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gbk').decode(buffer);
  }
}
