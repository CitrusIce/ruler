import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@iarna/toml';
import type { McpServerDef } from './core/UnifiedConfigTypes';
import type {
  ModelsConfig,
  ProviderType,
  UnifiedProviderConfig,
} from './types';

type ImportAgent = 'claude' | 'codex' | 'opencode';

type ImportSource = {
  projectRoot: string;
  homeDir: string;
  xdgConfigHome: string;
};

function getXdgConfigDir(homeDir: string): string {
  return process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureEmptyRulerDir(projectRoot: string): Promise<string> {
  const rulerDir = path.join(projectRoot, '.ruler');
  if (await pathExists(rulerDir)) {
    throw new Error(`.ruler already exists at ${rulerDir}`);
  }
  await fs.mkdir(rulerDir, { recursive: true });
  return rulerDir;
}

async function readTextIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonIfExists(
  p: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readTomlIfExists(
  p: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = raw.trim() ? parseTOML(raw) : {};
    return parsed as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toMcpServerDefFromJson(def: Record<string, unknown>): McpServerDef {
  const out: McpServerDef = {};
  if (typeof def.command === 'string') out.command = def.command;
  if (Array.isArray(def.command) && typeof def.command[0] === 'string') {
    out.command = String(def.command[0]);
  }
  if (Array.isArray(def.args)) out.args = def.args.map(String);
  if (def.env && typeof def.env === 'object' && !Array.isArray(def.env)) {
    out.env = Object.fromEntries(
      Object.entries(def.env as Record<string, unknown>).flatMap(([k, v]) =>
        typeof v === 'string' ? [[k, v]] : [],
      ),
    );
  }
  if (typeof def.url === 'string') out.url = def.url;
  if (
    def.headers &&
    typeof def.headers === 'object' &&
    !Array.isArray(def.headers)
  ) {
    out.headers = Object.fromEntries(
      Object.entries(def.headers as Record<string, unknown>).flatMap(
        ([k, v]) => (typeof v === 'string' ? [[k, v]] : []),
      ),
    );
  }
  if (typeof def.timeout === 'number') out.timeout = def.timeout;
  if (out.url) out.type = 'remote';
  else if (out.command) out.type = 'stdio';
  return out;
}

function extractClaudeMcpServers(
  native: Record<string, unknown>,
): Record<string, McpServerDef> {
  const serversRaw =
    (native.mcpServers as unknown) ||
    (native.servers as unknown) ||
    (native.mcp as unknown) ||
    {};
  if (!serversRaw || typeof serversRaw !== 'object') return {};
  const out: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(
    serversRaw as Record<string, unknown>,
  )) {
    if (!def || typeof def !== 'object') continue;
    out[name] = toMcpServerDefFromJson(def as Record<string, unknown>);
  }
  return out;
}

function extractCodexMcpServers(
  nativeToml: Record<string, unknown>,
): Record<string, McpServerDef> {
  const serversRaw = nativeToml.mcp_servers as unknown;
  if (!serversRaw || typeof serversRaw !== 'object') return {};
  const out: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(
    serversRaw as Record<string, unknown>,
  )) {
    if (!def || typeof def !== 'object') continue;
    out[name] = toMcpServerDefFromJson(def as Record<string, unknown>);
  }
  return out;
}

function extractOpenCodeMcpServers(
  native: Record<string, unknown>,
): Record<string, McpServerDef> {
  const serversRaw = native.mcp as unknown;
  if (!serversRaw || typeof serversRaw !== 'object') return {};
  const out: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(
    serversRaw as Record<string, unknown>,
  )) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    const server: McpServerDef = {};

    if (Array.isArray(d.command) && d.command.length > 0) {
      server.command = String(d.command[0]);
      const rest = d.command.slice(1).map(String);
      if (rest.length > 0) server.args = rest;
    } else if (typeof d.command === 'string') {
      server.command = d.command;
    }
    if (Array.isArray(d.args)) {
      server.args = (server.args || []).concat(d.args.map(String));
    }

    if (
      d.environment &&
      typeof d.environment === 'object' &&
      !Array.isArray(d.environment)
    ) {
      server.env = Object.fromEntries(
        Object.entries(d.environment as Record<string, unknown>).flatMap(
          ([k, v]) => (typeof v === 'string' ? [[k, v]] : []),
        ),
      );
    }

    if (typeof d.url === 'string') server.url = d.url;
    if (
      d.headers &&
      typeof d.headers === 'object' &&
      !Array.isArray(d.headers)
    ) {
      server.headers = Object.fromEntries(
        Object.entries(d.headers as Record<string, unknown>).flatMap(
          ([k, v]) => (typeof v === 'string' ? [[k, v]] : []),
        ),
      );
    }

    if (server.url) server.type = 'remote';
    else if (server.command) server.type = 'stdio';
    out[name] = server;
  }
  return out;
}

