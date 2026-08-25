# ============================================================
# 飞书邮箱 - 一键设为系统默认邮件程序（Windows）
# 用途：让「器件验证数据分析系统」的「发送邮件」按钮
#       直接打开飞书写信窗口（主题与正文自动填充）
# 适用：飞书桌面版已安装且邮箱功能可用
# 使用：右键点击此文件 →「使用 PowerShell 运行」
# ============================================================

$ErrorActionPreference = 'Stop'

# ---- 1. 定位飞书安装路径 ----
$feishuExe = Join-Path $env:LOCALAPPDATA 'Feishu\app\Feishu.exe'
if (-not (Test-Path $feishuExe)) {
    # 备选路径探测
    $alt = @(
        "$env:ProgramFiles\Feishu\Feishu.exe",
        "${env:ProgramFiles(x86)}\Feishu\Feishu.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($alt) { $feishuExe = $alt } else {
        Write-Host '[X] 未找到飞书，请先安装飞书桌面版并登录邮箱' -ForegroundColor Red
        Read-Host '按回车键退出'
        exit 1
    }
}
Write-Host "[1/4] 已找到飞书: $feishuExe" -ForegroundColor Green

# ---- 2. 备份并清除当前的 mailto 用户选择（若有） ----
$ucPath = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto\UserChoice'
if (Test-Path $ucPath) {
    $old = (Get-ItemProperty $ucPath).ProgId
    Write-Host "[2/4] 当前 mailto 关联: $old （如需恢复，记住此值）" -ForegroundColor Yellow
    Remove-Item $ucPath -Force
    Write-Host '       已清除旧的 mailto 用户选择'
} else {
    Write-Host '[2/4] 无旧 mailto 用户选择，跳过'
}

# ---- 3. 注册用户级 mailto 协议 → 飞书 ----
$cmd = "`"$feishuExe`" -- --open-url=`"%1`""
$base = 'HKCU:\Software\Classes\mailto'
New-Item $base -Force | Out-Null
Set-ItemProperty $base -Name '(default)' -Value 'URL:MailTo Protocol'
Set-ItemProperty $base -Name 'EditFlags' -Value 2 -Type DWord
New-ItemProperty $base -Name 'URL Protocol' -PropertyType String -Value '' -Force | Out-Null
New-Item "$base\shell\open\command" -Force | Out-Null
Set-ItemProperty "$base\shell\open\command" -Name '(default)' -Value $cmd
Write-Host "[3/4] 已注册 mailto 协议 → 飞书" -ForegroundColor Green

# ---- 4. 通知系统刷新关联缓存 ----
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ShellNotify { [DllImport("shell32.dll")] public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2); }'
[ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Host '[4/4] 系统关联缓存已刷新' -ForegroundColor Green

# ---- 验证 ----
Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ' 配置完成！正在打开测试邮件（飞书写信窗口）' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '若未自动弹出，请重启浏览器后再试。'
Write-Host '回退方法：删除注册表键 HKCU:\Software\Classes\mailto，'
Write-Host '          再到 系统设置 → 默认应用 → 电子邮箱 重新选择原程序。'
Write-Host ''
$go = Read-Host '现在打开测试邮件吗？(Y/n)'
if ($go -ne 'n') {
    Start-Process 'mailto:test@example.com?subject=%E5%85%B3%E8%81%94%E6%88%90%E5%8A%9F'
}
