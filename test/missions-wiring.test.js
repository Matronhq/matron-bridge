import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OPS = ['start', 'post', 'update', 'join', 'get', 'close'];
const TOOL_CALLS = {
  mission_start: "callMissions('start', args, formatStartAck)",
  milestone_post: "callMissions('post', args, formatMilestoneAck)",
  mission_update: "callMissions('update', args, (d) => missionLine(d.mission))",
  mission_join: "callMissions('join', args, (d) => missionLine(d.mission))",
  mission_get: "callMissions('get', args, formatMissionDetail)",
  mission_close: "callMissions('close', args, (d) => missionLine(d.mission))",
  item_move: "callItems('move', args, (d) => itemLine(d.item))",
};

describe('missions wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const claudeMd = readFileSync(new URL('../BRIDGE_CLAUDE.md', import.meta.url), 'utf8');
  const codexMd = readFileSync(new URL('../BRIDGE_CODEX.md', import.meta.url), 'utf8');

  it('mounts all six /missions routes through the shared handler map', () => {
    const m = index.match(/url\.pathname\.match\(\/\^\\\/missions\\\/\(([a-z|]+)\)\$\/\)/);
    expect(m, 'the /missions route matcher is missing from index.js').toBeTruthy();
    expect(m[1].split('|').sort()).toEqual([...OPS].sort());
    expect(index).toContain('missionsHandlers[name]');
    expect(index).toMatch(/createMissionsHandlers\(\{\s*sessions,\s*journalConvoIdFor,\s*client: missionsClient,?\s*\}\)/);
  });

  it('registers the six mission tools and item_move, each pinned to its exact renderer', () => {
    for (const [tool, call] of Object.entries(TOOL_CALLS)) {
      expect(askUser, `${tool} is not registered`).toContain(`'${tool}',`);
      expect(askUser, `${tool} does not go through ${call}`).toContain(call);
    }
  });

  it('no mission or item_move tool schema takes a convo_id parameter', () => {
    expect(askUser).not.toMatch(/(?<!\w)convo_id:\s*z\./);
  });

  it('both prompt files carry the missions section', () => {
    expect(claudeMd).toMatch(/^## Missions & milestones/m);
    expect(claudeMd).toMatch(/mission_start/);
    expect(claudeMd).toMatch(/kind: "user_input"/);
    expect(claudeMd).toMatch(/refused until the conversation has a mission/);
    expect(codexMd).toMatch(/^## Missions & milestones/m);
    expect(codexMd).toMatch(/POST \$BASE\/milestones/);
  });
});
