import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@iarna/toml';
import type { McpServerDef } from './core/UnifiedConfigTypes';

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

  const servers = await importMcpServers(agents, src);
  const tomlObj: Record<string, unknown> = {
    mcp: {
      enabled: true,
      merge_strategy: 'merge',
    },
    mcp_servers: servers,
  };
  const tomlText = stringifyTOML(tomlObj);
  await fs.writeFile(path.join(rulerDir, 'ruler.toml'), tomlText, 'utf8');

  await importSkills(agents, src, rulerDir);
}
