# iplist 项目

## 项目简介

iplist 是一个基于 Node.js + Express 的 IP 采集与任务管理平台，支持多用户、API Key 管理、任务跳转、全局统计与日志、Web UI 管理等功能，适合用于安全分析、数据采集、渗透测试等场景。

## 主要功能

- 支持多用户任务管理与 IP 采集
- API Key 授权与余额管理
- 支持图片/跳转两种任务模式
- 全局限速与封禁机制
- 管理员 WebUI 后台与日志管理
- 丰富的 RESTful API，详见 [docs/api.md](docs/api.md)
- 自动重试的数据库操作，保证高可用
- 支持定时清理日志，防止日志膨胀

## 快速部署与运行

### 依赖环境

- Node.js >= 16.x
- npm >= 8.x
- sqlite3

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
npm run build   # 如有ts编译
npm start       # 或 node dist/main.js
```

### 本地开发

```bash
npm run dev
```

### 生产部署建议

- 支持 Docker、PM2、Render、Railway、Vercel、Netlify 等平台部署
- 推荐使用 [pm2](https://pm2.keymetrics.io/) 进行进程守护
- 可通过 Nginx/Apache 反向代理实现 HTTPS
- 日志与数据库文件建议挂载持久化目录

### 云平台部署参考

- Render/Netlify/Vercel 可直接部署静态前端和 Node.js 服务
- 参考 [Render官方文档](https://docs.render.com/deploy-to-render)
- 参考 [Netlify官方文档](https://answers.netlify.com/t/how-to-publish-readme-md/79699)

## 目录结构

``` json

iplist/
  db/           # 数据库相关代码
  docs/         # 项目文档与API说明
  logs/         # 日志文件
  utils/        # 工具函数
  webui/        # 前端页面
  config.json   # 配置文件
  main.ts       # 主服务入口
  package.json  # 依赖与脚本
  README.md     # 项目说明
```

## 主要API文档

详见 [docs/api.md](docs/api.md)

## 贡献与反馈

- 欢迎提交 issue 和 PR 参与项目共建
- 如有建议或问题可在 GitHub Issues 区留言

## License

MIT
