import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { setupTestProject, teardownTestProject, runRulerWithEnv } from './harness';

async function readText(p: string): Promise<string> {
  return await fs.readFile(p, 'utf8');
}

describe('--output-scope user', () => {
  it('writes Claude MCP + CLAUDE.md to user scope only', async () => {
    const { projectRoot } = await setupTestProject({
      '.ruler/AGENTS.md': '# Test Rules\n',
      '.ruler/ruler.toml': `
[mcp_servers.test_server]
command = "echo"
args = ["hello"]
`,
    });

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ruler-home-'));
    const xdg = path.join(home, '.config');

    try {
      runRulerWithEnv(
        'apply claude --no-skills --output-scope user',
        projectRoot,
        { HOME: home, XDG_CONFIG_HOME: xdg },
      );

      // Project outputs should not include MCP config.
      await expect(fs.access(path.join(projectRoot, '.mcp.json'))).rejects.toBeDefined();

      const userClaudeJson = path.join(home, '.claude.json');
      const parsed = JSON.parse(await readText(userClaudeJson)) as Record<
        string,
        unknown
      >;
      const mcpServers = parsed.mcpServers as Record<string, unknown>;
      expect(mcpServers).toBeDefined();
      expect(mcpServers).toHaveProperty('test_server');

      const userClaudeMd = path.join(home, '.claude', 'CLAUDE.md');
      const md = await readText(userClaudeMd);
      expect(md).toContain('# Test Rules');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await teardownTestProject(projectRoot);
    }
  });

  it('updates Codex user config.toml without wiping unrelated keys on overwrite', async () => {
    const { projectRoot } = await setupTestProject({
      '.ruler/AGENTS.md': '# Test Rules\n',
      '.ruler/ruler.toml': `
[mcp_servers.test_server]
command = "echo"
args = ["hello"]
`,
    });

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ruler-home-'));
    const xdg = path.join(home, '.config');

    try {
      const codexConfigPath = path.join(home, '.codex', 'config.toml');
      await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
      await fs.writeFile(
        codexConfigPath,
        `model = "gpt-5.2"\n\n[mcp_servers.old]\ncommand = "old"\n`,
        'utf8',
      );

      runRulerWithEnv(
        'apply codex --no-skills --output-scope user --mcp-overwrite',
        projectRoot,
        { HOME: home, XDG_CONFIG_HOME: xdg },
      );

      const updated = await readText(codexConfigPath);
      expect(updated).toContain('model = "gpt-5.2"');
      expect(updated).toContain('[mcp_servers.test_server]');
      expect(updated).not.toContain('[mcp_servers.old]');

      // Project config should not be written in user scope.
      await expect(
        fs.access(path.join(projectRoot, '.codex', 'config.toml')),
      ).rejects.toBeDefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await teardownTestProject(projectRoot);
    }
  });

  it('writes OpenCode MCP to global opencode.json', async () => {
    const { projectRoot } = await setupTestProject({
      '.ruler/AGENTS.md': '# Test Rules\n',
      '.ruler/ruler.toml': `
[mcp_servers.test_server]
command = "echo"
args = ["hello"]
`,
    });

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ruler-home-'));
    const xdg = path.join(home, '.config');

    try {
      runRulerWithEnv(
        'apply opencode --no-skills --output-scope user',
        projectRoot,
        { HOME: home, XDG_CONFIG_HOME: xdg },
      );

      const globalOpenCode = path.join(xdg, 'opencode', 'opencode.json');
      const parsed = JSON.parse(await readText(globalOpenCode)) as Record<
        string,
        unknown
      >;
      const mcp = parsed.mcp as Record<string, unknown>;
      expect(mcp).toBeDefined();
      expect(mcp).toHaveProperty('test_server');

      // Project config should not be written in user scope.
      await expect(
        fs.access(path.join(projectRoot, 'opencode.json')),
      ).rejects.toBeDefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await teardownTestProject(projectRoot);
    }
  });
});
