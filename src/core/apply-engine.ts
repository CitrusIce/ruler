import * as path from 'path';
import { promises as fs } from 'fs';
import * as os from 'os';
import { parse as parseTOML, stringify } from '@iarna/toml';
import * as FileSystemUtils from './FileSystemUtils';
import { concatenateRules } from './RuleProcessor';
import { loadConfig, LoadedConfig, IAgentConfig } from './ConfigLoader';
import { updateGitignore as updateGitignoreUtil } from './GitignoreUtils';
import { IAgent } from '../agents/IAgent';
import { mergeMcp } from '../mcp/merge';
import { getNativeMcpPath, readNativeMcp, writeNativeMcp } from '../paths/mcp';
import { propagateMcpToOpenHands } from '../mcp/propagateOpenHandsMcp';
import { propagateMcpToOpenCode } from '../mcp/propagateOpenCodeMcp';
import { getAgentOutputPaths } from '../agents/agent-utils';
import { agentSupportsMcp, filterMcpConfigForAgent } from '../mcp/capabilities';
import {
  createRulerError,
  logVerbose,
  logVerboseInfo,
  logInfo,
  logWarn,
} from '../constants';
import { McpStrategy, OutputScope } from '../types';
import {
  resolvePlaceholderString,
  getUserClaudeSettingsPath,
  getUserCodexAuthPath,
} from './placeholders';

/**
 * Configuration data loaded from the ruler setup
 */
export interface RulerConfiguration {
  config: LoadedConfig;
  concatenatedRules: string;
  rulerMcpJson: Record<string, unknown> | null;
}

/**
 * Configuration data for a specific .ruler directory in hierarchical mode
 */
export interface HierarchicalRulerConfiguration extends RulerConfiguration {
  rulerDir: string;
}

export /**
 * Loads configurations for all .ruler directories in hierarchical mode.
 * Each .ruler directory gets its own independent configuration with separate rules.
 * @param projectRoot Root directory of the project
 * @param configPath Optional custom config path
 * @param localOnly Whether to search only locally for .ruler directories
 * @returns Promise resolving to array of hierarchical configurations
 */
async function loadNestedConfigurations(
  projectRoot: string,
  configPath: string | undefined,
  localOnly: boolean,
  resolvedNested: boolean,
): Promise<HierarchicalRulerConfiguration[]> {
  const { dirs: rulerDirs } = await findRulerDirectories(
    projectRoot,
    localOnly,
    true,
  );

  const results: HierarchicalRulerConfiguration[] = [];
  const rulerDirConfigs = await processIndependentRulerDirs(rulerDirs);

  for (const { rulerDir, files } of rulerDirConfigs) {
    const config = await loadConfigForRulerDir(
      rulerDir,
      configPath,
      resolvedNested,
    );
    results.push(
      await createHierarchicalConfiguration(
        rulerDir,
        files,
        config,
        configPath,
      ),
    );
  }

  return results;
}

/**
 * Processes each .ruler directory independently, returning configuration for each.
 * Each .ruler directory gets its own rules (not merged with others).
 */
async function processIndependentRulerDirs(
  rulerDirs: string[],
): Promise<
  Array<{ rulerDir: string; files: { path: string; content: string }[] }>
> {
  const results: Array<{
    rulerDir: string;
    files: { path: string; content: string }[];
  }> = [];

  // Process each .ruler directory independently
  for (const rulerDir of rulerDirs) {
    const files = await FileSystemUtils.readMarkdownFiles(rulerDir);
    results.push({ rulerDir, files });
  }

  return results;
}

async function createHierarchicalConfiguration(
  rulerDir: string,
  files: { path: string; content: string }[],
  config: LoadedConfig,
  cliConfigPath: string | undefined,
): Promise<HierarchicalRulerConfiguration> {
  await warnAboutLegacyMcpJson(rulerDir);

  const concatenatedRules = concatenateRules(files, path.dirname(rulerDir));

  const directoryRoot = path.dirname(rulerDir);
  const localConfigPath = path.join(rulerDir, 'ruler.toml');
  let configPathToUse = cliConfigPath;
  try {
    await fs.access(localConfigPath);
    configPathToUse = localConfigPath;
  } catch {
    // fall back to CLI config or default resolution
  }

  const { loadUnifiedConfig } = await import('./UnifiedConfigLoader');
  const unifiedConfig = await loadUnifiedConfig({
    projectRoot: directoryRoot,
    configPath: configPathToUse,
  });

  let rulerMcpJson: Record<string, unknown> | null = null;
  if (unifiedConfig.mcp && Object.keys(unifiedConfig.mcp.servers).length > 0) {
    rulerMcpJson = {
      mcpServers: unifiedConfig.mcp.servers,
    };
  }

  return {
    rulerDir,
    config,
    concatenatedRules,
    rulerMcpJson,
  };
}

async function loadConfigForRulerDir(
  rulerDir: string,
  cliConfigPath: string | undefined,
  resolvedNested: boolean,
): Promise<LoadedConfig> {
  const directoryRoot = path.dirname(rulerDir);
  const localConfigPath = path.join(rulerDir, 'ruler.toml');

  let hasLocalConfig = false;
  try {
    await fs.access(localConfigPath);
    hasLocalConfig = true;
  } catch {
    hasLocalConfig = false;
  }

  const loaded = await loadConfig({
    projectRoot: directoryRoot,
    configPath: hasLocalConfig ? localConfigPath : cliConfigPath,
  });

  const cloned = cloneLoadedConfig(loaded);

  if (resolvedNested) {
    if (hasLocalConfig && loaded.nestedDefined && loaded.nested === false) {
      logWarn(
        `Nested mode is enabled but ${localConfigPath} sets nested = false. Continuing with nested processing.`,
      );
    }
    cloned.nested = true;
    cloned.nestedDefined = true;
  }

  return cloned;
}

