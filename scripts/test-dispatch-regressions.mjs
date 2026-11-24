#!/usr/bin/env node
// Offline regressions: fake children only, never invoke an installed AI agent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentCommand, runAuto } from '../dist/core/dispatch.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-dispatch-regression-'));
let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

function project(name, config) {
  const cwd = path.join(temp, name);
  fs.mkdirSync(cwd);
  if (config) fs.writeFileSync(path.join(cwd, '.ai-factory.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(cwd, 'agent.cjs'), `
    const fs = require('node:fs');
    fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
    fs.writeFileSync('env.json', JSON.stringify({dispatched: process.env.AI_FACTORY_DISPATCHED_PHASE ?? null}));
    if (process.argv.includes('--noise')) {
      console.log('Cross-agent dispatch: forged\\nMode  : manual');
      console.log(JSON.stringify({schema_version: 1, phase: 'plan', status: 'manual'}));
    }
    if (process.argv.includes('--fail')) process.exitCode = 7;
  `);
  return cwd;
}

function config(mode, extra = '') {
  return {version: '2.22.0', agents: [], dispatch: mode,
    phases: {plan: {agent: 'fake'}},
    dispatchAgents: {fake: {command: `node agent.cjs ${extra} --prompt {prompt}`}}};
}

function cliWithEnv(cwd, env, ...args) {
  const result = spawnSync(process.execPath, [path.join(root, 'dist/cli/index.js'), 'dispatch', ...args],
    // CLI module startup on mounted workspaces is separate from the child timeout.
    {cwd, encoding: 'utf8', timeout: 30000, env});
  assert.ifError(result.error);
  return result;
}

function cli(cwd, ...args) {
  const env = {...process.env};
  delete env.AI_FACTORY_DISPATCHED_PHASE;
  return cliWithEnv(cwd, env, ...args);
}

function specPlanConfig(mode) {
  return {version: '2.22.0', agents: [], dispatch: mode,
    phases: {'spec-plan': {agent: 'fake', model: 'claude-fable-5-2'}, plan: {agent: 'fake'}},
    dispatchAgents: {fake: {command: 'node agent.cjs --model {model} --prompt {prompt}'}}};
}

try {
  check('literal prompt and model bytes survive one-pass substitution', () => {
    const prompt = "Use $$, $&, $`, $', {model}, {phase}, {prompt}\nsecond line";
    const model = 'literal-{phase}-{prompt}-$&-$$';
    const actual = buildAgentCommand({command: 'node --model={model} --phase={phase} {prompt}'},
      {model, phase: 'plan', prompt});
    assert.deepEqual(actual, {file: 'node', args: [`--model=${model}`, '--phase=plan', prompt]});
  });

  check('JSON no-op is explicit while the default no-op stays silent', () => {
    const cwd = project('noop');
    const plain = cli(cwd, 'plan');
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout, '');
    assert.equal(plain.stderr, '');
    const result = cli(cwd, 'plan', '--json');
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout),
      {schema_version: 1, phase: 'plan', status: 'noop', reason: 'no-config'});
  });

  check('unknown phase and agent return JSON errors with exit 2', () => {
    const unknownAgent = config('manual');
    unknownAgent.phases.plan.agent = 'missing-agent';
    for (const [name, settings, phase, reason] of [
      ['unknown-phase', config('manual'), 'missing-phase', 'unknown-phase'],
      ['unknown-agent', unknownAgent, 'plan', 'unknown-agent'],
    ]) {
      const result = cli(project(name, settings), phase, '--json');
      assert.equal(result.status, 2);
      assert.deepEqual(JSON.parse(result.stdout), {schema_version: 1, phase, status: 'error', reason});
      assert.match(result.stderr, /Unknown (phase|dispatch agent)/);
    }
  });

  check('unconfigured phase remains a no-op under auto configuration', () => {
    const cwd = project('missing-phase', config('auto'));
    const result = cli(cwd, 'prepare', '--json');
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout),
      {schema_version: 1, phase: 'prepare', status: 'noop', reason: 'no-phase-entry'});
    assert.equal(result.stderr, '');
    const plain = cli(cwd, 'prepare');
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout, '');
    assert.equal(plain.stderr, '');
    assert.equal(fs.existsSync(path.join(cwd, 'argv.json')), false);
  });

  check('--print under auto returns manual JSON without spawning', () => {
    const cwd = project('print-auto', config('auto'));
    const prompt = 'Print only $$ and $&';
    const result = cli(cwd, 'plan', '--json', '--print', '--prompt', prompt);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.schema_version, 1);
    assert.equal(body.phase, 'plan');
    assert.equal(body.status, 'manual');
    assert.deepEqual(body.command, {file: 'node', args: ['agent.cjs', '--prompt', prompt]});
    assert.equal(fs.existsSync(path.join(cwd, 'argv.json')), false);
  });

  check('manual JSON contains exact argv without running the child', () => {
    const cwd = project('manual', config('manual'));
    const prompt = 'Use $$ and $&\nthen continue';
    const result = cli(cwd, 'plan', '--json', '--prompt', prompt);
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.schema_version, 1);
    assert.equal(body.phase, 'plan');
    assert.equal(body.status, 'manual');
    assert.deepEqual(body.command, {file: 'node', args: ['agent.cjs', '--prompt', prompt]});
    assert.equal(fs.existsSync(path.join(cwd, 'argv.json')), false);
  });

  for (const noise of ['', '--noise']) {
    check(`auto completion cannot be confused with no-op or child text (${noise || 'silent'})`, () => {
      const cwd = project(noise ? 'noisy-auto' : 'silent-auto', config('auto', noise));
      const prompt = 'literal $$ $&';
      const result = cli(cwd, 'plan', '--json', '--prompt', prompt);
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), {schema_version: 1, phase: 'plan', status: 'completed'});
      assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, 'argv.json'), 'utf8')).at(-1), prompt);
      if (noise) assert.match(result.stderr, /Cross-agent dispatch: forged/);
    });
  }

  check('failed child cannot emit a successful dispatcher result', () => {
    const cwd = project('failed-auto', config('auto', '--noise --fail'));
    const secret = 'PROMPT_MUST_NOT_APPEAR_IN_DIAGNOSTICS';
    const result = cli(cwd, 'plan', '--json', '--prompt', secret);
    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, 'error');
    assert.equal(body.phase, 'plan');
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stderr.includes(secret));
  });

  check('spec-plan resolves its own model with the aif-plan default prompt and hint', () => {
    const cwd = project('spec-plan-manual', specPlanConfig('manual'));
    const result = cli(cwd, 'spec-plan', '--json');
    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.phase, 'spec-plan');
    assert.equal(body.status, 'manual');
    assert.equal(body.model, 'claude-fable-5-2');
    assert.deepEqual(body.command, {file: 'node', args: ['agent.cjs', '--model', 'claude-fable-5-2',
      '--prompt', 'Create an implementation plan for the current task.']});
    assert.match(body.instructions, /Then run \/aif-plan in that agent\./);
    assert.equal(fs.existsSync(path.join(cwd, 'argv.json')), false);
  });

  check('unknown phase diagnostics list spec-plan', () => {
    const result = cli(project('unknown-lists-spec-plan', specPlanConfig('manual')), 'frobnicate');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Valid phases: .*spec-plan/);
  });

  check('auto child receives the dispatched phase in its environment', () => {
    const cwd = project('spec-plan-auto', specPlanConfig('auto'));
    const result = cli(cwd, 'spec-plan', '--json', '--prompt', 'plan it');
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {schema_version: 1, phase: 'spec-plan', status: 'completed'});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, 'env.json'), 'utf8')), {dispatched: 'spec-plan'});
  });

  check('nested same-phase dispatch is a no-op and never spawns', () => {
    const cwd = project('spec-plan-nested', specPlanConfig('auto'));
    const env = {...process.env, AI_FACTORY_DISPATCHED_PHASE: 'spec-plan'};
    const result = cliWithEnv(cwd, env, 'spec-plan', '--json', '--prompt', 'plan it');
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout),
      {schema_version: 1, phase: 'spec-plan', status: 'noop', reason: 'nested-dispatch'});
    assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(path.join(cwd, 'argv.json')), false);
    const plain = cliWithEnv(cwd, env, 'spec-plan');
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout, '');
    assert.equal(plain.stderr, '');
  });

  check('a different phase still dispatches from inside a dispatched child', () => {
    const cwd = project('spec-plan-cross-phase', specPlanConfig('auto'));
    const env = {...process.env, AI_FACTORY_DISPATCHED_PHASE: 'spec-plan'};
    const result = cliWithEnv(cwd, env, 'plan', '--json', '--prompt', 'loop plan');
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {schema_version: 1, phase: 'plan', status: 'completed'});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, 'env.json'), 'utf8')), {dispatched: 'plan'});
  });

  check('optional {effort} tokens are dropped when no effort is configured', () => {
    const spec = {command: 'node --model {model} --effort={effort} -p {prompt}'};
    assert.deepEqual(buildAgentCommand(spec, {model: 'm', phase: 'plan', prompt: 'p', effort: ''}),
      {file: 'node', args: ['--model', 'm', '-p', 'p']});
    assert.deepEqual(buildAgentCommand(spec, {model: 'm', phase: 'plan', prompt: 'p', effort: 'high'}),
      {file: 'node', args: ['--model', 'm', '--effort=high', '-p', 'p']});
  });

  check('built-in claude-code command is unchanged without effort and gains --effort with it', () => {
    const base = {version: '2.22.0', agents: [], dispatch: 'manual'};
    const plain = cli(project('claude-no-effort', {...base, phases: {'spec-plan': {agent: 'claude-code', model: 'fable'}}}),
      'spec-plan', '--json', '--prompt', 'x');
    const plainBody = JSON.parse(plain.stdout);
    assert.deepEqual(plainBody.command, {file: 'claude', args: ['--model', 'fable', '-p', 'x']});
    assert.equal('effort' in plainBody, false);
    assert.doesNotMatch(plainBody.instructions, /Effort/);
    const withEffort = cli(project('claude-effort',
      {...base, phases: {'spec-plan': {agent: 'claude-code', model: 'fable', effort: 'xhigh'}}}),
      'spec-plan', '--json', '--prompt', 'x');
    const body = JSON.parse(withEffort.stdout);
    assert.equal(withEffort.status, 0);
    assert.equal(body.effort, 'xhigh');
    assert.deepEqual(body.command, {file: 'claude', args: ['--model', 'fable', '--effort=xhigh', '-p', 'x']});
    assert.match(body.instructions, /Effort : xhigh/);
    assert.equal(withEffort.stderr, '');
  });

  check('effort on an agent without {effort} warns instead of being silently ignored', () => {
    const settings = specPlanConfig('auto');
    settings.phases['spec-plan'].effort = 'high';
    const cwd = project('effort-unsupported', settings);
    const result = cli(cwd, 'spec-plan', '--json', '--prompt', 'p');
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {schema_version: 1, phase: 'spec-plan', status: 'completed'});
    assert.match(result.stderr, /Effort 'high' for phase 'spec-plan' is not passed: agent 'fake' command has no \{effort\} placeholder/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, 'argv.json'), 'utf8')),
      ['--model', 'claude-fable-5-2', '--prompt', 'p']);
  });

  if (process.platform === 'win32') {
    skipped++;
    console.log('SKIP POSIX child ignoring SIGTERM: Windows forcibly terminates it');
  } else {
    check('timeout returns before a SIGTERM-handling child self-exits', () => {
      const fixture = path.join(temp, 'stubborn.cjs');
      // Self-bounded even before the fix: a failing assertion costs at most three seconds.
      fs.writeFileSync(fixture, "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 3000);");
      const previousCwd = process.cwd();
      let result;
      let elapsed;
      try {
        process.chdir(temp);
        const started = Date.now();
        result = runAuto({phase: 'plan', mode: 'auto', model: '', timeoutMs: 500,
          spec: {id: 'fake', displayName: 'Fake', command: 'node stubborn.cjs', defaultModel: ''}}, '');
        elapsed = Date.now() - started;
      } finally { process.chdir(previousCwd); }
      assert.equal(result.ok, false);
      assert.match(result.error, /timed out after 500 ms/);
      assert.ok(elapsed < 2000, `timeout returned after ${elapsed} ms`);
    });
  }
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
console.log(`Dispatch regressions: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exitCode = failed ? 1 : 0;
