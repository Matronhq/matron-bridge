import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OPS = ['start', 'post', 'update', 'join', 'get', 'close'];
const TOOLS = { mission_start: 'start', milestone_post: 'post', mission_update: 'update', mission_join: 'join', mission_get: 'get', mission_close: 'close' };

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

  it('registers the six mission tools and item_move, each posting through the loopback helper', () => {
    for (const [tool, op] of Object.entries(TOOLS)) {
      expect(askUser, `${tool} is not registered`).toContain(`'${tool}',`);
      expect(askUser, `${tool} does not go through callMissions`).toContain(`callMissions('${op}',`);
    }
    expect(askUser).toContain(`'item_move',`);
    expect(askUser).toContain(`callItems('move',`);
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
