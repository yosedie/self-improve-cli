'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

const { convertInputSchema } = require('../src/mcp-client');
const { parseSkillFrontmatter, prefixToolSchema, prefixHandlers, SKILL_NAME_RE, getDiscoveryDirs } = require('../src/skills');

describe('convertInputSchema', () => {
  it('returns fallback for null', () => {
    const result = convertInputSchema(null);
    assert.equal(result.type, 'object');
    assert.equal(result.additionalProperties, false);
    assert.deepStrictEqual(result.properties, {});
  });

  it('returns fallback for undefined', () => {
    const result = convertInputSchema(undefined);
    assert.equal(result.additionalProperties, false);
  });

  it('preserves properties and sets additionalProperties false', () => {
    const result = convertInputSchema({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name']
    });
    assert.equal(result.additionalProperties, false);
    assert.ok(result.properties.name);
    assert.ok(result.properties.age);
  });

  it('strips default from properties', () => {
    const result = convertInputSchema({
      type: 'object',
      properties: { encoding: { type: 'string', default: 'utf-8' } }
    });
    assert.equal(result.properties.encoding.default, undefined);
    assert.equal(result.properties.encoding.type, 'string');
  });
});

describe('parseSkillFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const content = '---\nname: test-skill\ndescription: A test skill\n---\nDo something useful.';
    const result = parseSkillFrontmatter(content);
    assert.equal(result.name, 'test-skill');
    assert.equal(result.description, 'A test skill');
    assert.equal(result.body, 'Do something useful.');
  });

  it('returns null for missing frontmatter', () => {
    assert.equal(parseSkillFrontmatter('no frontmatter'), null);
  });

  it('returns null for unclosed frontmatter', () => {
    assert.equal(parseSkillFrontmatter('---\nname: test'), null);
  });

  it('handles quoted values', () => {
    const content = '---\nname: "my-skill"\ndescription: \'quoted desc\'\n---\nbody';
    const result = parseSkillFrontmatter(content);
    assert.equal(result.name, 'my-skill');
    assert.equal(result.description, 'quoted desc');
  });

  it('ignores --- inside body', () => {
    const content = '---\nname: test-skill\n---\nSome text\n---\nMore text';
    const result = parseSkillFrontmatter(content);
    assert.equal(result.name, 'test-skill');
    assert.equal(result.body, 'Some text\n---\nMore text');
  });
});

describe('prefixToolSchema', () => {
  it('prefixes tool name with skill name', () => {
    const schema = {
      type: 'function',
      function: { name: 'my_tool', description: 'desc', parameters: { type: 'object', properties: {} } }
    };
    const result = prefixToolSchema('my-skill', schema);
    assert.equal(result.function.name, 'skill__my-skill__my_tool');
  });

  it('returns schema as-is when no function name', () => {
    const schema = { type: 'function', function: {} };
    const result = prefixToolSchema('my-skill', schema);
    assert.strictEqual(result, schema);
  });
});

describe('prefixHandlers', () => {
  it('prefixes handler keys', () => {
    const fn = async () => {};
    const result = prefixHandlers('my-skill', { do_thing: fn });
    assert.ok(result['skill__my-skill__do_thing']);
    assert.strictEqual(result['skill__my-skill__do_thing'], fn);
  });

  it('skips non-function values', () => {
    const result = prefixHandlers('my-skill', { not_fn: 'string' });
    assert.ok(!result['skill__my-skill__not_fn']);
  });
});

describe('SKILL_NAME_RE', () => {
  it('accepts valid names', () => {
    assert.ok(SKILL_NAME_RE.test('caveman'));
    assert.ok(SKILL_NAME_RE.test('my-skill'));
    assert.ok(SKILL_NAME_RE.test('skill-123'));
  });

  it('rejects invalid names', () => {
    assert.ok(!SKILL_NAME_RE.test('MySkill'));
    assert.ok(!SKILL_NAME_RE.test('my_skill'));
    assert.ok(!SKILL_NAME_RE.test(''));
    assert.ok(!SKILL_NAME_RE.test('a b'));
  });
});

describe('getDiscoveryDirs', () => {
  it('returns 6 directories', () => {
    const dirs = getDiscoveryDirs('/project');
    assert.equal(dirs.length, 6);
  });

  it('includes global dirs', () => {
    const dirs = getDiscoveryDirs('/project');
    const home = os.homedir();
    assert.ok(dirs[0].includes(home));
    assert.ok(dirs[1].includes(home));
    assert.ok(dirs[2].includes(home));
  });

  it('includes project dirs', () => {
    const dirs = getDiscoveryDirs('/project');
    const norm = dirs.map(d => d.replace(/\\/g, '/'));
    assert.ok(norm[3].includes('/project'));
    assert.ok(norm[4].includes('/project'));
    assert.ok(norm[5].includes('/project'));
  });
});

describe('state MCP config', () => {
  it('loadMcpConfig returns defaults when no file', async () => {
    const { loadMcpConfig } = require('../src/state');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sicli-test-'));
    try {
      const config = await loadMcpConfig(tmpDir);
      assert.deepStrictEqual(config.mcpServers, {});
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('saveMcpConfig + loadMcpConfig round-trip', async () => {
    const { loadMcpConfig, saveMcpConfig } = require('../src/state');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sicli-test-'));
    try {
      const config = { mcpServers: { test: { command: 'echo' } } };
      await saveMcpConfig(tmpDir, config);
      const loaded = await loadMcpConfig(tmpDir);
      assert.deepStrictEqual(loaded.mcpServers.test.command, 'echo');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
