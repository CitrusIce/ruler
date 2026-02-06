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
  claude?: ClaudeModelsConfig;
  codex?: CodexModelsConfig;
  opencode?: OpenCodeModelsConfig;
}

export interface ClaudeModelsConfig {
  /** Claude Code model name (e.g. claude-sonnet-4-5-...). */
  model?: string;
  /** Anthropic compatible base URL. */
  base_url?: string;
  /** Which env key should be written into Claude settings. */
  auth_env_key?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  /** API key/token value or placeholder (e.g. {env:...} or {secret:...}). */
  auth_value?: string;
}

export interface CodexModelsConfig {
  /** Codex CLI model_provider value. */
  model_provider?: string;
  /** Codex CLI model value. */
  model?: string;
  /** Codex CLI provider blocks (model_providers.<name>.*). */
  providers?: Record<string, CodexModelProviderConfig>;
  /** OpenAI API key for Codex auth.json (or placeholder). */
  openai_api_key?: string;
}

export interface CodexModelProviderConfig {
  name?: string;
  base_url?: string;
  wire_api?: string;
  requires_openai_auth?: boolean;
}

export interface OpenCodeModelsConfig {
  /** OpenCode model in provider/model form (e.g. anthropic/claude-2). */
  model?: string;
  /** Optional small model for lightweight tasks. */
  small_model?: string;
  /** Provider fragments for OpenCode (opencode.jsonc provider.*). */
  providers?: Record<string, OpenCodeProviderConfig>;
}

export interface OpenCodeProviderConfig {
  npm?: string;
  name?: string;
  base_url?: string;
  api_key?: string;
  /** Model id -> display name. */
  models?: Record<string, string>;
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