function mergeServers(
  primary: Record<string, McpServerDef>,
  secondary: Record<string, McpServerDef>,
): Record<string, McpServerDef> {
  // Primary wins per-server.
  return { ...secondary, ...primary };
}

async function importMcpServers(
  agents: ImportAgent[],
  src: ImportSource,
): Promise<Record<string, McpServerDef>> {
  const servers: Record<string, McpServerDef> = {};

  for (const agent of agents) {
    if (agent === 'claude') {
      const projectPath = path.join(src.projectRoot, '.mcp.json');
      const userPath = path.join(src.homeDir, '.claude.json');
      const projectJson = await readJsonIfExists(projectPath);
      const userJson = await readJsonIfExists(userPath);

      const project = projectJson ? extractClaudeMcpServers(projectJson) : {};
      const user = userJson ? extractClaudeMcpServers(userJson) : {};
      Object.assign(servers, mergeServers(project, user));
    }

    if (agent === 'codex') {
      const projectPath = path.join(src.projectRoot, '.codex', 'config.toml');
      const userPath = path.join(src.homeDir, '.codex', 'config.toml');
      const projectToml = await readTomlIfExists(projectPath);
      const userToml = await readTomlIfExists(userPath);

      const project = projectToml ? extractCodexMcpServers(projectToml) : {};
      const user = userToml ? extractCodexMcpServers(userToml) : {};
      Object.assign(servers, mergeServers(project, user));
    }

    if (agent === 'opencode') {
      const projectPath = path.join(src.projectRoot, 'opencode.json');
      const userPath = path.join(
        src.xdgConfigHome,
        'opencode',
        'opencode.json',
      );
      const projectJson = await readJsonIfExists(projectPath);
      const userJson = await readJsonIfExists(userPath);

      const project = projectJson ? extractOpenCodeMcpServers(projectJson) : {};
      const user = userJson ? extractOpenCodeMcpServers(userJson) : {};
      Object.assign(servers, mergeServers(project, user));
    }
  }

  return servers;
}

async function copyDirMerge(srcDir: string, destDir: string): Promise<void> {
  if (!(await pathExists(srcDir))) return;
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirMerge(srcPath, destPath);
      continue;
    }
    if (entry.isFile()) {
      // Don't overwrite an already-imported file.
      if (await pathExists(destPath)) continue;
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function importSkills(
  agents: ImportAgent[],
  src: ImportSource,
  rulerDir: string,
): Promise<void> {
  const skillsDest = path.join(rulerDir, 'skills');
  await fs.mkdir(skillsDest, { recursive: true });

  for (const agent of agents) {
    if (agent === 'claude') {
      await copyDirMerge(
        path.join(src.projectRoot, '.claude', 'skills'),
        skillsDest,
      );
      await copyDirMerge(
        path.join(src.homeDir, '.claude', 'skills'),
        skillsDest,
      );
    }
    if (agent === 'codex') {
      await copyDirMerge(
        path.join(src.projectRoot, '.codex', 'skills'),
        skillsDest,
      );
      // User-level: Codex skills are commonly stored under ~/.agents/skills.
      await copyDirMerge(
        path.join(src.homeDir, '.agents', 'skills'),
        skillsDest,
      );
    }
    if (agent === 'opencode') {
      await copyDirMerge(
        path.join(src.projectRoot, '.opencode', 'skill'),
        skillsDest,
      );
      await copyDirMerge(
        path.join(src.xdgConfigHome, 'opencode', 'skills'),
        skillsDest,
      );
    }
  }
}

async function importRules(
  projectRoot: string,
  homeDir: string,
  rulerDir: string,
): Promise<void> {
  const candidates = [
    path.join(projectRoot, 'AGENTS.md'),
    path.join(projectRoot, 'CLAUDE.md'),
    path.join(homeDir, '.claude', 'CLAUDE.md'),
  ];

  let content: string | null = null;
  for (const p of candidates) {
    content = await readTextIfExists(p);
    if (content !== null) break;
  }

  const dest = path.join(rulerDir, 'AGENTS.md');
  await fs.writeFile(dest, content ?? '', 'utf8');
}

function stripJsonc(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s+)\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}

async function readJsoncIfExists(
  p: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
    }
  } catch {
    return null;
  }
}

