import { applyAllAgentConfigs } from '../lib';
import { revertAllAgentConfigs } from '../revert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { ERROR_PREFIX, DEFAULT_RULES_FILENAME } from '../constants';
import { McpStrategy, ModelsConfig, OutputScope } from '../types';
import { loadConfig } from '../core/ConfigLoader';
import { importToRuler } from '../import';

export interface ApplyCommonArgs {
  'project-root': string;
  config?: string;
  mcp: boolean;
  'mcp-overwrite': boolean;
  gitignore?: boolean;
  verbose: boolean;
  'dry-run': boolean;
  'local-only': boolean;
  nested?: boolean;
  backup: boolean;
  skills?: boolean;
  'output-scope': OutputScope;
}

export interface ApplyClaudeArgs extends ApplyCommonArgs {
  model?: string;
  'base-url'?: string;
  'auth-token'?: string;
  'api-key'?: string;
}

export interface ApplyCodexArgs extends ApplyCommonArgs {
  model?: string;
  'model-provider'?: string;
  'openai-api-key'?: string;
}

export interface ApplyOpenCodeArgs extends ApplyCommonArgs {
  model?: string;
  'small-model'?: string;
}

export interface ApplyGenericArgs extends ApplyCommonArgs {
  agent: string;
}

export interface InitArgs {
  'project-root': string;
  global: boolean;
}

export interface RevertArgs {
  'project-root': string;
  agents?: string;
  config?: string;
  'keep-backups': boolean;
  verbose: boolean;
  'dry-run': boolean;
  'local-only': boolean;
}

export interface ImportArgs {
  'project-root': string;
  agents?: string;
}

function assertNotInsideRulerDir(projectRoot: string): void {
  const normalized = path.resolve(projectRoot);
  const segments = normalized.split(path.sep);
  if (segments.includes('.ruler')) {
    console.error(
      `${ERROR_PREFIX} Cannot run from inside a .ruler directory. Please run from your project root.`,
    );
    process.exit(1);
  }
}

async function resolveNested(
  argv: ApplyCommonArgs,
  projectRoot: string,
  configPath: string | undefined,
): Promise<boolean> {
  if (argv.nested !== undefined) {
    return argv.nested;
  }

  try {
    const config = await loadConfig({
      projectRoot,
      configPath,
    });
    return config.nested ?? false;
  } catch {
    return false;
  }
}

async function applySingleAgent(
  agent: string,
  argv: ApplyCommonArgs,
  modelsOverride?: ModelsConfig,
): Promise<void> {
  const projectRoot = argv['project-root'];
  assertNotInsideRulerDir(projectRoot);

  const configPath = argv.config;
  const mcpEnabled = argv.mcp;
  const mcpStrategy: McpStrategy | undefined = argv['mcp-overwrite']
    ? 'overwrite'
    : undefined;
  const verbose = argv.verbose;
  const dryRun = argv['dry-run'];
  const localOnly = argv['local-only'];
  const backup = argv.backup;
  const outputScope = argv['output-scope'] ?? 'project';

  // Determine gitignore preference: CLI > TOML > Default (enabled)
  let gitignorePreference: boolean | undefined;
  if (argv.gitignore !== undefined) {
    gitignorePreference = argv.gitignore;
  } else {
    gitignorePreference = undefined;
  }

  const nested = await resolveNested(argv, projectRoot, configPath);
  if (nested && outputScope !== 'project') {
    throw new Error(
      'User-scope outputs are not supported with --nested yet (ambiguous precedence). Run without --nested or use --output-scope project.',
    );
  }

  // Determine skills preference: CLI > TOML > Default (enabled)
  const skillsEnabled = argv.skills !== undefined ? argv.skills : undefined;

  await applyAllAgentConfigs(
    projectRoot,
    [agent],
    configPath,
    mcpEnabled,
    mcpStrategy,
    gitignorePreference,
    verbose,
    dryRun,
    localOnly,
    nested,
    backup,
    skillsEnabled,
    outputScope,
    modelsOverride,
  );
}

