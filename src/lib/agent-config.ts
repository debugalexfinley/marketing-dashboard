import { getInstance } from './instances';
import { getOpenClawAgents } from './backend/openclaw';

export type { AgentDefinition, AgentSkill, CronJob } from './backend/types';
export { ACTION_TO_AGENT } from './backend/openclaw';

/** @deprecated Routes should use resolveBackend(instanceId).listAgents(). */
export function getAgents(instanceId?: string) {
  // Keep the pre-extraction configured-list precedence until routes migrate.
  return getOpenClawAgents(getInstance(instanceId), false);
}

/** @deprecated Routes should use resolveBackend(instanceId).listAgents(). */
export function getAgentIds(instanceId?: string): string[] {
  return getAgents(instanceId).map((agent) => agent.id);
}

/** @deprecated Routes should use resolveBackend(instanceId).listAgents(). */
export function getAgent(instanceId: string | undefined, id: string) {
  return getAgents(instanceId).find((agent) => agent.id === id);
}