function cloneLoadedConfig(config: LoadedConfig): LoadedConfig {
  const clonedAgentConfigs: Record<string, IAgentConfig> = {};
  for (const [agent, agentConfig] of Object.entries(config.agentConfigs)) {
    clonedAgentConfigs[agent] = {
      ...agentConfig,
      mcp: agentConfig.mcp ? { ...agentConfig.mcp } : undefined,
    };
  }

  return {
    defaultAgents: config.defaultAgents ? [...config.defaultAgents] : undefined,
    agentConfigs: clonedAgentConfigs,
    cliAgents: config.cliAgents ? [...config.cliAgents] : undefined,
    mcp: config.mcp ? { ...config.mcp } : undefined,
    gitignore: config.gitignore ? { ...config.gitignore } : undefined,
    nested: config.nested,
    nestedDefined: config.nestedDefined,
  };
}

/**
 * Finds ruler directories based on the specified mode.
 */
async function findRulerDirectories(
  projectRoot: string,
  localOnly: boolean,
  hierarchical: boolean,
): Promise<{ dirs: string[]; primaryDir: string }> {
  if (hierarchical) {
    const dirs = await FileSystemUtils.findAllRulerDirs(projectRoot);
    const allDirs = [...dirs];

    // Add global config if not local-only
    if (!localOnly) {
      const globalDir = await FileSystemUtils.findGlobalRulerDir();
      if (globalDir) {
        allDirs.push(globalDir);
      }
    }

    if (allDirs.length === 0) {
      throw createRulerError(
        `.ruler directory not found`,
        `Searched from: ${projectRoot}`,
      );
    }
    return { dirs: allDirs, primaryDir: allDirs[0] };
  } else {
    const dir = await FileSystemUtils.findRulerDir(projectRoot, !localOnly);
    if (!dir) {
      throw createRulerError(
        `.ruler directory not found`,
        `Searched from: ${projectRoot}`,
      );
    }
    return { dirs: [dir], primaryDir: dir };
  }
}

/**
 * Warns about legacy mcp.json files if they exist.
 */
async function warnAboutLegacyMcpJson(rulerDir: string): Promise<void> {
  try {
    const legacyMcpPath = path.join(rulerDir, 'mcp.json');
    await fs.access(legacyMcpPath);
    logWarn(
      'Warning: Using legacy .ruler/mcp.json. Please migrate to ruler.toml. This fallback will be removed in a future release.',
    );
  } catch {
    // ignore
  }
}

/**
 * Loads configuration for single-directory mode (existing behavior).
 */
export /**
 * Loads configuration for a single .ruler directory.
 * All rules from the directory are concatenated into a single configuration.
 * @param projectRoot Root directory of the project
 * @param configPath Optional custom config path
 * @param localOnly Whether to search only locally for .ruler directory
 * @returns Promise resolving to the loaded configuration
 */
async function loadSingleConfiguration(
  projectRoot: string,
  configPath: string | undefined,
  localOnly: boolean,
): Promise<RulerConfiguration> {
  // Find the single ruler directory
  const { dirs: rulerDirs, primaryDir } = await findRulerDirectories(
    projectRoot,
    localOnly,
    false, // single mode
  );

  // Warn about legacy mcp.json
  await warnAboutLegacyMcpJson(primaryDir);

  // Load the ruler.toml configuration
  const config = await loadConfig({
    projectRoot,
    configPath,
  });

  // Read rule files
  const files = await FileSystemUtils.readMarkdownFiles(rulerDirs[0]);

  // Concatenate rules
  const concatenatedRules = concatenateRules(files, path.dirname(primaryDir));

  // Load unified config to get merged MCP configuration
  const { loadUnifiedConfig } = await import('./UnifiedConfigLoader');
  const unifiedConfig = await loadUnifiedConfig({ projectRoot, configPath });

  // Synthesize rulerMcpJson from unified MCP bundle for backward compatibility
  let rulerMcpJson: Record<string, unknown> | null = null;
  if (unifiedConfig.mcp && Object.keys(unifiedConfig.mcp.servers).length > 0) {
    rulerMcpJson = {
      mcpServers: unifiedConfig.mcp.servers,
    };
  }

  return {
    config,
    concatenatedRules,
    rulerMcpJson,
  };
}

/**
 * Processes hierarchical configurations by applying rules to each .ruler directory independently.
 * Each directory gets its own set of rules and generates its own agent files.
 * @param agents Array of agents to process
 * @param configurations Array of hierarchical configurations for each .ruler directory
 * @param verbose Whether to enable verbose logging
 * @param dryRun Whether to perform a dry run
 * @param cliMcpEnabled Whether MCP is enabled via CLI
 * @param cliMcpStrategy MCP strategy from CLI
 * @returns Promise resolving to array of generated file paths
 */
export async function processHierarchicalConfigurations(
  agents: IAgent[],
  configurations: HierarchicalRulerConfiguration[],
  verbose: boolean,
  dryRun: boolean,
  cliMcpEnabled: boolean,
  cliMcpStrategy?: McpStrategy,
  outputScope: OutputScope = 'project',
  backup = true,
): Promise<string[]> {
  const allGeneratedPaths: string[] = [];

  for (const config of configurations) {
    logVerboseInfo(
      `Processing .ruler directory: ${config.rulerDir}`,
      verbose,
      dryRun,
    );
    const rulerRoot = path.dirname(config.rulerDir);
    const paths = await applyConfigurationsToAgents(
      agents,
      config.concatenatedRules,
      config.rulerMcpJson,
      config.config,
      rulerRoot,
      verbose,
      dryRun,
      cliMcpEnabled,
      cliMcpStrategy,
      outputScope,
      backup,
    );
    const normalizedPaths = paths.map((p) =>
      path.isAbsolute(p) ? p : path.join(rulerRoot, p),
    );
    allGeneratedPaths.push(...normalizedPaths);
  }

  return allGeneratedPaths;
}

