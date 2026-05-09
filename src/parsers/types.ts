/**
 * 采集器类型定义
 * 所有采集器（Nature / OpenAlex）共享这些类型
 */

import type { JsonRecord } from "../types.js";

/** 从文章页面解析出的元数据 */
export interface ArticleMeta {
  authors: string[];
  affiliations: string[];
  imageUrl: string;
  abstract: string;
  publicationType: string;
}

/** 采集器输入配置 */
export interface JournalEntry {
  name: string;
  source_group: string;
  issn?: string;
  publisher_strategy?: string;
  rss_feeds?: string[];
}

/** filterBudget：LLM 二次过滤预算池，三个采集器共享 */
export interface FilterBudget {
  remaining: number;
}

/** 采集器标准输出 */
export interface ParsedPaper {
  title: string;
  authors: string[];
  authorAffiliations: string[];
  journal: string;
  sourceGroup: string;
  publishedDate: string;
  doi: string;
  url: string;
  abstractOriginal: string;
  imageUrl: string;
  publicationType: string;
  sourceProvider: string;
  rawFeed: string;
  rawRecordId: string;
  taxonomy: Array<Record<string, unknown>>;
}
