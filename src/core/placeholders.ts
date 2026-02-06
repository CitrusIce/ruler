import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { parse as parseTOML } from '@iarna/toml';

type SecretsFile = {
  secrets?: Record<string, unknown>;
};

export async function readRulerSecrets(
  projectRoot: string,
): Promise<Record<string, string>> {
  const secretsPath = path.join(projectRoot, '.ruler', 'secrets.toml');
  try {
    const raw = await fs.readFile(secretsPath, 'utf8');
    const parsed = (raw.trim() ? parseTOML(raw) : {}) as unknown as SecretsFile;
    const secrets =
      parsed.secrets && typeof parsed.secrets === 'object'
        ? (parsed.secrets as Record<string, unknown>)
        : {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(secrets)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolves placeholders:
 * - {env:NAME} -> process.env.NAME
 * - {secret:NAME} -> value from .ruler/secrets.toml ([secrets] NAME = "...")
 */
export async function resolvePlaceholderString(
  value: string,
  projectRoot: string,
): Promise<string | null> {
  const envMatch = value.match(/^\{env:([^}]+)\}$/);
  if (envMatch) {
    const name = envMatch[1];
    const v = process.env[name];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  const secretMatch = value.match(/^\{secret:([^}]+)\}$/);
  if (secretMatch) {
    const name = secretMatch[1];
    const secrets = await readRulerSecrets(projectRoot);
    const v = secrets[name];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  // Literal value.
  return value;
}

export function getUserClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function getUserCodexAuthPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}
