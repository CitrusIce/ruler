import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { runRulerWithEnv, setupTestProject, teardownTestProject } from './harness';

async function readText(p: string): Promise<string> {
  return await fs.readFile(p, 'utf8');
}

describe('ruler import', () => {
  it('creates .ruler from existing MCP + skills + rules', async () => {
    const { projectRoot } = await setupTestProject({
      'AGENTS.md': '# Existing Rules\n',
      '.mcp.json': JSON.stringify(
        {
          mcpServers: {
            claude_project: {
              command: 'node',
              args: ['server.js'],
              env: { FOO: 'bar' },
            },
          },
        },
        null,
        2,
      ),
      '.claude/skills/skill-a/SKILL.md': '# Skill A\n',
      '.codex/skills/skill-b/SKILL.md': '# Skill B\n',
    });

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ruler-home-'));
    const xdg = path.join(home, '.config');

    try {
      await fs.mkdir(path.join(home, '.codex'), { recursive: true });
      await fs.writeFile(
        path.join(home, '.codex', 'config.toml'),
        `model = "gpt-5.2"\n\n[mcp_servers.codex_user]\ncommand = "python"\nargs = ["-m", "server"]\n`,
        'utf8',
      );

      const openCodeGlobal = path.join(xdg, 'opencode', 'opencode.json');
      await fs.mkdir(path.dirname(openCodeGlobal), { recursive: true });
      await fs.writeFile(
        openCodeGlobal,
        JSON.stringify(
          {
            mcp: {
              opencode_user: {
                command: ['npx', '-y', '@example/mcp-server'],
                environment: { DEBUG: '1' },
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      await fs.mkdir(path.join(home, '.agents', 'skills', 'skill-c'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(home, '.agents', 'skills', 'skill-c', 'SKILL.md'),
        '# Skill C\n',
        'utf8',
      );

      runRulerWithEnv('import --agents claude,codex,opencode', projectRoot, {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
      });

      const rulerDir = path.join(projectRoot, '.ruler');
      const agentsMd = await readText(path.join(rulerDir, 'AGENTS.md'));
      expect(agentsMd).toContain('# Existing Rules');

      const rulerToml = await readText(path.join(rulerDir, 'ruler.toml'));
      expect(rulerToml).toContain('[mcp_servers.claude_project]');
      expect(rulerToml).toContain('[mcp_servers.codex_user]');
      expect(rulerToml).toContain('[mcp_servers.opencode_user]');

      await expect(
        fs.access(path.join(rulerDir, 'skills', 'skill-a', 'SKILL.md')),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(path.join(rulerDir, 'skills', 'skill-b', 'SKILL.md')),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(path.join(rulerDir, 'skills', 'skill-c', 'SKILL.md')),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await teardownTestProject(projectRoot);
    }
  });
});
