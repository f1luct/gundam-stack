# 高达暂存站 (gundam-stack)

把白天在手机上刷到的 X / Twitter 高达图,一键攒进来;晚上在电脑上无脑复制图、复制文案,粘进微博网页版,用微博自带的「定时发布(小秒表)」发出去。

**这个 app 不碰微博 API、不自动发微博**,它只是一个「待发内容暂存队列」。

## 它能做什么 (v1)

- 贴一个推文链接 → 自动抓取**原图 + 原文 + 作者 @id**,生成配文:
  ```
  <原文 / 译文>

  X: @<作者id>
  ```
- 一键**复制图片到剪贴板**(去微博 Ctrl+V 直接粘贴)、一键**复制文案**
- 一键**翻译**(日/英 → 中文,DeepSeek V4 Flash,可选 直译/意译/微博口语风,译文只是可编辑预填)
- 三个状态流转:**收件箱 → 待发 → 已发**,可编辑、删除
- 密码登录,手机/电脑都能用

## 技术栈

Cloudflare Workers + Hono + D1(SQLite)+ R2(图片) + 纯静态前端,全部在免费额度内。

抓取走 `fxtwitter → vxtwitter → syndication` 三级兜底。图片抓回后原样存 R2,**复制时在前端转 PNG**(同源图片 canvas 不会被污染,所以服务端不需要图像库)。

---

## 部署步骤

> 需要一个 Cloudflare 账号(免费)。下面命令在项目目录里跑。

### 1. 装依赖
```bash
npm install
```

### 2. 登录 Cloudflare
```bash
npx wrangler login
```
> 这一步会打开浏览器授权。如果在当前会话里,可用 `! npx wrangler login`。

### 3. 创建 D1 数据库 + R2 桶
```bash
npx wrangler d1 create gundam-stack
npx wrangler r2 bucket create gundam-stack-images
```
把 `d1 create` 输出里的 `database_id` 填进 `wrangler.toml` 的 `database_id`。

### 4. 建表
```bash
# 远程(生产)库
npx wrangler d1 execute gundam-stack --remote --file=./schema.sql
# 本地开发库
npx wrangler d1 execute gundam-stack --local --file=./schema.sql
```

### 5. 设置机密
```bash
npx wrangler secret put APP_PASSWORD        # 登录密码
npx wrangler secret put DEEPSEEK_API_KEY    # 翻译用,从 platform.deepseek.com 拿
# 可选:
npx wrangler secret put SESSION_SECRET      # 随机长串
```

### 6. 部署
```bash
npm run deploy
```
部署完会给一个 `https://gundam-stack.<你的子域>.workers.dev` 地址,手机电脑都能开。

---

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填好密码和 key
npm run db:local                 # 建本地表(只需一次)
npm run dev                      # http://localhost:8787
```

---

## 后续路线 (已设计好,未实现)

- **v2**:手机「分享到 app」快捷入口(PWA/iOS 快捷指令)、图片定期清理、数据备份
- **v3**:每天自动抓 gundam.info 新闻进同一个收件箱(Cron + SourceAdapter,**不用改表**)

数据模型已为多来源(`source_type` = twitter / news / manual)预留,新增来源零改表。

## 注意

- 微博网页版「定时发布」是**会员功能**;粘贴图片时微博只认**剪贴板里的图像数据**(本 app 正是这么做的),不认「复制的图片文件」。
- 抓取依赖的 fxtwitter / vxtwitter 是第三方公益镜像,可能限流或失效,已做三级兜底;私密/已删除推文会抓取失败并提示。
