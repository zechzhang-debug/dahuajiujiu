# 大华舅舅背单词 - 云端部署版

这个目录已经是可部署版本：
- `index.html`：前端页面
- `words.txt`：词库配置文件（改它即可改页面数据）

## 你现在能做什么
- 直接部署整个目录到云端。
- 后续只要更新 `words.txt` 并重新部署（或在 Git 仓库里提交），前端就会自动加载新词库。
- 页面里还保留了“上传 TXT”按钮，方便临时替换。

## TXT 格式
每行一条，使用 `/` 分隔：

`单词/音标/词性/解释/例句`

示例：
`desire/dɪˈzaɪə(r)/n./渴望；欲望/She has a strong desire to succeed.`

## 推荐部署（Cloudflare Pages，免费，全球 CDN）
1. 把这个目录上传到 GitHub（新建仓库，例如 `word-web-cloud`）。
2. 打开 Cloudflare Dashboard -> Pages -> Create a project -> 连接 GitHub 仓库。
3. 构建设置：
   - Framework preset: `None`
   - Build command: 留空
   - Build output directory: `/` 或留空（静态站点）
4. 点 Deploy。
5. 部署完成后会得到 `https://xxxx.pages.dev`，任何人都可访问。

## 以后如何更新内容
1. 修改 `words.txt`。
2. 提交到 GitHub。
3. Cloudflare Pages 会自动重新部署。
4. 用户刷新页面即可看到新内容（页面已使用 `no-store` 请求配置，减少缓存影响）。

## 本地预览（不要直接双击 html）
为了让 `fetch('words.txt')` 生效，建议用本地静态服务器：

```bash
cd '/Users/xinhua/Documents/New project/word-web-cloud'
python3 -m http.server 8080
```

然后打开：`http://localhost:8080`

## 批量生成单词音频
项目根目录里有脚本：

[`generate_word_audio.py`](</Users/xinhua/Documents/New project/generate_word_audio.py>)

先安装依赖：

```bash
pip install openai
```

临时设置 OpenAI key 后运行：

```bash
cd '/Users/xinhua/Documents/New project'
export OPENAI_API_KEY='你的key'
python3 generate_word_audio.py --dry-run
python3 generate_word_audio.py
```

生成结果默认会放到：

- `word-web-cloud/audio/primary`
- `word-web-cloud/audio/junior`
- `word-web-cloud/audio/senior`

常用参数：

```bash
python3 generate_word_audio.py --levels primary junior --limit 20
python3 generate_word_audio.py --overwrite
python3 generate_word_audio.py --voice alloy --model gpt-4o-mini-tts
```