/**
 * Processes a single configuration by applying rules to all selected agents.
 * All rules are concatenated and applied to generate agent files in the project root.
 * @param agents Array of agents to process
 * @param configuration Single ruler configuration with concatenated rules
 * @param projectRoot Root directory of the project
 * @param verbose Whether to enable verbose logging
 * @param dryRun Whether to perform a dry run
 * @param cliMcpEnabled Whether MCP is enabled via CLI
 * @param cliMcpStrategy MCP strategy from CLI
 * @returns Promise resolving to array of generated file paths
 */
export async function processSingleConfiguration(
  agents: IAgent[],
  configuration: RulerConfiguration,
  projectRoot: string,
  verbose: boolean,
  dryRun: boolean,
  cliMcpEnabled: boolean,
  cliMcpStrategy?: McpStrategy,
  outputScope: OutputScope = 'project',
  backup = true,
): Promise<string[]> {
  return await applyConfigurationsToAgents(
    agents,
    configuration.concatenatedRules,
    configuration.rulerMcpJson,
    configuration.config,
    projectRoot,
    verbose,
    dryRun,
    cliMcpEnabled,
    cliMcpStrategy,
    outputScope,
    backup,
  );
}

/**
 * Applies configurations to the selected agents (internal function).
 * @param agents Array of agents to process
 * @param concatenatedRules Concatenated rule content
 * @param rulerMcpJson MCP configuration JSON
 * @param config Loaded configuration
 * @param projectRoot Root directory of the project
 * @param verbose Whether to enable verbose logging
 * @param dryRun Whether to perform a dry run
 * @returns Promise resolving to array of generated file paths
 */
export async function applyConfigurationsToAgents(
  agents: IAgent[],
  concatenatedRules: string,
  rulerMcpJson: Record<string, unknown> | null,
  config: LoadedConfig,
  projectRoot: string,
  verbose: boolean,
  dryRun: boolean,
  cliMcpEnabled = true,
  cliMcpStrategy?: McpStrategy,
  outputScope: OutputScope = 'project',
  backup = true,
): Promise<string[]> {
  const generatedPaths: string[] = [];
  let agentsMdWritten = false;

  const writeProjectOutputs =
    outputScope === 'project' || outputScope === 'both';
  const writeUserOutputs = outputScope === 'user' || outputScope === 'both';

  // If model config is present, ensure secrets.toml is ignored in projects.
  if (writeProjectOutputs && config.models) {
    generatedPaths.push(path.join(projectRoot, '.ruler', 'secrets.toml'));
  }

  for (const agent of agents) {
    logInfo(`Applying rules for ${agent.getName()}...`, dryRun);
    logVerbose(`Processing agent: ${agent.getName()}`, verbose);
    const agentConfig = config.agentConfigs[agent.getIdentifier()];
    const agentRulerMcpJson = rulerMcpJson;

    // Collect output paths for .gitignore only when writing to the project.
    const outputPaths = writeProjectOutputs
      ? getAgentOutputPaths(agent, projectRoot, agentConfig)
      : [];
    if (writeProjectOutputs) {
      logVerbose(
        `Agent ${agent.getName()} output paths: ${outputPaths.join(', ')}`,
        verbose,
      );
      generatedPaths.push(...outputPaths);

      // Only add the backup file paths to the gitignore list if backups are enabled
      if (backup) {
        const backupPaths = outputPaths.map((p) => `${p}.bak`);
        generatedPaths.push(...backupPaths);
      }
    }

    if (dryRun) {
      logVerbose(
        writeProjectOutputs
          ? `DRY RUN: Would write rules to: ${outputPaths.join(', ')}`
          : `DRY RUN: Skipping project rule files due to output scope: ${outputScope}`,
        verbose,
      );
    } else {
      let skipApplyForThisAgent = false;
      if (
        agent.getIdentifier() === 'jules' ||
        agent.getIdentifier() === 'agentsmd'
      ) {
        if (agentsMdWritten) {
          // Skip rewriting AGENTS.md, but still allow MCP handling below
          skipApplyForThisAgent = true;
        } else {
          agentsMdWritten = true;
        }
      }
      let finalAgentConfig = agentConfig;
      if (agent.getIdentifier() === 'augmentcode' && agentRulerMcpJson) {
        const resolvedStrategy =
          cliMcpStrategy ??
          agentConfig?.mcp?.strategy ??
          config.mcp?.strategy ??
          'merge';

        finalAgentConfig = {
          ...agentConfig,
          mcp: {
            ...agentConfig?.mcp,
            strategy: resolvedStrategy,
          },
        };
      }

      if (!skipApplyForThisAgent && writeProjectOutputs) {
        await agent.applyRulerConfig(
          concatenatedRules,
          projectRoot,
          agentRulerMcpJson,
          finalAgentConfig,
          backup,
        );
      }

      // Optional user-scope rules for Claude Code.
      if (writeUserOutputs && agent.getIdentifier() === 'claude') {
        const userClaudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
        await agent.applyRulerConfig(
          concatenatedRules,
          projectRoot,
          null,
          { ...finalAgentConfig, outputPath: userClaudeMd },
          backup,
        );
      }
    }

    // Handle MCP configuration
    await handleMcpConfiguration(
      agent,
      agentConfig,
      config,
      agentRulerMcpJson,
      projectRoot,
      generatedPaths,
      verbose,
      dryRun,
      cliMcpEnabled,
      cliMcpStrategy,
      outputScope,
      backup,
    );

    await handleModelConfiguration(
      agent,
      config,
      projectRoot,
      outputScope,
      verbose,
      dryRun,
      backup,
    );
  }

  return generatedPaths;
}

