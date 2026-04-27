#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PROVIDERS = {
  claude: {
    label: 'Claude Code',
    binary: 'claude',
    container_supported: true,
    commonPaths: [
      path.join(os.homedir(), '.claude', 'local', 'claude'),
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ],
  },
  codex: {
    label: 'Codex',
    binary: 'codex',
    container_supported: false,
    commonPaths: [
      '/Applications/Codex.app/Contents/Resources/codex',
      path.join(os.homedir(), '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    ],
  },
};

function loadConfig(cwd) {
  if (!cwd) return null;
  try {
    return require('../forge-config/config').loadConfig(cwd).config;
  } catch {
    return null;
  }
}

function normalizeProviderName(name) {
  if (!name) return 'auto';
  const normalized = String(name).trim().toLowerCase();
  return PROVIDERS[normalized] ? normalized : 'auto';
}

function inferProviderFromInstallPath() {
  const hints = [__dirname, process.argv[1] || '', process.env.PWD || ''];
  for (const hint of hints) {
    if (!hint) continue;
    if (hint.includes(`${path.sep}.codex${path.sep}`)) return 'codex';
    if (hint.includes(`${path.sep}.claude${path.sep}`)) return 'claude';
  }
  return null;
}

function providerPreference(cwd, opts = {}) {
  const optionProvider = normalizeProviderName(opts.provider);
  const envProvider = normalizeProviderName(process.env.FORGE_AGENT_PROVIDER);
  const configProvider = normalizeProviderName(loadConfig(cwd)?.agents?.provider);
  const pathProvider = normalizeProviderName(inferProviderFromInstallPath());
  const explicit = optionProvider !== 'auto'
    ? optionProvider
    : envProvider !== 'auto'
      ? envProvider
      : configProvider !== 'auto'
        ? configProvider
        : pathProvider;

  if (explicit !== 'auto') return [explicit];
  if (inferProviderFromInstallPath() === 'codex') return ['codex', 'claude'];
  return ['claude', 'codex'];
}

function findProviderBinary(providerName) {
  const provider = PROVIDERS[providerName];
  if (!provider) return null;

  try {
    const which = execSync(`which ${provider.binary}`, {
      stdio: 'pipe',
      timeout: 5000,
      encoding: 'utf8',
    }).trim();
    if (which) return which;
  } catch { /* not in PATH */ }

  for (const candidate of provider.commonPaths) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function checkProvider(providerName) {
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return { name: providerName, label: providerName, available: false, path: null, version: null, container_supported: false };
  }

  const binaryPath = findProviderBinary(providerName);
  if (!binaryPath) {
    return {
      name: providerName,
      label: provider.label,
      available: false,
      path: null,
      version: null,
      container_supported: provider.container_supported,
    };
  }

  try {
    const version = execSync(`"${binaryPath}" --version 2>/dev/null`, {
      stdio: 'pipe',
      timeout: 10000,
      encoding: 'utf8',
    }).trim();
    return {
      name: providerName,
      label: provider.label,
      available: true,
      path: binaryPath,
      version: version || 'unknown',
      container_supported: provider.container_supported,
    };
  } catch {
    return {
      name: providerName,
      label: provider.label,
      available: true,
      path: binaryPath,
      version: 'unknown',
      container_supported: provider.container_supported,
    };
  }
}

function resolveProvider(cwd, opts = {}) {
  const preference = providerPreference(cwd, opts);
  for (const name of preference) {
    const checked = checkProvider(name);
    if (checked.available) return checked;
  }
  return checkProvider(preference[0] || 'claude');
}

function buildInvocation(providerName, prompt, opts = {}) {
  const outputFile = opts.outputFile || null;
  const model = opts.model || null;

  if (providerName === 'codex') {
    const args = ['exec', '--full-auto', '--skip-git-repo-check'];
    if (model) args.push('-m', model);
    if (outputFile) args.push('-o', outputFile);
    args.push('-');
    return {
      args,
      stdin: prompt,
      outputFile,
      env: {
        ...process.env,
        TERM: 'dumb',
      },
    };
  }

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '-p', prompt,
    '--allowedTools', opts.allowedTools || 'Bash,Read,Write,Edit,Glob,Grep',
  ];
  if (model && model !== 'inherit') {
    args.splice(3, 0, '--model', model);
  }
  return {
    args,
    stdin: null,
    outputFile,
    env: {
      ...process.env,
      TERM: 'dumb',
      CLAUDE_CODE_ENTRYPOINT: opts.entrypoint || process.env.CLAUDE_CODE_ENTRYPOINT,
    },
  };
}

module.exports = {
  PROVIDERS,
  normalizeProviderName,
  inferProviderFromInstallPath,
  providerPreference,
  findProviderBinary,
  checkProvider,
  resolveProvider,
  buildInvocation,
};