export async function applyGenericHandler(
  argv: ApplyGenericArgs,
): Promise<void> {
  try {
    await applySingleAgent(argv.agent, argv);
    console.log('ruler-plus apply completed successfully.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${ERROR_PREFIX} ${message}`);
    process.exit(1);
  }
}

export async function applyClaudeHandler(argv: ApplyClaudeArgs): Promise<void> {
  try {
    const providerModels: Record<
      string,
      { display_name?: string; enabled?: boolean }
    > = {};
    if (argv.model) providerModels[argv.model] = { enabled: true };

    const modelsOverride: ModelsConfig = {
      providers:
        argv.model || argv['base-url'] || argv['auth-token'] || argv['api-key']
          ? {
              anthropic: {
                type: 'anthropic',
                base_url: argv['base-url'],
                api_key: argv['auth-token'] ?? argv['api-key'],
                models:
                  Object.keys(providerModels).length > 0
                    ? providerModels
                    : undefined,
              },
            }
          : undefined,
    };

    // Avoid overriding from CLI when no model-related flags are set.
    const hasOverride =
      !!argv.model ||
      !!argv['base-url'] ||
      !!argv['auth-token'] ||
      !!argv['api-key'];

    await applySingleAgent(
      'claude',
      argv,
      hasOverride ? modelsOverride : undefined,
    );
    console.log('ruler-plus apply completed successfully.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${ERROR_PREFIX} ${message}`);
    process.exit(1);
  }
}

export async function applyCodexHandler(argv: ApplyCodexArgs): Promise<void> {
  try {
    const providerName = argv['model-provider'] || 'openai';
    const providerModels: Record<
      string,
      { display_name?: string; enabled?: boolean }
    > = {};
    if (argv.model) providerModels[argv.model] = { enabled: true };

    const modelsOverride: ModelsConfig = {
      providers:
        !!argv.model || !!argv['model-provider'] || !!argv['openai-api-key']
          ? {
              [providerName]: {
                type: 'openai',
                api_key: argv['openai-api-key'],
                models:
                  Object.keys(providerModels).length > 0
                    ? providerModels
                    : undefined,
              },
            }
          : undefined,
    };
    const hasOverride =
      !!argv.model || !!argv['model-provider'] || !!argv['openai-api-key'];

    await applySingleAgent(
      'codex',
      argv,
      hasOverride ? modelsOverride : undefined,
    );
    console.log('ruler-plus apply completed successfully.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${ERROR_PREFIX} ${message}`);
    process.exit(1);
  }
}

export async function applyOpenCodeHandler(
  argv: ApplyOpenCodeArgs,
): Promise<void> {
  try {
    const nestedProviders: ModelsConfig['providers'] = {};
    if (argv.model && argv.model.includes('/')) {
      const [providerName, modelId] = argv.model.split('/', 2);
      nestedProviders[providerName] = {
        ...(nestedProviders[providerName] ?? {}),
        models: {
          ...((nestedProviders[providerName]?.models as Record<
            string,
            { display_name?: string; enabled?: boolean }
          >) ?? {}),
          [modelId]: { enabled: true },
        },
      };
    }
    if (argv['small-model'] && argv['small-model'].includes('/')) {
      const [providerName, modelId] = argv['small-model'].split('/', 2);
      nestedProviders[providerName] = {
        ...(nestedProviders[providerName] ?? {}),
        models: {
          ...((nestedProviders[providerName]?.models as Record<
            string,
            { display_name?: string; enabled?: boolean }
          >) ?? {}),
          [modelId]: { enabled: true },
        },
      };
    }

    const modelsOverride: ModelsConfig = {
      providers:
        Object.keys(nestedProviders).length > 0 ? nestedProviders : undefined,
    };
    const hasOverride = !!argv.model || !!argv['small-model'];

    await applySingleAgent(
      'opencode',
      argv,
      hasOverride ? modelsOverride : undefined,
    );
    console.log('ruler-plus apply completed successfully.');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${ERROR_PREFIX} ${message}`);
    process.exit(1);
  }
}

export async function importHandler(argv: ImportArgs): Promise<void> {
  try {
    const projectRoot = argv['project-root'];
    const agents = argv.agents
      ? argv.agents
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    // Only support the requested set for reverse generation.
    const allowed = new Set(['claude', 'codex', 'opencode']);
    const filtered = agents?.filter((a) => allowed.has(a)) as
      | ('claude' | 'codex' | 'opencode')[]
      | undefined;

    await importToRuler({ projectRoot, agents: filtered });
    console.log('Ruler import completed successfully.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${ERROR_PREFIX} ${msg}`);
    process.exit(1);
  }
}

/**
 * Handler for the 'init' command.
 */
export async function initHandler(argv: InitArgs): Promise<void> {
  const projectRoot = argv['project-root'];
  const isGlobal = argv['global'];

  const rulerDir = isGlobal
    ? path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        'ruler',
      )
    : path.join(projectRoot, '.ruler');
  await fs.mkdir(rulerDir, { recursive: true });
  const instructionsPath = path.join(rulerDir, DEFAULT_RULES_FILENAME); // .ruler/AGENTS.md
  const tomlPath = path.join(rulerDir, 'ruler.toml');
  const exists = async (p: string) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  };
  const DEFAULT_INSTRUCTIONS = `# AGENTS.md\n\nCentralised AI agent instructions. Add coding guidelines, style guides, and project context here.\n\nRuler concatenates all .md files in this directory (and subdirectories), starting with AGENTS.md (if present), then remaining files in sorted order.\n`;
  const DEFAULT_TOML = `# Ruler Configuration File
# See https://ai.intellectronica.net/ruler for documentation.

# To specify which agents are active by default when --agents is not used,
# uncomment and populate the following line. If omitted, all agents are active.
# default_agents = ["copilot", "claude"]

# Enable nested rule loading from nested .ruler directories
# When enabled, ruler will search for and process .ruler directories throughout the project hierarchy
# nested = false

# --- Agent Specific Configurations ---
# You can enable/disable agents and override their default output paths here.
# Use lowercase agent identifiers: aider, amp, claude, cline, codex, copilot, cursor, jetbrains-ai, kilocode, pi, windsurf

# [agents.copilot]
# enabled = true
# output_path = ".github/copilot-instructions.md"

# [agents.aider]
# enabled = true
# output_path_instructions = "AGENTS.md"
# output_path_config = ".aider.conf.yml"

# [agents.gemini-cli]
# enabled = true

# --- MCP Servers ---
# Define Model Context Protocol servers here. Two examples:
# 1. A stdio server (local executable)
# 2. A remote server (HTTP-based)

# [mcp_servers.example_stdio]
# command = "node"
# args = ["scripts/your-mcp-server.js"]
# env = { API_KEY = "replace_me" }

# [mcp_servers.example_remote]
# url = "https://api.example.com/mcp"
# headers = { Authorization = "Bearer REPLACE_ME" }
`;
  if (!(await exists(instructionsPath))) {
    // Create new AGENTS.md regardless of legacy presence.
    await fs.writeFile(instructionsPath, DEFAULT_INSTRUCTIONS);
    console.log(`[ruler] Created ${instructionsPath}`);
  } else {
    console.log(`[ruler] ${DEFAULT_RULES_FILENAME} already exists, skipping`);
  }
  if (!(await exists(tomlPath))) {
    await fs.writeFile(tomlPath, DEFAULT_TOML);
    console.log(`[ruler] Created ${tomlPath}`);
  } else {
    console.log(`[ruler] ruler.toml already exists, skipping`);
  }
}

/**
 * Handler for the 'revert' command.
 */
export async function revertHandler(argv: RevertArgs): Promise<void> {
  const projectRoot = argv['project-root'];
  assertNotInsideRulerDir(projectRoot);
  const agents = argv.agents
    ? argv.agents.split(',').map((a) => a.trim())
    : undefined;
  const configPath = argv.config;
  const keepBackups = argv['keep-backups'];
  const verbose = argv.verbose;
  const dryRun = argv['dry-run'];
  const localOnly = argv['local-only'];

  try {
    await revertAllAgentConfigs(
      projectRoot,
      agents,
      configPath,
      keepBackups,
      verbose,
      dryRun,
      localOnly,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${ERROR_PREFIX} ${message}`);
    process.exit(1);
  }
}
