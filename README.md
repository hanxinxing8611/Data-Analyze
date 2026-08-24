# Data Analyze（器件验证数据分析系统）

钙钛矿器件验证对比分析工具：导入器件 IV 测试 TXT 数据（GBK 编码），
自动完成批次统计、Baseline 差值对比、质量判定，并生成 PDF / Excel 分析报告。
纯前端应用（React + Vite + sql.js），无后端、无数据上传。

## 在线使用

部署地址（GitHub Pages）：`https://<用户名>.github.io/Data-Analyze/`

- **首次使用**：「数据管理」页上传测试 TXT 文件，或「数据存储 → 数据库备份」导入同事分享的备份 xlsx
- **数据存储**：全部数据以 SQLite 格式存于当前浏览器的 IndexedDB，本地运行、不上传；
  清除浏览器站点数据会删除已导入的数据，请定期「导出备份」
- **共享协同**：「数据存储 → 数据库备份 → 拉取共享数据」可一键拉取维护者发布的权威数据集
  （发布方式见 `public/shared/README.md`）
- **云端共享设置**：统计口径与默认收件人支持团队共享——打开页面自动拉取
  `shared/settings.json`（全员生效，无需配置）；管理员在「系统设置」（需管理员密码登录）
  的「云端共享设置」配置 GitHub Fine-grained PAT 后，保存设置即自动推送云端，
  其他工程师下次打开页面即生效。无 PAT 时保存仅本机生效
- **报告导出**：「报告生成」页选择批次与基准后导出，自动命名为
  `YYMMDD.汇报人-批次号vs批次号-器件分析报告.pdf/xlsx`

## 统计口径

- 有效测试记录 = 反扫 且 满足阈值（默认 PCE≥15%、FF≥0.5、Rs/Rsh>0Ω，可在系统设置调整）
- 「有效 X/Y」= 符合统计口径的反扫测试数 / 反扫测试总数
- 冠军 / 中位 / 最优 / 箱线图 / Baseline Δ 全部基于有效测试记录
- 优秀判定默认：冠军 Δ>0 且 中位 Δ>0（相对基准批次）

## 本地开发

```bash
npm install        # postinstall 在 Windows 本机自动处理 node_modules 解密
npm run dev        # 开发服务器（地址带 /Data-Analyze/ 前缀）
npm run build      # 构建门禁：类型检查 + 193 项数据断言 + 打包
```

注意：`npm run build` 中的数据断言依赖 `data/input.txt`（真实数据，已按保密策略排除在仓库外），
克隆仓库后请自备数据文件放入 `data/` 目录。

## 部署

推送到 main 分支后，GitHub Actions 自动构建并发布到 GitHub Pages（`.github/workflows/deploy.yml`）。
CI 仅做类型检查与打包；数据断言保留在本地构建门禁中执行。