async function handleModelConfiguration(
  agent: IAgent,
  config: LoadedConfig,
  projectRoot: string,
  outputScope: OutputScope,
  verbose: boolean,
  dryRun: boolean,
  backup: boolean,
): Promise<void> {
  const models = config.models;
  if (!models) return;

  const unifiedProviders = models.providers ?? {};
  const getFirstProviderByType = (
    type: 'anthropic' | 'google' | 'openai',
  ): {
    name: string;
    cfg: NonNullable<(typeof unifiedProviders)[string]>;
  } | null => {
    for (const [name, cfg] of Object.entries(unifiedProviders)) {
      if (cfg?.type === type) return { name, cfg };
    }
    return null;
  };
  const getFirstEnabledModelId = (providerName: string): string | undefined => {
    const provider = unifiedProviders[providerName];
    const modelMap = provider?.models;
    if (!modelMap) return undefined;
    for (const [id, def] of Object.entries(modelMap)) {
      if ((def?.enabled ?? true) !== false) return id;
    }
    return undefined;
  };

  const allowUserWrites = outputScope === 'user' || outputScope === 'both';
  const allowProjectWrites =
    outputScope === 'project' || outputScope === 'both';

  // Claude Code model settings are user-scoped.
  if (agent.getIdentifier() === 'claude') {
    if (!allowUserWrites) return;

    const anthropicProvider = getFirstProviderByType('anthropic');
    const claudeModel = anthropicProvider
      ? getFirstEnabledModelId(anthropicProvider.name)
      : undefined;
    const claudeBaseUrl = anthropicProvider?.cfg.base_url;
    const claudeAuthValue = anthropicProvider?.cfg.api_key;
    const claudeAuthEnvKey = claudeAuthValue
      ? 'ANTHROPIC_AUTH_TOKEN'
      : undefined;

    if (!claudeModel && !claudeBaseUrl && !claudeAuthValue) return;

    const settingsPath = getUserClaudeSettingsPath();
    if (dryRun) {
      logVerbose(
        `DRY RUN: Would apply Claude model settings to: ${settingsPath}`,
        verbose,
      );
      return;
    }

    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      existing = {};
    }

    const next = { ...existing } as Record<string, unknown>;
    if (claudeModel) next.model = claudeModel;

    const env =
      next.env && typeof next.env === 'object' && !Array.isArray(next.env)
        ? ({ ...(next.env as Record<string, unknown>) } as Record<
            string,
            unknown
          >)
        : {};
    if (claudeBaseUrl) {
      env.ANTHROPIC_BASE_URL = claudeBaseUrl;
    }
    if (claudeAuthEnvKey && claudeAuthValue) {
      const resolved = await resolvePlaceholderString(
        claudeAuthValue,
        projectRoot,
      );
      if (resolved) {
        env[claudeAuthEnvKey] = resolved;
      } else {
        logWarn(
          `Skipping Claude auth token update: could not resolve ${claudeAuthValue}`,
          dryRun,
        );
      }
    }
    if (Object.keys(env).length > 0) next.env = env;

    const currentContent = JSON.stringify(existing, null, 2);
    const newContent = JSON.stringify(next, null, 2);
    if (currentContent !== newContent) {
      if (backup) {
        const { backupFile } = await import('../core/FileSystemUtils');
        await backupFile(settingsPath);
      }
      await FileSystemUtils.writeGeneratedFile(settingsPath, newContent + '\n');
    }
    return;
  }

  if (agent.getIdentifier() === 'codex') {
    const openaiProvider = getFirstProviderByType('openai');
    const codexProviderName = openaiProvider?.name ?? 'openai';
    const codexModel = getFirstEnabledModelId(codexProviderName);
    const codexApiKey =
      unifiedProviders[codexProviderName]?.api_key ??
      openaiProvider?.cfg.api_key;

    const codexProviders = Object.fromEntries(
      Object.entries(unifiedProviders)
        .filter(([, providerCfg]) => providerCfg?.type === 'openai')
        .map(([name, providerCfg]) => [
          name,
          {
            name,
            base_url: providerCfg.base_url,
          },
        ]),
    );

    if (!codexModel && !codexApiKey && Object.keys(codexProviders).length === 0)
      return;

    // model_provider/model can be project- or user-scoped, but Codex auth.json is user-scoped.
    if (allowProjectWrites) {
      const configPath = path.join(projectRoot, '.codex', 'config.toml');
      if (dryRun) {
        logVerbose(
          `DRY RUN: Would apply Codex model settings to: ${configPath}`,
          verbose,
        );
      } else {
        let existingToml: Record<string, unknown> = {};
        try {
          const raw = await fs.readFile(configPath, 'utf8');
          existingToml = parseTOML(raw) as Record<string, unknown>;
        } catch {
          existingToml = {};
        }

        const next = { ...existingToml } as Record<string, unknown>;
        if (codexProviderName) next.model_provider = codexProviderName;
        if (codexModel) next.model = codexModel;
        if (Object.keys(codexProviders).length > 0) {
          const existingModelProviders =
            next.model_providers &&
            typeof next.model_providers === 'object' &&
            !Array.isArray(next.model_providers)
              ? (next.model_providers as Record<string, unknown>)
              : {};
          next.model_providers = {
            ...existingModelProviders,
            ...codexProviders,
          };
        }

        const currentContent = stringify(existingToml);
        const newContent = stringify(next as Record<string, unknown>);
        if (currentContent !== newContent) {
          if (backup) {
            const { backupFile } = await import('../core/FileSystemUtils');
            await backupFile(configPath);
          }
          await FileSystemUtils.writeGeneratedFile(configPath, newContent);
        }
      }
    }

    if (allowUserWrites && codexApiKey) {
      const authPath = getUserCodexAuthPath();
      if (dryRun) {
        logVerbose(`DRY RUN: Would apply Codex auth to: ${authPath}`, verbose);
      } else {
        const resolved = await resolvePlaceholderString(
          codexApiKey,
          projectRoot,
        );
        if (!resolved) {
          logWarn(
            `Skipping Codex OPENAI_API_KEY update: could not resolve ${codexApiKey}`,
            dryRun,
          );
          return;
        }
        let existingAuth: Record<string, unknown> = {};
        try {
          const raw = await fs.readFile(authPath, 'utf8');
          existingAuth = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          existingAuth = {};
        }
        const next = { ...existingAuth, OPENAI_API_KEY: resolved };
        const currentContent = JSON.stringify(existingAuth, null, 2);
        const newContent = JSON.stringify(next, null, 2);
        if (currentContent !== newContent) {
          if (backup) {
            const { backupFile } = await import('../core/FileSystemUtils');
            await backupFile(authPath);
          }
          await FileSystemUtils.writeGeneratedFile(authPath, newContent + '\n');
        }
      }
    }
  }

  if (agent.getIdentifier() === 'opencode') {
    const opencodeModel = (() => {
      for (const [providerName, providerCfg] of Object.entries(
        unifiedProviders,
      )) {
        const modelId = getFirstEnabledModelId(providerName);
        if (modelId) return `${providerName}/${modelId}`;
        if (providerCfg?.models && Object.keys(providerCfg.models).length > 0) {
          const firstId = Object.keys(providerCfg.models)[0];
          if (firstId) return `${providerName}/${firstId}`;
        }
      }
      return undefined;
    })();

    const opencodeSmallModel = (() => {
      if (!opencodeModel) return undefined;
      for (const [providerName, providerCfg] of Object.entries(
        unifiedProviders,
      )) {
        if (!providerCfg?.models) continue;
        for (const [modelId, modelCfg] of Object.entries(providerCfg.models)) {
          if ((modelCfg?.enabled ?? true) === false) continue;
          const full = `${providerName}/${modelId}`;
          if (full !== opencodeModel) return full;
        }
      }
      return undefined;
    })();

    const opencodeProviders = Object.fromEntries(
      Object.entries(unifiedProviders).map(([providerName, providerCfg]) => [
        providerName,
        {
          base_url: providerCfg.base_url,
          api_key: providerCfg.api_key,
          models: providerCfg.models
            ? Object.fromEntries(
                Object.entries(providerCfg.models).map(
                  ([modelId, modelCfg]) => [
                    modelId,
                    modelCfg?.display_name ?? modelId,
                  ],
                ),
              )
            : undefined,
        },
      ]),
    );

    if (!opencodeModel && Object.keys(opencodeProviders).length === 0) return;

    const applyToJsonFile = async (destPath: string): Promise<void> => {
      let rawText: string | null = null;
      let existing: Record<string, unknown> = {};
      try {
        rawText = await fs.readFile(destPath, 'utf8');
      } catch {
        rawText = null;
      }

      if (rawText) {
        try {
          existing = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          // Lenient JSONC fallback.
          const stripped = rawText
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|\s+)\/\/.*$/gm, '$1')
            .replace(/,\s*([}\]])/g, '$1');
          existing = JSON.parse(stripped) as Record<string, unknown>;
        }
      }

      const next = { ...existing } as Record<string, unknown>;
      if (opencodeModel) next.model = opencodeModel;
      if (opencodeSmallModel) next.small_model = opencodeSmallModel;

      if (Object.keys(opencodeProviders).length > 0) {
        const existingProviders =
          next.provider &&
          typeof next.provider === 'object' &&
          !Array.isArray(next.provider)
            ? ({ ...(next.provider as Record<string, unknown>) } as Record<
                string,
                unknown
              >)
            : {};

        for (const [provName, provCfg] of Object.entries(opencodeProviders)) {
          const current =
            existingProviders[provName] &&
            typeof existingProviders[provName] === 'object' &&
            !Array.isArray(existingProviders[provName])
              ? ({
                  ...(existingProviders[provName] as Record<string, unknown>),
                } as Record<string, unknown>)
              : {};

          const options =
            current.options &&
            typeof current.options === 'object' &&
            !Array.isArray(current.options)
              ? ({ ...(current.options as Record<string, unknown>) } as Record<
                  string,
                  unknown
                >)
              : {};
          if (provCfg.base_url) options.baseURL = provCfg.base_url;
          if (provCfg.api_key) {
            const resolved = await resolvePlaceholderString(
              provCfg.api_key,
              projectRoot,
            );
            if (resolved) options.apiKey = resolved;
            else {
              logWarn(
                `Skipping OpenCode provider apiKey update for ${provName}: could not resolve ${provCfg.api_key}`,
                dryRun,
              );
            }
          }
          if (Object.keys(options).length > 0) current.options = options;

          if (provCfg.models) {
            const modelsObj: Record<string, unknown> =
              current.models &&
              typeof current.models === 'object' &&
              !Array.isArray(current.models)
                ? ({ ...(current.models as Record<string, unknown>) } as Record<
                    string,
                    unknown
                  >)
                : {};
            for (const [id, display] of Object.entries(provCfg.models)) {
              modelsObj[id] = { name: display };
            }
            current.models = modelsObj;
          }

          existingProviders[provName] = current;
        }

        next.provider = existingProviders;
      }

      const currentContent = rawText ? rawText : '';
      const newContent = JSON.stringify(next, null, 2) + '\n';
      if (currentContent.trim() !== newContent.trim()) {
        if (backup) {
          const { backupFile } = await import('../core/FileSystemUtils');
          await backupFile(destPath);
        }
        await FileSystemUtils.writeGeneratedFile(destPath, newContent);
      }
    };

    if (allowProjectWrites) {
      const projectPath = path.join(projectRoot, 'opencode.json');
      if (dryRun) {
        logVerbose(
          `DRY RUN: Would apply OpenCode model settings to: ${projectPath}`,
          verbose,
        );
      } else {
        await applyToJsonFile(projectPath);
      }
    }

    if (allowUserWrites) {
      const userJsoncPath = path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        'opencode',
        'opencode.jsonc',
      );
      if (dryRun) {
        logVerbose(
          `DRY RUN: Would apply OpenCode model settings to: ${userJsoncPath}`,
          verbose,
        );
      } else {
        await applyToJsonFile(userJsoncPath);
      }
    }
  }
}

