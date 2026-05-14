# 教材下载器

部署到 `dahuajiujiu.com/download` 的教材批量下载工具。

## 设计

- 输入国家中小学智慧教育平台教材详情页链接。
- 自动识别标题和学科。
- 优先尝试原始 PDF。
- 原始 PDF 不可直接下载时，使用页面图在浏览器端重建 PDF。
- 最终生成一个 zip，内部按学科目录整理。
- 因智慧教育平台接口有浏览器跨域限制，线上版本需要同时部署 `functions/api/download/proxy.js`。

## 本地预览

```bash
cd "/Users/xinhua/Documents/New project/word-web-cloud"
./zhangzhenhua-sync-worker/node_modules/.bin/wrangler pages dev . --port 8788 --compatibility-date=2026-05-03
```

打开：

```text
http://127.0.0.1:8788/download/
```

## 部署

同内容已复制到：

```text
/Users/xinhua/Documents/New project/word-web-cloud/download/index.html
/Users/xinhua/Documents/New project/word-web-cloud/functions/api/download/proxy.js
```

网站发布后访问：

```text
https://dahuajiujiu.com/download
```
