/**
 * Agent cache commands — extracted for forge-tools.cjs
 *
 * Subcommands: list, show <task-id>, invalidate [--all], rebuild <task-id>
 */

const path = require('path');
const { output, error, getForgeRoot } = require('./core.cjs');

function getAgentCache() {
  return require(path.join(getForgeRoot(), 'forge-agents', 'cache'));
}

function getFactory() {
  return require(path.join(getForgeRoot(), 'forge-agents', 'factory'));
}

async function handleAgents(cwd, args, raw) {
  const sub = args[0] || 'list';

  switch (sub) {
    case 'list': {
      const cache = getAgentCache();
      const agents = cache.listAgents(cwd);

      if (agents.length === 0) {
        output({ agents: [], count: 0, message: 'No cached agents. Run factory build to populate.' }, raw);
        return;
      }

      output({
        agents: agents.map(a => ({
          task_id: a.task_id,
          archetype: a.archetype,
          plan_path: a.plan_path,
          phase: a.phase,
          modules: a.modules,
          risk: a.risk,
          stale: a.stale,
          created: a.created,
          last_used: a.last_used,
        })),
        count: agents.length,
        fresh: agents.filter(a => !a.stale).length,
        stale: agents.filter(a => a.stale).length,
      }, raw);
      break;
    }

    case 'show': {
      const taskId = args[1];
      if (!taskId) {
        error('task-id required: forge-tools agents show <task-id>');
      }

      const cache = getAgentCache();
      const result = cache.showAgent(cwd, taskId);

      if (!result.found) {
        error(`Agent not found in cache: ${taskId}`);
      }

      output({
        task_id: taskId,
        stale: result.meta.stale,
        meta: result.meta,
        agent_config: {
          archetype: result.config.agentConfig?.archetype,
          archetype_reason: result.config.agentConfig?.archetype_reason,
          verification_steps: result.config.agentConfig?.verification_steps,
          capabilities: result.config.agentConfig?.capabilities,
          plan_meta: result.config.agentConfig?.plan_meta,
          context_files: {
            always_load: result.config.agentConfig?.context?.always_load?.length || 0,
            task_specific: result.config.agentConfig?.context?.task_specific?.length || 0,
            reference: result.config.agentConfig?.context?.reference?.length || 0,
          },
          system_prompt_length: result.config.agentConfig?.system_prompt?.length || 0,
        },
        analysis: result.config.analysis,
      }, raw);
      break;
    }

    case 'invalidate': {
      const cache = getAgentCache();

      if (args.includes('--all')) {
        const count = cache.clearAll(cwd);
        output({ cleared: count, message: `Cleared all ${count} cached agent(s)` }, raw);
      } else if (args[1] && !args[1].startsWith('--')) {
        const taskId = args[1];
        const existed = cache.invalidateOne(cwd, taskId);
        output({
          task_id: taskId,
          removed: existed,
          message: existed ? `Removed cached agent: ${taskId}` : `Agent not in cache: ${taskId}`,
        }, raw);
      } else {
        const removed = cache.invalidateStale(cwd);
        output({ removed, message: `Removed ${removed} stale agent(s)` }, raw);
      }
      break;
    }

    case 'rebuild': {
      const taskId = args[1];
      if (!taskId) {
        error('task-id required: forge-tools agents rebuild <task-id>');
      }

      const cache = getAgentCache();
      const agentInfo = cache.showAgent(cwd, taskId);
      if (!agentInfo.found) {
        error(`Agent not found in cache: ${taskId}`);
      }

      const planPath = agentInfo.meta.plan_path;
      const absPath = path.isAbsolute(planPath) ? planPath : path.join(cwd, planPath);

      const fs = require('fs');
      if (!fs.existsSync(absPath)) {
        error(`Plan file no longer exists: ${absPath}`);
      }

      // Force rebuild by skipping cache
      const factory = getFactory();
      const result = factory.buildAgentConfig(absPath, cwd, { taskId, skipCache: true });

      output({
        task_id: taskId,
        rebuilt: true,
        archetype: result.agentConfig.archetype,
        archetype_reason: result.agentConfig.archetype_reason,
        risk: result.analysis.risk.level,
        modules: result.analysis.affectedModules,
      }, raw);
      break;
    }

    default:
      error(`Unknown agents subcommand: ${sub}. Available: list, show, invalidate, rebuild`);
  }
}

module.exports = { handleAgents };