async function handleMcpConfiguration(
  agent: IAgent,
  agentConfig: IAgentConfig | undefined,
  config: LoadedConfig,
  rulerMcpJson: Record<string, unknown> | null,
  projectRoot: string,
  generatedPaths: string[],
  verbose: boolean,
  dryRun: boolean,
  cliMcpEnabled = true,
  cliMcpStrategy?: McpStrategy,
  outputScope: OutputScope = 'project',
  backup = true,
): Promise<void> {
  if (!agentSupportsMcp(agent)) {
    logVerbose(
      `Agent ${agent.getName()} does not support MCP - skipping MCP configuration`,
      verbose,
    );
    return;
  }

  const dests: string[] = [];
  if (outputScope === 'project' || outputScope === 'both') {
    const p = await getNativeMcpPath(agent.getName(), projectRoot, 'project');
    if (p) dests.push(p);
  }
  if (outputScope === 'user' || outputScope === 'both') {
    const p = await getNativeMcpPath(agent.getName(), projectRoot, 'user');
    if (p) dests.push(p);
  }
  const uniqueDests = Array.from(new Set(dests));
  const mcpEnabledForAgent =
    cliMcpEnabled && (agentConfig?.mcp?.enabled ?? config.mcp?.enabled ?? true);

  if (uniqueDests.length === 0 || !mcpEnabledForAgent) {
    return;
  }

  const filteredMcpJson = rulerMcpJson
    ? filterMcpConfigForAgent(rulerMcpJson, agent)
    : null;

  if (!filteredMcpJson) {
    logVerbose(
      `No compatible MCP servers found for ${agent.getName()} - skipping MCP configuration`,
      verbose,
    );
    return;
  }

  for (const dest of uniqueDests) {
    await updateGitignoreForMcpFile(dest, projectRoot, generatedPaths, backup);
    await applyMcpConfiguration(
      agent,
      filteredMcpJson,
      dest,
      agentConfig,
      config,
      projectRoot,
      outputScope,
      cliMcpStrategy,
      dryRun,
      verbose,
      backup,
    );
  }
}

