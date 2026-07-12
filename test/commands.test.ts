import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';

import {
  arenaRunConfigFromOptions,
  buildProgram,
  type ArenaRunCliOptions,
} from '../src/commands.js';
import { publishTarget, resolveApiConfig } from '../src/publish.js';
import { ENGINE_VERSION } from '../src/version.js';

function overrideExits(command: Command): Command {
  command.exitOverride();
  for (const child of command.commands) overrideExits(child);
  return command;
}

describe('CLI contract', () => {
  it('derives its public identity from package metadata', () => {
    const program = overrideExits(
      buildProgram({
        stdout() {},
        stderr() {},
      }),
    );
    expect(program.name()).toBe('bridgebench');
    expect(program.version()).toBe(ENGINE_VERSION);
    expect(program.helpInformation()).toContain('Autonomous BridgeBench arenas');
  });

  it('requires an explicit category selection for publishing', async () => {
    const program = overrideExits(
      buildProgram({
        stdout() {},
        stderr() {},
      }),
    );
    await expect(program.parseAsync(['node', 'bridgebench', 'tasks', 'publish'])).rejects.toThrow(
      /requires --category <category> or --all/,
    );
  });

  it('uses Commander argument errors for invalid options', async () => {
    const program = overrideExits(
      buildProgram({
        stdout() {},
        stderr() {},
      }),
    );
    await expect(
      program.parseAsync([
        'node',
        'bridgebench',
        'arena',
        'run',
        '--category',
        'reasoning',
        '--matches',
        'zero',
      ]),
    ).rejects.toMatchObject({ code: 'commander.invalidArgument' });
  });

  it('collects repeatable competitor roster flags', () => {
    const program = overrideExits(
      buildProgram({
        stdout() {},
        stderr() {},
      }),
    );
    const arena = program.commands.find((command) => command.name() === 'arena')!;
    const run = arena.commands.find((command) => command.name() === 'run')!;
    run.parseOptions([
      '--category',
      'reasoning',
      '--competitor',
      'openai/gpt-5.6-sol',
      '--competitor',
      'anthropic/claude-fable-5',
    ]);

    expect(run.opts().competitor).toEqual(['openai/gpt-5.6-sol', 'anthropic/claude-fable-5']);
    expect(arenaRunConfigFromOptions(run.opts() as ArenaRunCliOptions)).toMatchObject({
      category: 'reasoning',
      competitorIds: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5'],
    });
  });

  it('keeps the full-roster default implicit in CLI config', () => {
    const program = overrideExits(
      buildProgram({
        stdout() {},
        stderr() {},
      }),
    );
    const arena = program.commands.find((command) => command.name() === 'arena')!;
    const run = arena.commands.find((command) => command.name() === 'run')!;
    run.parseOptions(['--category', 'reasoning']);

    expect(
      arenaRunConfigFromOptions(run.opts() as ArenaRunCliOptions).competitorIds,
    ).toBeUndefined();
  });
});

describe('publish configuration', () => {
  it('requires an explicit HTTPS target and admin key', () => {
    expect(() => resolveApiConfig({})).toThrow(/BRIDGEBENCH_API_URL/);
    expect(() =>
      resolveApiConfig({
        BRIDGEBENCH_API_URL: 'http://example.com',
        BRIDGEBENCH_ADMIN_KEY: 'placeholder',
      }),
    ).toThrow(/must use HTTPS/);

    const config = resolveApiConfig({
      BRIDGEBENCH_API_URL: 'https://api.example.com/v1/',
      BRIDGEBENCH_ADMIN_KEY: 'placeholder',
    });
    expect(config.baseUrl).toBe('https://api.example.com/v1');
    expect(publishTarget(config)).toBe('https://api.example.com');
  });
});
