export type JsonRecord = Record<string, unknown>;

export interface Paper {
  id?: string;
  title_en: string;
  title_zh?: string;
  authors?: string[];
  author_affiliations?: string[];
  journal?: { name?: string; source_group?: string };
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
    domain?: string;
    subdomain?: string;
    tags?: string[];
  };
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
    };
    digest_title_template?: string;
  };
  ai?: {
    base_url?: string;
    model?: string;
    api_key_env?: string;
    translation?: {
      enabled?: boolean;
      model?: string;
      api_key_env?: string;
      required?: boolean;
    };
    enrich?: {
      enabled?: boolean;
      concurrency?: number;
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
    };
    prompts?: {
      classify_system?: string;
      classify_user_template?: string;
      translation_system?: string;
      translation_user_template?: string;
      filter_system?: string;
      filter_user_template?: string;
    };
  };
  sources?: {
    keywords?: string[];
    journals_file?: string;
    openalex_queries?: string[];
  };
  classification?: {
    file?: string;
  };
  feishu?: {
    execution_mode?: string;
    data_dir?: string;
    doc_title_prefix?: string;
    doc_enabled?: boolean;
    base_enabled?: boolean;
    notify_enabled?: boolean;
    notify_cmd?: string;
    alert_enabled?: boolean;
    alert_cmd?: string;
    alert_chat_id?: string;
    alert_user_id?: string;
    alert_message_template?: string;
    notify_chat_id?: string;
    notify_user_id?: string;
    notify_user_ids?: string[];
    notify_message_template?: string;
    doc_publish_cmd?: string;
    base_publish_cmd?: string;
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