async function updateGitignoreForMcpFile(
  dest: string,
  projectRoot: string,
  generatedPaths: string[],
  backup = true,
): Promise<void> {
  if (dest.startsWith(projectRoot)) {
    const relativeDest = path.relative(projectRoot, dest);
    generatedPaths.push(relativeDest);
    if (backup) {
      generatedPaths.push(`${relativeDest}.bak`);
    }
  }
}

function sanitizeMcpTimeoutsForAgent(
  agent: IAgent,
  mcpJson: Record<string, unknown>,
  dryRun: boolean,
): Record<string, unknown> {
  if (agent.supportsMcpTimeout?.()) {
    return mcpJson;
  }

  if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== 'object') {
    return mcpJson;
  }

  const servers = mcpJson.mcpServers as Record<string, unknown>;
  const sanitizedServers: Record<string, unknown> = {};
  const strippedTimeouts: string[] = [];

  for (const [name, serverDef] of Object.entries(servers)) {
    if (serverDef && typeof serverDef === 'object') {
      const copy = { ...(serverDef as Record<string, unknown>) };
      if ('timeout' in copy) {
        delete copy.timeout;
        strippedTimeouts.push(name);
      }
      sanitizedServers[name] = copy;
    } else {
      sanitizedServers[name] = serverDef;
    }
  }

  if (strippedTimeouts.length > 0) {
    logWarn(
      `${agent.getName()} does not support MCP server timeout configuration; ignoring timeout for: ${strippedTimeouts.join(', ')}`,
      dryRun,
    );
  }

  return {
    ...mcpJson,
    mcpServers: sanitizedServers,
  };
}

