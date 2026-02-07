/**
 * Types for Model Context Protocol (MCP) server configuration.
 */
export type McpStrategy = 'merge' | 'overwrite';

/** Where generated outputs should be written. */
export type OutputScope = 'project' | 'user' | 'both';

/** MCP configuration for an agent or global. */
export interface McpConfig {
  /** Enable or disable MCP propagation (merge or overwrite). */
  enabled?: boolean;
  /** Merge strategy: 'merge' to merge servers, 'overwrite' to replace config. */
  strategy?: McpStrategy;
}

/** Global MCP configuration section (same as agent-specific config). */
export type GlobalMcpConfig = McpConfig;

/** Gitignore configuration for automatic .gitignore file updates. */
export interface GitignoreConfig {
  /** Enable or disable automatic .gitignore updates. */
  enabled?: boolean;
}

/** Skills configuration for automatic skills distribution. */
export interface SkillsConfig {
  /** Enable or disable skills support. */
  enabled?: boolean;
}

/**
 * Model/provider configuration used to configure agent LLM settings.
 *
 * NOTE: Secrets (API keys/tokens) may be stored separately (e.g. in
 * `.ruler/secrets.toml`) to avoid accidental commits.
 */
export interface ModelsConfig {
  /** Unified providers map: providers.<provider>.models.<model_id>. */
  providers?: Record<string, UnifiedProviderConfig>;
}

export type ProviderType = 'anthropic' | 'google' | 'openai';

export interface UnifiedProviderConfig {
  type?: ProviderType;
  base_url?: string;
  api_key?: string;
  models?: Record<string, UnifiedModelConfig>;
}

export interface UnifiedModelConfig {
  display_name?: string;
  enabled?: boolean;
}

/** Information about a discovered skill. */
export interface SkillInfo {
  /** Name of the skill (directory name). */
  name: string;
  /** Absolute path to the skill directory. */
  path: string;
  /** Whether the directory contains a SKILL.md file. */
  hasSkillMd: boolean;
  /** Whether this is a valid skill. */
  valid: boolean;
  /** Error message if invalid. */
  error?: string;
}
