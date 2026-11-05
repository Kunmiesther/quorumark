// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveStrategyTurtle } from './strategyOwnership';
import { authorizePaperCandidate } from './paperAuthorization';

describe('strategy execution ownership', () => {
  it.each([
    [['accumulator'], 'accumulator'], [['sniper'], 'sniper'],
    [['accumulator', 'sniper'], 'sniper'], [['sweep'], null], [['hunter'], null],
  ] as const)('resolves Sweep within selected turtles %j', (enabled, owner) => {
    expect(resolveStrategyTurtle('sweep', enabled)).toBe(owner);
  });
  it('records Accumulator ownership without renaming the strategy', () => {
    const route = {workflowId:'plan',connectionId:'exchange',symbol:'BTC-USDT',turtles:['accumulator']};
    expect(authorizePaperCandidate(true,[route],'BTC-USDT','sweep')).toMatchObject({allowed:true,executingTurtle:'accumulator',route});
    expect(authorizePaperCandidate(true,[route,{...route,workflowId:'other',turtles:['sniper']}],'BTC-USDT','sweep')).toMatchObject({allowed:false,reason:'ambiguous_plan_route'});
  });
  it('enforces selected ownership through the actual PostgreSQL entry trigger', () => {
    const output = execFileSync(process.execPath, [resolve('scripts/test-autopilot-isolation.mjs'),resolve('node_modules/@electric-sql/pglite/dist/index.js')],{encoding:'utf8'});
    expect(output).toContain('PASS:');
  },30000);
});