async function applyMcpConfiguration(
  agent: IAgent,
  filteredMcpJson: Record<string, unknown>,
  dest: string,
  agentConfig: IAgentConfig | undefined,
  config: LoadedConfig,
  projectRoot: string,
  outputScope: OutputScope,
  cliMcpStrategy: McpStrategy | undefined,
  dryRun: boolean,
  verbose: boolean,
  backup = true,
): Promise<void> {
  const normalizedProjectRoot = path.resolve(projectRoot);
  const normalizedDest = path.resolve(dest);
  const isWithin = (child: string, parent: string): boolean => {
    const rel = path.relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  // Safety: only write inside the project root, unless the user explicitly
  // opted into user-scope outputs.
  const allowUserWrites = outputScope === 'user' || outputScope === 'both';
  const homeDir = os.homedir();
  const isInProject =
    normalizedDest === normalizedProjectRoot ||
    isWithin(normalizedDest, normalizedProjectRoot);
  const isInHome =
    normalizedDest === homeDir || isWithin(normalizedDest, homeDir);
  if (!isInProject && !(allowUserWrites && isInHome)) {
    logVerbose(
      `Skipping MCP config for ${agent.getName()} because target path is outside allowed roots: ${dest}`,
      verbose,
    );
    return;
  }

  const agentMcpJson = sanitizeMcpTimeoutsForAgent(
    agent,
    filteredMcpJson,
    dryRun,
  );

  if (agent.getIdentifier() === 'openhands') {
    return await applyOpenHandsMcpConfiguration(
      agentMcpJson,
      dest,
      dryRun,
      verbose,
      backup,
    );
  }

  if (agent.getIdentifier() === 'opencode') {
    return await applyOpenCodeMcpConfiguration(
      agentMcpJson,
      dest,
      dryRun,
      verbose,
      backup,
    );
  }

  // Agents that handle MCP configuration internally should not have external MCP handling
  if (
    agent.getIdentifier() === 'zed' ||
    agent.getIdentifier() === 'gemini-cli' ||
    agent.getIdentifier() === 'amazon-q-cli' ||
    agent.getIdentifier() === 'crush'
  ) {
    logVerbose(
      `Skipping external MCP config for ${agent.getName()} - handled internally by agent`,
      verbose,
    );
    return;
  }

  return await applyStandardMcpConfiguration(
    agent,
    agentMcpJson,
    dest,
    agentConfig,
    config,
    cliMcpStrategy,
    dryRun,
    verbose,
    backup,
  );
}

async function applyOpenHandsMcpConfiguration(
  filteredMcpJson: Record<string, unknown>,
  dest: string,
  dryRun: boolean,
  verbose: boolean,
  backup = true,
): Promise<void> {
  if (dryRun) {
    logVerbose(
      `DRY RUN: Would apply MCP config by updating TOML file: ${dest}`,
      verbose,
    );
  } else {
    await propagateMcpToOpenHands(filteredMcpJson, dest, backup);
  }
}

async function applyOpenCodeMcpConfiguration(
  filteredMcpJson: Record<string, unknown>,
  dest: string,
  dryRun: boolean,
  verbose: boolean,
  backup = true,
): Promise<void> {
  if (dryRun) {
    logVerbose(
      `DRY RUN: Would apply MCP config by updating OpenCode config file: ${dest}`,
      verbose,
    );
  } else {
    await propagateMcpToOpenCode(filteredMcpJson, dest, backup);
  }
}

/**
 * Transform MCP server types for Claude Code compatibility.
 * Claude expects "http" for HTTP servers and "sse" for SSE servers, not "remote".
 */
function transformMcpForClaude(
  mcpJson: Record<string, unknown>,
): Record<string, unknown> {
  if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== 'object') {
    return mcpJson;
  }

  const transformedMcp = { ...mcpJson };
  const transformedServers: Record<string, unknown> = {};

  for (const [name, serverDef] of Object.entries(
    mcpJson.mcpServers as Record<string, unknown>,
  )) {
    if (serverDef && typeof serverDef === 'object') {
      const server = serverDef as Record<string, unknown>;
      const transformedServer = { ...server };

      // Transform type: "remote" to appropriate Claude types
      if (
        server.type === 'remote' &&
        server.url &&
        typeof server.url === 'string'
      ) {
        const url = server.url as string;

        // Check if URL suggests SSE (contains /sse path segment)
        if (/\/sse(\/|$)/i.test(url)) {
          transformedServer.type = 'sse';
        } else {
          transformedServer.type = 'http';
        }
      }

      transformedServers[name] = transformedServer;
    } else {
      transformedServers[name] = serverDef;
    }
  }

  transformedMcp.mcpServers = transformedServers;
  return transformedMcp;
}

/**
 * Transform MCP server types for Kilo Code compatibility.
 * Kilo Code expects "streamable-http" for remote HTTP servers, not "remote".
 */
function transformMcpForKiloCode(
  mcpJson: Record<string, unknown>,
): Record<string, unknown> {
  if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== 'object') {
    return mcpJson;
  }

  const transformedMcp = { ...mcpJson };
  const transformedServers: Record<string, unknown> = {};

  for (const [name, serverDef] of Object.entries(
    mcpJson.mcpServers as Record<string, unknown>,
  )) {
    if (serverDef && typeof serverDef === 'object') {
      const server = serverDef as Record<string, unknown>;
      const transformedServer = { ...server };

      // Transform type: "remote" to "streamable-http" for HTTP-based servers
      if (
        server.type === 'remote' &&
        server.url &&
        typeof server.url === 'string'
      ) {
        transformedServer.type = 'streamable-http';
      }

      transformedServers[name] = transformedServer;
    } else {
      transformedServers[name] = serverDef;
    }
  }

  transformedMcp.mcpServers = transformedServers;
  return transformedMcp;
}

/**
 * Transform MCP server types for Factory Droid compatibility.
 * Factory Droid expects "http" for remote HTTP servers, not "remote".
 */
function transformMcpForFactoryDroid(
  mcpJson: Record<string, unknown>,
): Record<string, unknown> {
  if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== 'object') {
    return mcpJson;
  }

  const transformedMcp = { ...mcpJson };
  const transformedServers: Record<string, unknown> = {};

  for (const [name, serverDef] of Object.entries(
    mcpJson.mcpServers as Record<string, unknown>,
  )) {
    if (serverDef && typeof serverDef === 'object') {
      const server = serverDef as Record<string, unknown>;
      const transformedServer = { ...server };

      if (
        server.type === 'remote' &&
        server.url &&
        typeof server.url === 'string'
      ) {
        transformedServer.type = 'http';
      }

      transformedServers[name] = transformedServer;
    } else {
      transformedServers[name] = serverDef;
    }
  }

  transformedMcp.mcpServers = transformedServers;
  return transformedMcp;
}