async function importModels(
  agents: ImportAgent[],
  src: ImportSource,
): Promise<ModelsConfig | null> {
  const models: ModelsConfig = {};
  const providers: Record<string, UnifiedProviderConfig> = {};
  let nextProviderId = 1;

  const inferProviderType = (
    name: string,
    npmName?: string,
  ): ProviderType | undefined => {
    const hay = `${name} ${npmName ?? ''}`.toLowerCase();
    if (hay.includes('anthropic')) return 'anthropic';
    if (hay.includes('google') || hay.includes('gemini')) return 'google';
    if (hay.includes('openai')) return 'openai';
    return undefined;
  };

  const findMergeableProviderId = (
    type?: ProviderType,
    baseUrl?: string,
    apiKey?: string,
  ): string | undefined => {
    if (!apiKey) return undefined;
    for (const [id, cfg] of Object.entries(providers)) {
      if (cfg.api_key !== apiKey) continue;
      if (type && cfg.type && cfg.type !== type) continue;
      if (baseUrl && cfg.base_url && cfg.base_url !== baseUrl) continue;
      return id;
    }
    return undefined;
  };

  const createProvider = (
    type?: ProviderType,
    baseUrl?: string,
    apiKey?: string,
  ): string => {
    const mergeableId = findMergeableProviderId(type, baseUrl, apiKey);
    if (mergeableId) {
      const existing = providers[mergeableId];
      if (existing) {
        if (!existing.type && type) existing.type = type;
        if (!existing.base_url && baseUrl) existing.base_url = baseUrl;
        if (!existing.api_key && apiKey) existing.api_key = apiKey;
        existing.models = existing.models ?? {};
      }
      return mergeableId;
    }

    const id = String(nextProviderId++);
    providers[id] = {
      type,
      base_url: baseUrl,
      api_key: apiKey,
      models: {},
    };
    return id;
  };

  const setProviderApi = (providerId: string, apiKey?: string): void => {
    if (!apiKey) return;
    const current = providers[providerId];
    if (!current) return;
    if (!current.api_key) current.api_key = apiKey;
  };

  const addProviderModel = (
    providerId: string,
    modelId: string,
    displayName?: string,
  ): void => {
    if (!modelId) return;
    const p = providers[providerId];
    if (!p) return;
    p.models = p.models ?? {};
    p.models[modelId] = {
      ...(p.models[modelId] ?? {}),
      display_name: displayName,
      enabled: true,
    };
  };

  if (agents.includes('claude')) {
    const settingsPath = path.join(src.homeDir, '.claude', 'settings.json');
    const settings = await readJsonIfExists(settingsPath);
    if (settings) {
      const env =
        settings.env &&
        typeof settings.env === 'object' &&
        !Array.isArray(settings.env)
          ? (settings.env as Record<string, unknown>)
          : {};
      const baseUrl =
        typeof env.ANTHROPIC_BASE_URL === 'string'
          ? (env.ANTHROPIC_BASE_URL as string)
          : undefined;
      const token =
        typeof env.ANTHROPIC_AUTH_TOKEN === 'string'
          ? (env.ANTHROPIC_AUTH_TOKEN as string)
          : undefined;
      const apiKey =
        typeof env.ANTHROPIC_API_KEY === 'string'
          ? (env.ANTHROPIC_API_KEY as string)
          : undefined;
      const authVal = token || apiKey;

      const claudeModel =
        typeof settings.model === 'string'
          ? (settings.model as string)
          : undefined;
      const anthropicId = createProvider('anthropic', baseUrl, authVal);
      if (claudeModel) addProviderModel(anthropicId, claudeModel);
    }
  }

  if (agents.includes('codex')) {
    const authPath = path.join(src.homeDir, '.codex', 'auth.json');
    const auth = await readJsonIfExists(authPath);
    const openaiKey =
      auth && typeof auth.OPENAI_API_KEY === 'string'
        ? (auth.OPENAI_API_KEY as string)
        : undefined;

    const projectConfigPath = path.join(
      src.projectRoot,
      '.codex',
      'config.toml',
    );
    const userConfigPath = path.join(src.homeDir, '.codex', 'config.toml');
    const projectToml = await readTomlIfExists(projectConfigPath);
    const userToml = await readTomlIfExists(userConfigPath);
    const cfg = projectToml || userToml;

    if (cfg) {
      const model_provider =
        typeof cfg.model_provider === 'string'
          ? (cfg.model_provider as string)
          : undefined;
      const model =
        typeof cfg.model === 'string' ? (cfg.model as string) : undefined;

      const providersRaw =
        cfg.model_providers &&
        typeof cfg.model_providers === 'object' &&
        !Array.isArray(cfg.model_providers)
          ? (cfg.model_providers as Record<string, unknown>)
          : {};
      const codexProviderIds: Record<string, string> = {};
      for (const [name, def] of Object.entries(providersRaw)) {
        if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
        const d = def as Record<string, unknown>;
        const providerName =
          typeof d.name === 'string' ? (d.name as string) : undefined;
        const providerBaseUrl =
          typeof d.base_url === 'string' ? (d.base_url as string) : undefined;
        const providerId = createProvider(
          inferProviderType(name, providerName),
          providerBaseUrl,
          undefined,
        );
        codexProviderIds[name] = providerId;
      }

      const codexProviderName = model_provider || 'openai';
      let selectedProviderId = codexProviderIds[codexProviderName];
      if (!selectedProviderId) {
        selectedProviderId = createProvider('openai', undefined, undefined);
        codexProviderIds[codexProviderName] = selectedProviderId;
      }
      setProviderApi(selectedProviderId, openaiKey);
      if (model) addProviderModel(selectedProviderId, model);
    }
  }

  if (agents.includes('opencode')) {
    const userPath = path.join(src.xdgConfigHome, 'opencode', 'opencode.jsonc');
    const userJson = await readJsoncIfExists(userPath);
    if (userJson) {
      const opencodeProviderIds: Record<string, string> = {};
      const provider =
        userJson.provider &&
        typeof userJson.provider === 'object' &&
        !Array.isArray(userJson.provider)
          ? (userJson.provider as Record<string, unknown>)
          : {};
      for (const [provName, provDef] of Object.entries(provider)) {
        if (!provDef || typeof provDef !== 'object' || Array.isArray(provDef))
          continue;
        const d = provDef as Record<string, unknown>;
        const options =
          d.options &&
          typeof d.options === 'object' &&
          !Array.isArray(d.options)
            ? (d.options as Record<string, unknown>)
            : {};
        const baseURL =
          typeof options.baseURL === 'string'
            ? (options.baseURL as string)
            : undefined;
        const apiKey =
          typeof options.apiKey === 'string'
            ? (options.apiKey as string)
            : undefined;

        const providerId = createProvider(
          inferProviderType(
            provName,
            typeof d.npm === 'string' ? d.npm : undefined,
          ),
          baseURL,
          apiKey,
        );
        opencodeProviderIds[provName] = providerId;

        const modelsRaw =
          d.models && typeof d.models === 'object' && !Array.isArray(d.models)
            ? (d.models as Record<string, unknown>)
            : {};
        for (const [id, m] of Object.entries(modelsRaw)) {
          if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
          const mm = m as Record<string, unknown>;
          addProviderModel(
            providerId,
            id,
            typeof mm.name === 'string' ? (mm.name as string) : undefined,
          );
        }
      }

      const opencodeModel =
        typeof userJson.model === 'string'
          ? (userJson.model as string)
          : undefined;
      if (opencodeModel && opencodeModel.includes('/')) {
        const [providerName, modelId] = opencodeModel.split('/', 2);
        let providerId = opencodeProviderIds[providerName];
        if (!providerId) {
          providerId = createProvider(inferProviderType(providerName));
          opencodeProviderIds[providerName] = providerId;
        }
        addProviderModel(providerId, modelId);
      }
      const opencodeSmall =
        typeof userJson.small_model === 'string'
          ? (userJson.small_model as string)
          : undefined;
      if (opencodeSmall && opencodeSmall.includes('/')) {
        const [providerName, modelId] = opencodeSmall.split('/', 2);
        let providerId = opencodeProviderIds[providerName];
        if (!providerId) {
          providerId = createProvider(inferProviderType(providerName));
          opencodeProviderIds[providerName] = providerId;
        }
        addProviderModel(providerId, modelId);
      }
    }
  }

  if (Object.keys(providers).length > 0) {
    models.providers = providers;
  }

  return Object.keys(models).length > 0 ? models : null;
}

export async function importToRuler(options: {
  projectRoot: string;
  agents?: ImportAgent[];
}): Promise<void> {
  const projectRoot = path.resolve(options.projectRoot);
  const homeDir = os.homedir();
  const xdgConfigHome = getXdgConfigDir(homeDir);
  const src: ImportSource = { projectRoot, homeDir, xdgConfigHome };

  const agents: ImportAgent[] = options.agents ?? [
    'claude',
    'codex',
    'opencode',
  ];
  const rulerDir = await ensureEmptyRulerDir(projectRoot);

  await importRules(projectRoot, homeDir, rulerDir);

  const models = await importModels(agents, src);

  const servers = await importMcpServers(agents, src);
  const tomlObj: Record<string, unknown> = {
    mcp: {
      enabled: true,
      merge_strategy: 'merge',
    },
    models: models ?? undefined,
    mcp_servers: servers,
  };
  // Avoid serializing `models = {}` when no model info was found.
  if (!models) {
    delete (tomlObj as Record<string, unknown>).models;
  }
  const tomlText = stringifyTOML(tomlObj);
  await fs.writeFile(path.join(rulerDir, 'ruler.toml'), tomlText, 'utf8');

  await importSkills(agents, src, rulerDir);
}
