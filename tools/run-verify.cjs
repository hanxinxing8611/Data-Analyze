/**
 * 报告验证运行器：npm run verify [-- <TXT 数据文件路径>]
 *
 * 流程：esbuild 打包 tools/verify-report.ts → Node 运行 → 清理临时 bundle。
 * jspdf 需标记为 external，运行时 require 真实模块对象（验证脚本内会对其构造函数打补丁）。
 * 数据文件默认为项目上级目录的 0725-0724-晏广元.txt，也可通过参数或 VERIFY_TXT 环境变量指定。
 */
const { build } = require('esbuild');
const { spawnSync } = require('node:child_process');
const { rmSync } = require('node:fs');
const { join } = require('node:path');

const outfile = join(__dirname, '.verify-report.cjs');

async function main() {
  // 1. 打包
  try {
    await build({
      entryPoints: [join(__dirname, 'verify-report.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['jspdf'],
      outfile,
      logLevel: 'warning',
    });
  } catch (e) {
    console.error('打包失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  }

  // 2. 运行（透传参数，如 TXT 数据文件路径）
  const res = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });

  // 3. 清理临时 bundle
  rmSync(outfile, { force: true });

  if (res.error) {
    console.error('运行失败：', res.error.message);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

main();