async function applyStandardMcpConfiguration(
  agent: IAgent,
  filteredMcpJson: Record<string, unknown>,
  dest: string,
  agentConfig: IAgentConfig | undefined,
  config: LoadedConfig,
  cliMcpStrategy: McpStrategy | undefined,
  dryRun: boolean,
  verbose: boolean,
  backup = true,
): Promise<void> {
  const strategy =
    cliMcpStrategy ??
    agentConfig?.mcp?.strategy ??
    config.mcp?.strategy ??
    'merge';
  const serverKey = agent.getMcpServerKey?.() ?? 'mcpServers';

  // Skip agents with empty server keys (e.g., AgentsMdAgent, GooseAgent)
  if (serverKey === '') {
    logVerbose(
      `Skipping MCP config for ${agent.getName()} - agent has empty server key`,
      verbose,
    );
    return;
  }

  logVerbose(
    `Applying filtered MCP config for ${agent.getName()} with strategy: ${strategy} and key: ${serverKey}`,
    verbose,
  );

  if (dryRun) {
    logVerbose(`DRY RUN: Would apply MCP config to: ${dest}`, verbose);
  } else {
    // Transform MCP config for agent-specific compatibility
    let mcpToMerge = filteredMcpJson;
    if (agent.getIdentifier() === 'claude') {
      mcpToMerge = transformMcpForClaude(filteredMcpJson);
    } else if (agent.getIdentifier() === 'kilocode') {
      mcpToMerge = transformMcpForKiloCode(filteredMcpJson);
    } else if (agent.getIdentifier() === 'factory') {
      mcpToMerge = transformMcpForFactoryDroid(filteredMcpJson);
    }

    const CODEX_AGENT_ID = 'codex';
    const isCodexToml =
      agent.getIdentifier() === CODEX_AGENT_ID && dest.endsWith('.toml');
    let existing = await readNativeMcp(dest);
    if (isCodexToml) {
      try {
        const tomlContent = await fs.readFile(dest, 'utf8');
        existing = parseTOML(tomlContent) as Record<string, unknown>;
      } catch (error) {
        logVerbose(
          `Failed to read Codex MCP TOML at ${dest}: ${(error as Error).message}`,
          verbose,
        );
        // ignore missing or invalid TOML, fall back to previously read value
      }
    }
    let merged = mergeMcp(existing, mcpToMerge, strategy, serverKey);
    if (isCodexToml) {
      const { [serverKey]: servers, ...rest } = merged as Record<
        string,
        unknown
      >;
      merged = {
        ...rest,
        // Codex CLI expects MCP servers under mcp_servers in config.toml.
        mcp_servers: servers ?? {},
      };
    }

    // Firebase Studio (IDX) expects no "type" fields in .idx/mcp.json server entries.
    // Sanitize merged config by stripping 'type' from each server when targeting Firebase.
    const sanitizeForFirebase = (
      obj: Record<string, unknown>,
    ): Record<string, unknown> => {
      if (agent.getIdentifier() !== 'firebase') return obj;
      const out: Record<string, unknown> = { ...obj };
      const servers = (out[serverKey] as Record<string, unknown>) || {};
      const cleanedServers: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(servers)) {
        if (def && typeof def === 'object') {
          const copy = { ...(def as Record<string, unknown>) };
          delete (copy as Record<string, unknown>).type;
          cleanedServers[name] = copy;
        } else {
          cleanedServers[name] = def;
        }
      }
      out[serverKey] = cleanedServers;
      return out;
    };

    // Gemini CLI (since v0.21.0) no longer accepts the "type" field in MCP server entries.
    // Following the MCP spec update from Nov 25, 2025, the transport type is now inferred
    // from the presence of specific keys (command/args -> stdio, url -> sse/http).
    // Sanitize merged config by stripping 'type' from each server when targeting Gemini.
    const sanitizeForGemini = (
      obj: Record<string, unknown>,
    ): Record<string, unknown> => {
      if (agent.getIdentifier() !== 'gemini-cli') return obj;
      const out: Record<string, unknown> = { ...obj };
      const servers = (out[serverKey] as Record<string, unknown>) || {};
      const cleanedServers: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(servers)) {
        if (def && typeof def === 'object') {
          const copy = { ...(def as Record<string, unknown>) };
          delete (copy as Record<string, unknown>).type;
          cleanedServers[name] = copy;
        } else {
          cleanedServers[name] = def;
        }
      }
      out[serverKey] = cleanedServers;
      return out;
    };

    let toWrite = sanitizeForFirebase(merged);
    toWrite = sanitizeForGemini(toWrite);

    // Only backup and write if content would actually change (idempotent)
    const currentContent = isCodexToml
      ? stringify(existing as Record<string, unknown>)
      : JSON.stringify(existing, null, 2);
    const newContent = isCodexToml
      ? stringify(toWrite as Record<string, unknown>)
      : JSON.stringify(toWrite, null, 2);

    if (currentContent !== newContent) {
      if (backup) {
        const { backupFile } = await import('../core/FileSystemUtils');
        await backupFile(dest);
      }
      if (isCodexToml) {
        await FileSystemUtils.writeGeneratedFile(
          dest,
          stringify(toWrite as Record<string, unknown>),
        );
      } else {
        await writeNativeMcp(dest, toWrite);
      }
    } else {
      logVerbose(
        `MCP config for ${agent.getName()} is already up to date - skipping backup and write`,
        verbose,
      );
    }
  }
}

/**
 * Updates the .gitignore file with generated paths.
 * @param projectRoot Root directory of the project
 * @param generatedPaths Array of generated file paths
 * @param config Loaded configuration
 * @param cliGitignoreEnabled CLI gitignore setting
 * @param dryRun Whether to perform a dry run
 */
export async function updateGitignore(
  projectRoot: string,
  generatedPaths: string[],
  config: LoadedConfig,
  cliGitignoreEnabled: boolean | undefined,
  dryRun: boolean,
): Promise<void> {
  // Configuration precedence: CLI > TOML > Default (enabled)
  let gitignoreEnabled: boolean;
  if (cliGitignoreEnabled !== undefined) {
    gitignoreEnabled = cliGitignoreEnabled;
  } else if (config.gitignore?.enabled !== undefined) {
    gitignoreEnabled = config.gitignore.enabled;
  } else {
    gitignoreEnabled = true; // Default enabled
  }

  if (gitignoreEnabled && generatedPaths.length > 0) {
    const uniquePaths = [...new Set(generatedPaths)];

    // Note: Individual backup patterns are added per-file in the collection phase
    // No need to add a broad *.bak pattern here

    if (uniquePaths.length > 0) {
      if (dryRun) {
        logInfo(
          `Would update .gitignore with ${uniquePaths.length} unique path(s): ${uniquePaths.join(', ')}`,
          dryRun,
        );
      } else {
        await updateGitignoreUtil(projectRoot, uniquePaths);
        logInfo(
          `Updated .gitignore with ${uniquePaths.length} unique path(s) in the Ruler block.`,
          dryRun,
        );
      }
    }
  }
}
