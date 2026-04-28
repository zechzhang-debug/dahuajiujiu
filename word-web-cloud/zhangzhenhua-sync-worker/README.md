# zhangzhenhua-sync-worker

为 `dahuajiujiu.com/zhangzhenhua` 提供跨设备日程同步 API。

## 1) 安装和登录

```bash
cd word-web-cloud/zhangzhenhua-sync-worker
npm i -D wrangler
npx wrangler login
```

## 2) 配置密钥（必填）

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put SYNC_PASSWORD
```

- `GITHUB_TOKEN`：需要对目标仓库有 contents 写权限
- `SYNC_PASSWORD`：前端同步密码（可与网页访问密码不同）

## 3) 配置普通变量

编辑 `wrangler.toml`，补充：

```toml
[vars]
GITHUB_REPO = "zechzhang-debug/dahuajiujiu"
GITHUB_BRANCH = "main"
GITHUB_PATH = "data/dahua-calendar-reminders.json"
```

## 4) 发布

```bash
npx wrangler deploy
```

部署后会得到 `https://<worker>.workers.dev`。

## 5) 前端接入

在网页里设置：
- `SYNC_API_BASE` 为你的 workers.dev 地址
- `SYNC_PASSWORD` 为你设置的密钥

页面会：
- 打开时拉取最新计划
- 点击“保存计划”时推送
- 每 5 分钟自动同步一次
