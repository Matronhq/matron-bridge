import { describe, it, expect } from 'vitest';
import { missionLine, formatStartAck, formatMilestoneAck, formatMissionDetail, formatBlocked } from '../lib/missions-format.js';

const mission = { id: 'ms_1', num: 61, title: 'Missions', state: 'open', body: 'Ship it', open_items: 2, needs_you: 1, conversations: 3, milestones: 5 };

describe('missions-format', () => {
  it('missionLine carries number, title, state and counts', () => {
    expect(missionLine(mission)).toBe('#61 Missions — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)');
    expect(missionLine({ ...mission, state: 'closed', open_items: 0, needs_you: 0, closed_by: 'agent' })).toBe('#61 Missions — closed by agent, 0 open items, 3 conversations, 5 milestones (id ms_1)');
    expect(missionLine(null)).toBe('(unknown mission)');
  });
  it('start ack distinguishes new from existing', () => {
    expect(formatStartAck({ mission })).toBe('Started mission #61 "Missions" (id ms_1)');
    expect(formatStartAck({ mission, existing: true })).toBe('Already in mission #61 "Missions" — nothing changed (id ms_1)');
  });
  it('milestone ack names both numbers', () => {
    expect(formatMilestoneAck({ milestone: { num: 63, kind: 'progress', title: 'Landed PR' }, mission })).toBe('Milestone #63 posted to mission #61 "Missions"');
  });
  it('detail lists milestones newest first, open items, conversations', () => {
    const out = formatMissionDetail({
      mission,
      milestones: [{ num: 63, kind: 'progress', title: 'Landed', created_at: 1700000000000, convo_id: 'c1' }],
      items: [{ num: 64, title: 'Q?', awaiting: 'user' }, { num: 65, title: 'T', awaiting: 'agent' }],
      conversations: [{ id: 'c1', title: 'Session', box: 'dev-2', state: 'running' }],
    });
    expect(out.split('\n')).toEqual([
      '#61 Missions — open, 2 open items (1 need you), 3 conversations, 5 milestones (id ms_1)',
      'Ship it', '',
      'Milestones (newest first):',
      '- #63 [progress] Landed — 2023-11-14T22:13:20.000Z in c1',
      'Open items:',
      '- #64 Q? — awaiting user',
      '- #65 T — awaiting agent',
      'Conversations:',
      '- c1 Session (dev-2, running)',
    ]);
  });
  it('blocked renders every 409 reason as an instruction', () => {
    expect(formatBlocked({ error: 'conflict', blocked_by: 'no_mission' })).toMatch(/call mission_start\(title, body\) first/);
    expect(formatBlocked({ error: 'conflict', blocked_by: 'closed' })).toMatch(/closed/);
    expect(formatBlocked({ error: 'conflict', blocked_by: 'user_items', items: [{ num: 64, title: 'Q?' }] })).toBe('blocked by items awaiting the user: #64 Q? — only the user can clear those');
    expect(formatBlocked({ error: 'conflict', blocked_by: 'agent_items', items: [{ num: 71, title: 'T' }] })).toBe('blocked by open items: #71 T — close each with a real resolution (item_close), or item_move it to the mission it belongs to');
    expect(formatBlocked({ error: 'conflict', blocked_by: 'other_mission' })).toMatch(/another mission/);
    expect(formatBlocked({ error: 'weird' })).toBe('weird');
  });
});
