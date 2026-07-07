-- 高达暂存站 数据库结构 (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS cards (
  id            TEXT PRIMARY KEY,
  source_type   TEXT NOT NULL DEFAULT 'twitter',   -- twitter | news | manual
  source_url    TEXT,                              -- 原始链接
  source_id     TEXT,                              -- 推文 id / 新闻 guid，用于去重
  author_handle TEXT,                              -- X @handle 或 新闻站点名
  author_name   TEXT,
  text_original TEXT,                              -- 原文（未翻译）
  text_final    TEXT,                              -- 用户编辑后的正文
  caption       TEXT,                              -- 最终配文：{正文}\n\nX: @{handle}
  lang          TEXT,                              -- 原文语言，决定是否提示翻译
  status        TEXT NOT NULL DEFAULT 'inbox',     -- inbox | queued | posted
  scheduled_at  INTEGER,                           -- 定时发送时间 (epoch ms)，NULL=不定时
  posted_at     INTEGER,                           -- 标记已发的时间 (epoch ms)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  meta_json     TEXT                               -- 各来源的额外数据 (JSON)，避免频繁改表
);

-- 同来源同 id 去重（manual 卡片 source_id 为 NULL，不参与唯一约束）
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_source
  ON cards(source_type, source_id) WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status, created_at);

CREATE TABLE IF NOT EXISTS card_images (
  id             TEXT PRIMARY KEY,
  card_id        TEXT NOT NULL,
  r2_key         TEXT NOT NULL,                    -- R2 对象 key
  source_img_url TEXT,                             -- 原始 pbs.twimg.com 链接 (?name=orig)
  width          INTEGER,
  height         INTEGER,
  ord            INTEGER NOT NULL DEFAULT 0,       -- 多图排序
  mime           TEXT,                             -- 存储时的真实 content-type
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_card_images_card ON card_images(card_id, ord);

-- 官网新闻"见过表"：拉取处理过的文章永久记录。
-- 删卡片不删这里 —— 删过的新闻下次拉取不会再进来。
CREATE TABLE IF NOT EXISTS news_seen (
  source_id TEXT PRIMARY KEY,
  seen_at   INTEGER NOT NULL
);

-- 把已入库的新闻卡片补录进见过表（幂等，重跑无害）
INSERT OR IGNORE INTO news_seen (source_id, seen_at)
  SELECT source_id, created_at FROM cards
  WHERE source_type = 'news' AND source_id IS NOT NULL;
