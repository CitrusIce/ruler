import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseTOML } from '@iarna/toml';
import { z } from 'zod';
import {
  McpConfig,
  GlobalMcpConfig,
  GitignoreConfig,
  SkillsConfig,
  ModelsConfig,
  CodexModelProviderConfig,
  OpenCodeProviderConfig,
} from '../types';
import { createRulerError } from '../constants';

interface ErrnoException extends Error {
  code?: string;
}

const mcpConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    merge_strategy: z.enum(['merge', 'overwrite']).optional(),
  })
  .optional();

const agentConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    output_path: z.string().optional(),
    output_path_instructions: z.string().optional(),
    output_path_config: z.string().optional(),
    mcp: mcpConfigSchema,
  })
  .optional();

const rulerConfigSchema = z.object({
  default_agents: z.array(z.string()).optional(),
  agents: z.record(z.string(), agentConfigSchema).optional(),
  mcp: z
    .object({
      enabled: z.boolean().optional(),
      merge_strategy: z.enum(['merge', 'overwrite']).optional(),
    })
    .optional(),
  gitignore: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  skills: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  models: z
    .object({
      claude: z
        .object({
          model: z.string().optional(),
          base_url: z.string().optional(),
          auth_env_key: z
            .enum(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'])
            .optional(),
          auth_value: z.string().optional(),
        })
        .optional(),
      codex: z
        .object({
          model_provider: z.string().optional(),
          model: z.string().optional(),
          openai_api_key: z.string().optional(),
          providers: z
            .record(
              z.string(),
              z
                .object({
                  name: z.string().optional(),
                  base_url: z.string().optional(),
                  wire_api: z.string().optional(),
                  requires_openai_auth: z.boolean().optional(),
                })
                .optional(),
            )
            .optional(),
        })
        .optional(),
      opencode: z
        .object({
          model: z.string().optional(),
          small_model: z.string().optional(),
          providers: z
            .record(
              z.string(),
              z
                .object({
                  npm: z.string().optional(),
                  name: z.string().optional(),
                  base_url: z.string().optional(),
                  api_key: z.string().optional(),
                  models: z.record(z.string(), z.string()).optional(),
                })
                .optional(),
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
  nested: z.boolean().optional(),
});

/**
 * Recursively creates a new object with only enumerable string keys,
 * effectively excluding Symbol properties.
 * The @iarna/toml parser adds Symbol properties (Symbol(type), Symbol(declared))
 * for metadata, which Zod v4+ validates and rejects as invalid record keys.
 * By rebuilding the object structure using Object.keys(), we create clean objects
 * that only contain the actual data without Symbol metadata.
 */
function stripSymbols(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(stripSymbols);
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = stripSymbols((obj as Record<string, unknown>)[key]);
  }
  return result;
}

/**
 * Configuration for a specific agent as defined in ruler.toml.
 */
export interface IAgentConfig {
  enabled?: boolean;
  outputPath?: string;
  outputPathInstructions?: string;
  outputPathConfig?: string;
  /** MCP propagation config for this agent. */
  mcp?: McpConfig;
}

/**
 * Parsed ruler configuration values.
 */
export interface LoadedConfig {
  /** Agents to run by default, as specified by default_agents. */
  defaultAgents?: string[];
  /** Per-agent configuration overrides. */
  agentConfigs: Record<string, IAgentConfig>;
  /** Command-line agent filters (--agents), if provided. */
  cliAgents?: string[];
  /** Global MCP servers configuration section. */
  mcp?: GlobalMcpConfig;
  /** Gitignore configuration section. */
  gitignore?: GitignoreConfig;
  /** Skills configuration section. */
  skills?: SkillsConfig;
  /** Model/provider configuration section. */
  models?: ModelsConfig;
  /** Whether to enable nested rule loading from nested .ruler directories. */
  nested?: boolean;
  /** Whether the nested option was explicitly provided in the config. */
  nestedDefined?: boolean;
}

/**
 * Options for loading the ruler configuration.
 */
export interface ConfigOptions {
  projectRoot: string;
  /** Path to a custom TOML config file. */
  configPath?: string;
  /** CLI filters from --agents option. */
  cliAgents?: string[];
}

/**
 * Loads and parses the ruler TOML configuration file, applying defaults.
 * If the file is missing or invalid, returns empty/default config.
 */
export async function loadConfig(
  options: ConfigOptions,
): Promise<LoadedConfig> {
  const { projectRoot, configPath, cliAgents } = options;
  let configFile: string;

  if (configPath) {
    configFile = path.resolve(configPath);
  } else {
    // Try local .ruler/ruler.toml first
    const localConfigFile = path.join(projectRoot, '.ruler', 'ruler.toml');
    try {
      await fs.access(localConfigFile);
      configFile = localConfigFile;
    } catch {
      // If local config doesn't exist, try global config
      const xdgConfigDir =
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      configFile = path.join(xdgConfigDir, 'ruler', 'ruler.toml');
    }
  }
  let raw: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(configFile, 'utf8');
    const parsed = text.trim() ? parseTOML(text) : {};
    // Strip Symbol properties added by @iarna/toml (required for Zod v4+)
    raw = stripSymbols(parsed) as Record<string, unknown>;

    // Validate the configuration with zod
    const validationResult = rulerConfigSchema.safeParse(raw);
    if (!validationResult.success) {
      throw createRulerError(
        'Invalid configuration file format',
        `File: ${configFile}, Errors: ${validationResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      );
    }
  } catch (err) {
    if (err instanceof Error && (err as ErrnoException).code !== 'ENOENT') {
      if (err.message.includes('[ruler]')) {
        throw err; // Re-throw validation errors
      }
      console.warn(
        `[ruler] Warning: could not read config file at ${configFile}: ${err.message}`,
      );
    }
    raw = {};
  }

  const defaultAgents = Array.isArray(raw.default_agents)
    ? raw.default_agents.map((a) => String(a))
    : undefined;

  const agentsSection =
    raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents)
      ? (raw.agents as Record<string, unknown>)
      : {};
  const agentConfigs: Record<string, IAgentConfig> = {};
  for (const [name, section] of Object.entries(agentsSection)) {
    if (section && typeof section === 'object') {
      const sectionObj = section as Record<string, unknown>;
      const cfg: IAgentConfig = {};
      if (typeof sectionObj.enabled === 'boolean') {
        cfg.enabled = sectionObj.enabled;
      }
      if (typeof sectionObj.output_path === 'string') {
        cfg.outputPath = path.resolve(projectRoot, sectionObj.output_path);
      }
      if (typeof sectionObj.output_path_instructions === 'string') {
        cfg.outputPathInstructions = path.resolve(
          projectRoot,
          sectionObj.output_path_instructions,
        );
      }
      if (typeof sectionObj.output_path_config === 'string') {
        cfg.outputPathConfig = path.resolve(
          projectRoot,
          sectionObj.output_path_config,
        );
      }
      if (sectionObj.mcp && typeof sectionObj.mcp === 'object') {
        const m = sectionObj.mcp as Record<string, unknown>;
        const mcpCfg: McpConfig = {};
        if (typeof m.enabled === 'boolean') {
          mcpCfg.enabled = m.enabled;
        }
        if (typeof m.merge_strategy === 'string') {
          const ms = m.merge_strategy;
          if (ms === 'merge' || ms === 'overwrite') {
            mcpCfg.strategy = ms;
          }
        }
        cfg.mcp = mcpCfg;
      }
      agentConfigs[name] = cfg;
    }
  }

  const rawMcpSection =
    raw.mcp && typeof raw.mcp === 'object' && !Array.isArray(raw.mcp)
      ? (raw.mcp as Record<string, unknown>)
      : {};
  const globalMcpConfig: GlobalMcpConfig = {};
  if (typeof rawMcpSection.enabled === 'boolean') {
    globalMcpConfig.enabled = rawMcpSection.enabled;
  }
  if (typeof rawMcpSection.merge_strategy === 'string') {
    const strat = rawMcpSection.merge_strategy;
    if (strat === 'merge' || strat === 'overwrite') {
      globalMcpConfig.strategy = strat;
    }
  }

  const rawGitignoreSection =
    raw.gitignore &&
    typeof raw.gitignore === 'object' &&
    !Array.isArray(raw.gitignore)
      ? (raw.gitignore as Record<string, unknown>)
      : {};
  const gitignoreConfig: GitignoreConfig = {};
  if (typeof rawGitignoreSection.enabled === 'boolean') {
    gitignoreConfig.enabled = rawGitignoreSection.enabled;
  }

  const rawSkillsSection =
    raw.skills && typeof raw.skills === 'object' && !Array.isArray(raw.skills)
      ? (raw.skills as Record<string, unknown>)
      : {};
  const skillsConfig: SkillsConfig = {};
  if (typeof rawSkillsSection.enabled === 'boolean') {
    skillsConfig.enabled = rawSkillsSection.enabled;
  }

  const nestedDefined = typeof raw.nested === 'boolean';
  const nested = nestedDefined ? (raw.nested as boolean) : false;

  const rawModelsSection =
    raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)
      ? (raw.models as Record<string, unknown>)
      : {};
  const modelsConfig: ModelsConfig = {};
  if (
    rawModelsSection.claude &&
    typeof rawModelsSection.claude === 'object' &&
    !Array.isArray(rawModelsSection.claude)
  ) {
    const c = rawModelsSection.claude as Record<string, unknown>;
    modelsConfig.claude = {
      model: typeof c.model === 'string' ? c.model : undefined,
      base_url: typeof c.base_url === 'string' ? c.base_url : undefined,
      auth_env_key:
        c.auth_env_key === 'ANTHROPIC_AUTH_TOKEN' ||
        c.auth_env_key === 'ANTHROPIC_API_KEY'
          ? c.auth_env_key
          : undefined,
      auth_value: typeof c.auth_value === 'string' ? c.auth_value : undefined,
    };
  }
  if (
    rawModelsSection.codex &&
    typeof rawModelsSection.codex === 'object' &&
    !Array.isArray(rawModelsSection.codex)
  ) {
    const c = rawModelsSection.codex as Record<string, unknown>;
    const providersRaw =
      c.providers &&
      typeof c.providers === 'object' &&
      !Array.isArray(c.providers)
        ? (c.providers as Record<string, unknown>)
        : {};
    const providers: Record<string, CodexModelProviderConfig> = {};
    for (const [name, def] of Object.entries(providersRaw)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
      const d = def as Record<string, unknown>;
      providers[name] = {
        name: typeof d.name === 'string' ? d.name : undefined,
        base_url: typeof d.base_url === 'string' ? d.base_url : undefined,
        wire_api: typeof d.wire_api === 'string' ? d.wire_api : undefined,
        requires_openai_auth:
          typeof d.requires_openai_auth === 'boolean'
            ? d.requires_openai_auth
            : undefined,
      };
    }
    modelsConfig.codex = {
      model_provider:
        typeof c.model_provider === 'string' ? c.model_provider : undefined,
      model: typeof c.model === 'string' ? c.model : undefined,
      providers: Object.keys(providers).length > 0 ? providers : undefined,
      openai_api_key:
        typeof c.openai_api_key === 'string' ? c.openai_api_key : undefined,
    };
  }
  if (
    rawModelsSection.opencode &&
    typeof rawModelsSection.opencode === 'object' &&
    !Array.isArray(rawModelsSection.opencode)
  ) {
    const c = rawModelsSection.opencode as Record<string, unknown>;
    const providersRaw =
      c.providers &&
      typeof c.providers === 'object' &&
      !Array.isArray(c.providers)
        ? (c.providers as Record<string, unknown>)
        : {};
    const providers: Record<string, OpenCodeProviderConfig> = {};
    for (const [name, def] of Object.entries(providersRaw)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
      const d = def as Record<string, unknown>;
      const modelsRaw =
        d.models && typeof d.models === 'object' && !Array.isArray(d.models)
          ? (d.models as Record<string, unknown>)
          : {};
      const modelMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(modelsRaw)) {
        if (typeof v === 'string') modelMap[k] = v;
      }
      providers[name] = {
        npm: typeof d.npm === 'string' ? d.npm : undefined,
        name: typeof d.name === 'string' ? d.name : undefined,
        base_url: typeof d.base_url === 'string' ? d.base_url : undefined,
        api_key: typeof d.api_key === 'string' ? d.api_key : undefined,
        models: Object.keys(modelMap).length > 0 ? modelMap : undefined,
      };
    }
    modelsConfig.opencode = {
      model: typeof c.model === 'string' ? c.model : undefined,
      small_model:
        typeof c.small_model === 'string' ? c.small_model : undefined,
      providers: Object.keys(providers).length > 0 ? providers : undefined,
    };
  }
  const models =
    Object.keys(modelsConfig).length > 0 ? modelsConfig : undefined;

  return {
    defaultAgents,
    agentConfigs,
    cliAgents,
    mcp: globalMcpConfig,
    gitignore: gitignoreConfig,
    skills: skillsConfig,
    models,
    nested,
    nestedDefined,
  };
}
