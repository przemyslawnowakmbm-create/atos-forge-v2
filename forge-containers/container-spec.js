#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// Container Spec Builder
// ============================================================

/**
 * Build a container specification for a forge agent.
 *
 * @param {object} params
 * @param {string} params.taskId - Unique task/sub-plan identifier.
 * @param {string} params.cwd - Project root.
 * @param {string} params.worktreePath - Git worktree path.
 * @param {string} params.outputDir - Host output directory.
 * @param {object} params.agentConfig - Agent JSON (system prompt, task, graph context, ledger entries).
 * @param {object} params.resourceConfig - Resolved container config.
 * @param {object} [params.opts] - Optional overrides.
 * @param {string} [params.opts.image] - Docker image (default: auto-detect from stack).
 * @param {string} [params.opts.dockerfile] - Dockerfile template name.
 * @param {string[]} [params.opts.extraVolumes] - Additional volume mounts.
 * @param {object} [params.opts.env] - Extra environment variables.
 * @returns {ContainerSpec}
 */
function buildSpec(params) {
  const { taskId, cwd, worktreePath, outputDir, agentConfig, resourceConfig, opts = {} } = params;
  const containerId = `forge-${taskId}-${crypto.randomBytes(3).toString('hex')}`;

  const image = opts.image || selectImage(cwd, opts.dockerfile);
  const dbPath = path.join(cwd, '.forge', 'graph.db');
  const knowledgeDir = path.join(cwd, '.forge', 'knowledge');
  const configDir = path.join(outputDir, 'config');

  // Write agent config to the config mount
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'agent.json'),
    JSON.stringify(agentConfig, null, 2)
  );

  // Volume mounts
  const volumes = [
    { host: worktreePath, container: '/repo', mode: 'ro' },
    { host: outputDir, container: '/output', mode: 'rw' },
    { host: configDir, container: '/config', mode: 'ro' },
  ];

  // Graph DB mount (optional — may not exist)
  if (fs.existsSync(dbPath)) {
    volumes.push({ host: dbPath, container: '/graph/graph.db', mode: 'ro' });
  }

  // System graph mount (cross-repo context — optional)
  const systemDbPath = agentConfig?.system_context?.system_db_path
    || path.join(cwd, '.forge', 'system-graph.db');
  if (fs.existsSync(systemDbPath)) {
    volumes.push({ host: systemDbPath, container: '/graph/system-graph.db', mode: 'ro' });
  }

  // Knowledge directory (created on demand)
  fs.mkdirSync(knowledgeDir, { recursive: true });
  volumes.push({ host: knowledgeDir, container: '/knowledge', mode: 'rw' });

  // Mount Claude CLI binary + config (required for agent to call Anthropic API)
  const home = require('os').homedir();
  const claudeConfigDir = path.join(home, '.claude');

  // Resolve the actual Claude CLI binary (follow symlinks)
  const claudeSymlink = path.join(home, '.local', 'bin', 'claude');
  let claudeBinaryPath = null;
  try {
    claudeBinaryPath = fs.realpathSync(claudeSymlink);
  } catch { /* not found */ }

  // Mount the resolved binary directly to /usr/local/bin/claude
  if (claudeBinaryPath && fs.existsSync(claudeBinaryPath)) {
    volumes.push({ host: claudeBinaryPath, container: '/usr/local/bin/claude', mode: 'ro' });
  }
  // Claude config (API keys, settings)
  if (fs.existsSync(claudeConfigDir)) {
    volumes.push({ host: claudeConfigDir, container: '/home/forge/.claude', mode: 'ro' });
  }

  // Extra volumes from opts
  if (opts.extraVolumes) {
    for (const v of opts.extraVolumes) {
      volumes.push(v);
    }
  }

  // Environment variables
  const env = {
    FORGE_TASK_ID: taskId,
    FORGE_CONTAINER_ID: containerId,
    FORGE_REPO_PATH: '/repo',
    FORGE_OUTPUT_PATH: '/output',
    FORGE_CONFIG_PATH: '/config/agent.json',
    FORGE_GRAPH_PATH: fs.existsSync(dbPath) ? '/graph/graph.db' : '',
    FORGE_SYSTEM_GRAPH_PATH: fs.existsSync(systemDbPath) ? '/graph/system-graph.db' : '',
    FORGE_KNOWLEDGE_PATH: '/knowledge',
    NODE_ENV: 'production',
    HOME: '/home/forge',
    ...(opts.env || {}),
  };

  return {
    id: containerId,
    taskId,
    image,
    mode: opts.mode || 'agent', // 'agent' or 'verify'
    volumes,
    env,
    memory: resourceConfig.max_memory_per_container_str,
    cpus: String(resourceConfig.max_cpu_per_container),
    timeout: resourceConfig.timeout_seconds,
    workdir: '/repo',
    // Metadata for lifecycle tracking
    _meta: {
      cwd,
      worktreePath,
      outputDir,
      configDir,
      createdAt: new Date().toISOString(),
    },
  };
}

// ============================================================
// Image Selection
// ============================================================

/**
 * Select the appropriate Docker image based on project stack.
 */
function selectImage(cwd, dockerfileName) {
  if (dockerfileName) {
    return `forge-agent:${dockerfileName.replace('Dockerfile.', '')}`;
  }

  // Auto-detect from project files
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  const hasPyProject = fs.existsSync(path.join(cwd, 'pyproject.toml'))
    || fs.existsSync(path.join(cwd, 'requirements.txt'))
    || fs.existsSync(path.join(cwd, 'setup.py'));
  const hasDockerCompose = fs.existsSync(path.join(cwd, 'docker-compose.yml'))
    || fs.existsSync(path.join(cwd, 'docker-compose.yaml'));

  // Full-stack if both or docker-compose present
  if ((hasPackageJson && hasPyProject) || hasDockerCompose) {
    return 'forge-agent:full';
  }
  if (hasPyProject) return 'forge-agent:python';
  return 'forge-agent:node'; // default
}

/**
 * Convert a ContainerSpec into `docker run` arguments.
 */
function toDockerArgs(spec) {
  const args = [
    'run',
    '--rm',
    '--name', spec.id,
    '--memory', spec.memory,
    '--cpus', spec.cpus,
    '--workdir', spec.workdir,
    // Run as host user so mounted volume permissions match
    '--user', `${process.getuid()}:${process.getgid()}`,
  ];

  // Volumes
  for (const v of spec.volumes) {
    const mode = v.mode || 'rw';
    args.push('-v', `${v.host}:${v.container}:${mode}`);
  }

  // Environment
  for (const [key, val] of Object.entries(spec.env)) {
    if (val !== undefined && val !== '') {
      args.push('-e', `${key}=${val}`);
    }
  }

  // Image — entrypoint is baked in (agent-entrypoint.js or agent-verifier.js)
  // Override entrypoint for verifier mode
  if (spec.mode === 'verify') {
    args.push('--entrypoint', 'node');
    args.push(spec.image);
    args.push('/entrypoint/agent-verifier.js');
  } else {
    args.push(spec.image);
    // Default ENTRYPOINT in Dockerfile runs agent-entrypoint.js
  }

  return args;
}

/**
 * Build the Dockerfile path for a given template name.
 */
function dockerfilePath(templateName) {
  return path.join(__dirname, 'templates', `Dockerfile.${templateName}`);
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  buildSpec,
  selectImage,
  toDockerArgs,
  dockerfilePath,
};
