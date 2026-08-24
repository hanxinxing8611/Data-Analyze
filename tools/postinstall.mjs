#!/usr/bin/env node
/**
 * 跨平台 postinstall 入口（替代直接调用 powershell，Linux CI 上无该命令会失败）：
 * - CI / 非 Windows 环境：直接退出（公司文件系统加密过滤驱动仅存在于本机 Windows）
 * - 本机 Windows：调用 PowerShell 解密管道（与原 postinstall 行为完全一致）
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.CI || process.platform !== 'win32') {
  process.exit(0);
}

const result = spawnSync(
  'powershell',
  ['-ExecutionPolicy', 'Bypass', '-File', path.join('tools', 'decrypt-nm.ps1')],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 0);
