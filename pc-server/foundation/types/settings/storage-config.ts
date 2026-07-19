import type { WebDavConfig, S3Config } from "..";

export interface StorageConfig {
  webDavConfig: WebDavConfig;
  s3Config: S3Config;
}
