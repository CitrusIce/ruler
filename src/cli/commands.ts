import yargs, { Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  applyClaudeHandler,
  applyCodexHandler,
  applyGenericHandler,
  applyOpenCodeHandler,
  importHandler,
  initHandler,
  revertHandler,
} from './handlers';
import {
  ApplyClaudeArgs,
  ApplyCodexArgs,
  ApplyGenericArgs,
  ApplyOpenCodeArgs,
  ImportArgs,
  InitArgs,
  RevertArgs,
} from './handlers';
import { getAgentIdentifiersForCliHelp } from '../agents/index';

/**
 * Sets up and parses CLI commands.
 */
export function run(): void {
  yargs(hideBin(process.argv))
    .scriptName('ruler-plus')
    .usage('$0 <command> [options]')
    .command<ApplyClaudeArgs>(
      'apply claude',
      'Apply configuration to Claude Code',
      (y: Argv) => {
        return y
          .option('project-root', {
            type: 'string',
            description: 'Project root directory',
            default: process.cwd(),
          })
          .option('config', {
            type: 'string',
            description: 'Path to TOML configuration file',
          })
          .option('mcp', {
            type: 'boolean',
            description: 'Enable or disable applying MCP server config',
            default: true,
          })
          .alias('mcp', 'with-mcp')
          .option('mcp-overwrite', {
            type: 'boolean',
            description: 'Replace (not merge) the native MCP config(s)',
            default: false,
          })
          .option('gitignore', {
            type: 'boolean',
            description:
              'Enable/disable automatic .gitignore updates (default: enabled)',
          })
          .option('verbose', {
            type: 'boolean',
            description: 'Enable verbose logging',
            default: false,
          })
          .alias('verbose', 'v')
          .option('dry-run', {
            type: 'boolean',
            description: 'Preview changes without writing files',
            default: false,
          })
          .option('local-only', {
            type: 'boolean',
            description:
              'Only search for local .ruler directories, ignore global config',
            default: false,
          })
          .option('nested', {
            type: 'boolean',
            description:
              'Enable nested rule loading from nested .ruler directories (default: from config or disabled)',
          })
          .option('backup', {
            type: 'boolean',
            description:
              'Enable/disable creation of .bak backup files (default: enabled)',
            default: true,
          })
          .option('skills', {
            type: 'boolean',
            description:
              'Enable/disable skills support (experimental, default: enabled)',
          })
          .option('output-scope', {
            type: 'string',
            description:
              'Where to write generated MCP/skills outputs: project (default), user, or both',
            choices: ['project', 'user', 'both'],
            default: 'project',
          })
          .option('model', {
            type: 'string',
            description:
              'Claude model name (writes to ~/.claude/settings.json)',
          })
          .option('base-url', {
            type: 'string',
            description:
              'Anthropic base URL (writes to ~/.claude/settings.json env)',
          })
          .option('auth-token', {
            type: 'string',
            description:
              'Anthropic auth token value (writes to ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN)',
          })
          .option('api-key', {
            type: 'string',
            description:
              'Anthropic API key value (writes to ~/.claude/settings.json env.ANTHROPIC_API_KEY)',
          });
      },
      applyClaudeHandler,
    )
    .command<ApplyCodexArgs>(
      'apply codex',
      'Apply configuration to OpenAI Codex CLI',
      (y: Argv) => {
        return y
          .option('project-root', {
            type: 'string',
            description: 'Project root directory',
            default: process.cwd(),
          })
          .option('config', {
            type: 'string',
            description: 'Path to TOML configuration file',
          })
          .option('mcp', {
            type: 'boolean',
            description: 'Enable or disable applying MCP server config',
            default: true,
          })
          .alias('mcp', 'with-mcp')
          .option('mcp-overwrite', {
            type: 'boolean',
            description: 'Replace (not merge) the native MCP config(s)',
            default: false,
          })
          .option('gitignore', {
            type: 'boolean',
            description:
              'Enable/disable automatic .gitignore updates (default: enabled)',
          })
          .option('verbose', {
            type: 'boolean',
            description: 'Enable verbose logging',
            default: false,
          })
          .alias('verbose', 'v')
          .option('dry-run', {
            type: 'boolean',
            description: 'Preview changes without writing files',
            default: false,
          })
          .option('local-only', {
            type: 'boolean',
            description:
              'Only search for local .ruler directories, ignore global config',
            default: false,
          })
          .option('nested', {
            type: 'boolean',
            description:
              'Enable nested rule loading from nested .ruler directories (default: from config or disabled)',
          })
          .option('backup', {
            type: 'boolean',
            description:
              'Enable/disable creation of .bak backup files (default: enabled)',
            default: true,
          })
          .option('skills', {
            type: 'boolean',
            description:
              'Enable/disable skills support (experimental, default: enabled)',
          })
          .option('output-scope', {
            type: 'string',
            description:
              'Where to write generated MCP/skills outputs: project (default), user, or both',
            choices: ['project', 'user', 'both'],
            default: 'project',
          })
          .option('model', {
            type: 'string',
            description: 'Codex model name (writes to .codex/config.toml)',
          })
          .option('model-provider', {
            type: 'string',
            description:
              'Codex model provider name (writes to .codex/config.toml)',
          })
          .option('openai-api-key', {
            type: 'string',
            description:
              'OpenAI API key (writes to ~/.codex/auth.json OPENAI_API_KEY)',
          });
      },
      applyCodexHandler,
    )
    .command<ApplyOpenCodeArgs>(
      'apply opencode',
      'Apply configuration to OpenCode',
      (y: Argv) => {
        return y
          .option('project-root', {
            type: 'string',
            description: 'Project root directory',
            default: process.cwd(),
          })
          .option('config', {
            type: 'string',
            description: 'Path to TOML configuration file',
          })
          .option('mcp', {
            type: 'boolean',
            description: 'Enable or disable applying MCP server config',
            default: true,
          })
          .alias('mcp', 'with-mcp')
          .option('mcp-overwrite', {
            type: 'boolean',
            description: 'Replace (not merge) the native MCP config(s)',
            default: false,
          })
          .option('gitignore', {
            type: 'boolean',
            description:
              'Enable/disable automatic .gitignore updates (default: enabled)',
          })
          .option('verbose', {
            type: 'boolean',
            description: 'Enable verbose logging',
            default: false,
          })
          .alias('verbose', 'v')
          .option('dry-run', {
            type: 'boolean',
            description: 'Preview changes without writing files',
            default: false,
          })
          .option('local-only', {
            type: 'boolean',
            description:
              'Only search for local .ruler directories, ignore global config',
            default: false,
          })
          .option('nested', {
            type: 'boolean',
            description:
              'Enable nested rule loading from nested .ruler directories (default: from config or disabled)',
          })
          .option('backup', {
            type: 'boolean',
            description:
              'Enable/disable creation of .bak backup files (default: enabled)',
            default: true,
          })
          .option('skills', {
            type: 'boolean',
            description:
              'Enable/disable skills support (experimental, default: enabled)',
          })
          .option('output-scope', {
            type: 'string',
            description:
              'Where to write generated MCP/skills outputs: project (default), user, or both',
            choices: ['project', 'user', 'both'],
            default: 'project',
          })
          .option('model', {
            type: 'string',
            description: 'OpenCode model (provider/model)',
          })
          .option('small-model', {
            type: 'string',
            description: 'OpenCode small_model (provider/model)',
          });
      },
      applyOpenCodeHandler,
    )
    .command<ApplyGenericArgs>(
      'apply <agent>',
      'Apply configuration to a single AI agent (no model-specific overrides)',
      (y: Argv) => {
        return y
          .positional('agent', {
            type: 'string',
            description: 'Agent identifier (e.g. claude, codex, opencode)',
          })
          .option('project-root', {
            type: 'string',
            description: 'Project root directory',
            default: process.cwd(),
          })
          .option('config', {
            type: 'string',
            description: 'Path to TOML configuration file',
          })
          .option('mcp', {
            type: 'boolean',
            description: 'Enable or disable applying MCP server config',
            default: true,
          })
          .alias('mcp', 'with-mcp')
          .option('mcp-overwrite', {
            type: 'boolean',
            description: 'Replace (not merge) the native MCP config(s)',
            default: false,
          })
          .option('gitignore', {
            type: 'boolean',
            description:
              'Enable/disable automatic .gitignore updates (default: enabled)',
          })
          .option('verbose', {
            type: 'boolean',
            description: 'Enable verbose logging',
            default: false,
          })
          .alias('verbose', 'v')
          .option('dry-run', {
            type: 'boolean',
            description: 'Preview changes without writing files',
            default: false,
          })
          .option('local-only', {
            type: 'boolean',
            description:
              'Only search for local .ruler directories, ignore global config',
            default: false,
          })
          .option('nested', {
            type: 'boolean',
            description:
              'Enable nested rule loading from nested .ruler directories (default: from config or disabled)',
          })
          .option('backup', {
            type: 'boolean',
            description:
              'Enable/disable creation of .bak backup files (default: enabled)',
            default: true,
          })
          .option('skills', {
            type: 'boolean',
            description:
              'Enable/disable skills support (experimental, default: enabled)',
          })
          .option('output-scope', {
            type: 'string',
            description:
              'Where to write generated MCP/skills outputs: project (default), user, or both',
            choices: ['project', 'user', 'both'],
            default: 'project',
          });
      },
      applyGenericHandler,
    )
    .command<InitArgs>(
      'init',
      'Scaffold a .ruler directory with default files',
      (y: Argv) => {
        return y
          .option('project-root', {
            type: 'string',
            description: 'Project root directory',
            default: process.cwd(),
          })
          .option('global', {
            type: 'boolean',
            description:
              'Initialize in global config directory (XDG_CONFIG_HOME/ruler)',
            default: false,
          });
      },
      initHandler,
    )
    .command<ImportArgs>(
      'import',
      'Import existing agent MCP/skills/rules into a new .ruler directory',
      (y: Argv) => {
        return y
          .option('project-root', {
            type: 'string',
            description: 'Project root directory',
            default: process.cwd(),
          })
          .option('agents', {
            type: 'string',
            description:
              'Comma-separated list of agent identifiers to import (claude,codex,opencode). Default: all three.',
          });
      },
      importHandler,
    )
    .command<RevertArgs>(
      'revert',
      'Revert ruler configurations from supported AI agents',
      (y: Argv) => {
        return y
          .option('project-root', {
            type: 'string',
            description: 'Project root directory',
            default: process.cwd(),
          })
          .option('agents', {
            type: 'string',
            description: `Comma-separated list of agent identifiers: ${getAgentIdentifiersForCliHelp()}`,
          })
          .option('config', {
            type: 'string',
            description: 'Path to TOML configuration file',
          })
          .option('keep-backups', {
            type: 'boolean',
            description: 'Keep backup files after revert',
            default: false,
          })
          .option('verbose', {
            type: 'boolean',
            description: 'Enable verbose logging',
            default: false,
          })
          .alias('verbose', 'v')
          .option('dry-run', {
            type: 'boolean',
            description: 'Preview changes without writing files',
            default: false,
          })
          .option('local-only', {
            type: 'boolean',
            description:
              'Only search for local .ruler directories, ignore global config',
            default: false,
          });
      },
      revertHandler,
    )
    .demandCommand(1, 'You need to specify a command')
    .help()
    .strict()
    .parse();
}
