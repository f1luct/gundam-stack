export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket; // 图片存储（R2）
  IMAGES: KVNamespace; // 系统小键值（news 拉取节流时间戳等 sys: 键）
  ASSETS: Fetcher;
  APP_PASSWORD: string;
  SESSION_SECRET?: string;
  DEEPSEEK_API_KEY?: string;
  PUB_URL?: string; // N150 发布服务的隧道地址（wrangler.toml [vars]）
  PUB_TOKEN?: string; // 发布服务共享密钥（secret）
}

export interface Extracted {
  source_id: string;
  author_handle: string;
  author_name: string;
  text: string;
  lang?: string;
  image_urls: string[]; // 全分辨率 (?name=orig)
}
