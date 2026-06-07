export type JsonRecord = Record<string, unknown>;

export interface Paper {
  id?: string;
  title_en: string;
  title_zh?: string;
  authors?: string[];
  author_affiliations?: string[];
  /** 作者→单位映射：author_affil_map[i] = [affiliation_index, ...] */
  author_affil_map?: number[][];
  journal?: { name?: string; source_group?: string; sort_order?: number };
  published_date?: string;
  doi?: string;
  url?: string;
  image_url?: string;
  abstract_original?: string;
  abstract_zh?: string;
  publication_type?: string;
  translation_error?: string;
  summary_zh?: string;
  novelty_points?: string[];
  main_content?: string[];
  classification?: {
    groups?: { group: string; subtopics: string[] }[];
    tags?: string[];
    domain?: string;
    subdomain?: string;
  };
  source?: { provider?: string; raw_feed?: string; raw_record_id?: string };
  [key: string]: unknown;
}

export interface PublishPayload {
  title: string;
  markdown: string;
  records: JsonRecord[];
  papers: Paper[];
}

export interface RuntimeConfig {
  mode: "run-once" | "daemon";
  state_dir: string;
  logs_dir: string;
  temp_dir: string;
  command_timeout_ms: number;
  retry: {
    max_attempts: number;
    backoff_ms: number;
  };
}

export interface AppConfig {
  app?: {
    title?: string;
    timezone?: string;
  };
  pipeline?: {
    default_days?: number;
    schedule?: {
      hour?: number;
      minute?: number;
      check_every_hours?: number;
    };
    paper_window?: {
      mode?: string;
      hour?: number;
      minute?: number;
      timezone?: string;
      grace_days?: number;
    };
    digest_title_template?: string;
  };
  ai?: {
    base_url?: string;
    model?: string;
    api_key_env?: string;
    http_timeout_ms?: number;
    translation?: {
      enabled?: boolean;
      model?: string;
      api_key_env?: string;
      required?: boolean;
    };
    enrich?: {
      enabled?: boolean;
      concurrency?: number;
      classify_batch_size?: number;
    };
    temperature?: number;
    max_tokens?: number;
    filter?: {
      enabled?: boolean;
      mode?: string;
      model?: string;
      temperature?: number;
      max_tokens?: number;
      min_confidence?: number;
      max_checks_per_run?: number;
      batch_size?: number;
      concurrency?: number;
    };
    prompts?: {
      classify_system?: string;
      classify_user_template?: string;
      translation_system?: string;
      translation_user_template?: string;
      filter_system?: string;
      filter_user_template?: string;
      filter_translate_system?: string;
      filter_translate_user_template?: string;
    };
  };
  sources?: {
    journals_file?: string;
  };
  classification?: {
    file?: string;
  };
  rss?: {
    enabled?: boolean;
    site_url?: string;
    title?: string;
    description?: string;
    language?: string;
    max_items?: number;
  };
  email?: {
    enabled?: boolean;
    provider?: string;
    smtp_host?: string;
    smtp_port?: number;
    smtp_secure?: boolean;
    user_env?: string;
    pass_env?: string;
    from?: string;
    to_env?: string;
    subject_template?: string;
  };
  runtime: RuntimeConfig;
}

export interface RunState {
  last_run_key: string;
  last_success_at: string;
  last_error: string;
  last_duration_ms: number;
}

export interface MetricsState {
  total_runs: number;
  success_runs: number;
  failed_runs: number;
  avg_duration_ms: number;
  last_error: string;
  updated_at: string;
}

export interface ProfileContext {
  profile: string;
  config: AppConfig;
  outputDir: string;
  dateStr: string;
}

export interface StepResult {
  step: string;
  inputCount: number;
  outputCount: number;
  inputFile: string;
  outputFile: string;
  durationMs: number;
  error?: string;
}

export interface RunMeta {
  profile: string;
  date: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  steps: StepResult[];
  error?: string;
}
