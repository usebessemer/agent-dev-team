jest.mock('../../../src/discord/client', () => ({
  createBotClient: jest.fn(() => ({
    on: jest.fn(), once: jest.fn(), off: jest.fn(),
    login: jest.fn(), destroy: jest.fn(),
    channels: { fetch: jest.fn() },
    user: { tag: 'Bot#0000' },
  })),
  createWebhookClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue(undefined) })),
  postAsWorker: jest.fn().mockResolvedValue(undefined),
  postToChannel: jest.fn().mockResolvedValue(undefined),
  waitForApproval: jest.fn().mockResolvedValue(true),
}));

const mockOctokit = {
  pulls: { create: jest.fn() },
  issues: { update: jest.fn() },
};
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn(() => mockOctokit) }));

const mockSandbox = {
  boot: jest.fn(),
  teardown: jest.fn(),
  exec: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  listDir: jest.fn(),
};
jest.mock('../../../src/workspace', () => jest.fn(() => mockSandbox));

const CoderAgent = require('../../../src/agents/workers/coder');

const makeIssue = (overrides = {}) => ({
  number: 42,
  title: 'Build a calculator app',
  body: 'Implement a basic calculator with add, subtract, multiply, divide.',
  ...overrides,
});

const makeProjectRepo = () => ({ owner: 'test-owner', repo: 'test-repo' });

function makeAgent(issueOverrides = {}) {
  const agent = new CoderAgent(makeIssue(issueOverrides), null, makeProjectRepo());
  agent.log = jest.fn();
  return agent;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
  mockSandbox.boot.mockResolvedValue(undefined);
  mockSandbox.teardown.mockResolvedValue(undefined);
  mockSandbox.exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  mockSandbox.listDir.mockResolvedValue(['README.md', 'package.json']);
  mockOctokit.pulls.create.mockResolvedValue({
    data: { number: 10, html_url: 'https://github.com/test-owner/test-repo/pull/10' },
  });
  mockOctokit.issues.update.mockResolvedValue({});
});

// ── slugify ──────────────────────────────────────────────────────────────────

describe('CoderAgent.slugify', () => {
  const agent = makeAgent();

  test('lowercases and hyphenates words', () => {
    expect(agent.slugify('Hello World')).toBe('hello-world');
  });

  test('strips special characters', () => {
    expect(agent.slugify('Add: feature! (v2)')).toBe('add-feature-v2');
  });

  test('collapses multiple separators into one hyphen', () => {
    expect(agent.slugify('hello   world')).toBe('hello-world');
  });

  test('strips leading and trailing hyphens', () => {
    expect(agent.slugify('---hello---')).toBe('hello');
  });

  test('truncates at 50 characters', () => {
    expect(agent.slugify('a'.repeat(60))).toHaveLength(50);
  });

  test('handles empty string', () => {
    expect(agent.slugify('')).toBe('');
  });
});

// ── constructor ───────────────────────────────────────────────────────────────

describe('CoderAgent constructor', () => {
  test('sets branchName as coder/{number}/{slug}', () => {
    const agent = new CoderAgent(makeIssue({ number: 42, title: 'Build a calculator app' }), null, makeProjectRepo());
    expect(agent.branchName).toBe('coder/42/build-a-calculator-app');
  });

  test('defaults maxIterations to 25', () => {
    const agent = new CoderAgent(makeIssue(), null, makeProjectRepo());
    expect(agent.maxIterations).toBe(25);
  });

  test('reads maxIterations from CODER_MAX_ITERATIONS env var', () => {
    process.env.CODER_MAX_ITERATIONS = '5';
    const agent = new CoderAgent(makeIssue(), null, makeProjectRepo());
    expect(agent.maxIterations).toBe(5);
    delete process.env.CODER_MAX_ITERATIONS;
  });
});

// ── executeTool ───────────────────────────────────────────────────────────────

describe('CoderAgent.executeTool', () => {
  let agent;

  beforeEach(() => {
    agent = makeAgent();
    mockSandbox.readFile.mockResolvedValue('file content');
    mockSandbox.writeFile.mockResolvedValue(undefined);
    mockSandbox.listDir.mockResolvedValue(['a.js', 'b.js']);
    mockSandbox.exec.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
  });

  test('read_file delegates to workspace.readFile', async () => {
    const result = await agent.executeTool('read_file', { path: 'src/app.js' }, mockSandbox);
    expect(mockSandbox.readFile).toHaveBeenCalledWith('src/app.js');
    expect(result).toBe('file content');
  });

  test('write_file delegates to workspace.writeFile and returns "written"', async () => {
    const result = await agent.executeTool('write_file', { path: 'src/app.js', content: 'code' }, mockSandbox);
    expect(mockSandbox.writeFile).toHaveBeenCalledWith('src/app.js', 'code');
    expect(result).toBe('written');
  });

  test('list_dir delegates to workspace.listDir', async () => {
    const result = await agent.executeTool('list_dir', { path: 'src' }, mockSandbox);
    expect(mockSandbox.listDir).toHaveBeenCalledWith('src');
    expect(result).toEqual(['a.js', 'b.js']);
  });

  test('exec delegates to workspace.exec', async () => {
    const result = await agent.executeTool('exec', { command: 'npm test' }, mockSandbox);
    expect(mockSandbox.exec).toHaveBeenCalledWith('npm test');
    expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
  });

  test('unknown tool returns error string without throwing', async () => {
    const result = await agent.executeTool('unknown_tool', {}, mockSandbox);
    expect(result).toContain('Unknown tool');
  });
});

// ── callOllama ────────────────────────────────────────────────────────────────

describe('CoderAgent.callOllama', () => {
  let agent;

  beforeEach(() => {
    agent = makeAgent();
  });

  test('parses a valid tool call from model JSON response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        response: '{"tool":"write_file","args":{"path":"app.js","content":"code"}}',
      }),
    });

    const result = await agent.callOllama([{ role: 'user', content: 'do the task' }]);
    expect(result.tool).toBe('write_file');
    expect(result.args).toEqual({ path: 'app.js', content: 'code' });
  });

  test('falls back to done when response is not valid JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ response: 'I completed the task!' }),
    });

    const result = await agent.callOllama([{ role: 'user', content: 'do the task' }]);
    expect(result.tool).toBe('done');
  });

  test('falls back to done when JSON has no tool field', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ response: '{"something":"else"}' }),
    });

    const result = await agent.callOllama([{ role: 'user', content: 'do the task' }]);
    expect(result.tool).toBe('done');
  });
});

// ── callClaude ────────────────────────────────────────────────────────────────

describe('CoderAgent.callClaude', () => {
  let agent;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    agent = makeAgent();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('returns toolUses array when model responds with a single tool_use block', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        content: [
          { type: 'tool_use', name: 'read_file', input: { path: 'README.md' }, id: 'tu_123' },
        ],
      }),
    });

    const result = await agent.callClaude([{ role: 'user', content: 'task' }]);
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].name).toBe('read_file');
    expect(result.toolUses[0].input).toEqual({ path: 'README.md' });
    expect(result.toolUses[0].id).toBe('tu_123');
  });

  test('returns all tool_use blocks in toolUses when model returns parallel calls', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        content: [
          { type: 'tool_use', name: 'read_file', input: { path: 'a.js' }, id: 'tu_1' },
          { type: 'tool_use', name: 'read_file', input: { path: 'b.js' }, id: 'tu_2' },
        ],
      }),
    });

    const result = await agent.callClaude([{ role: 'user', content: 'task' }]);
    expect(result.toolUses).toHaveLength(2);
    expect(result.toolUses[0].id).toBe('tu_1');
    expect(result.toolUses[1].id).toBe('tu_2');
    expect(result.raw).toBeDefined();
  });

  test('returns done when model responds with text only (no tool_use)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'All done!' }],
      }),
    });

    const result = await agent.callClaude([{ role: 'user', content: 'task' }]);
    expect(result.tool).toBe('done');
    expect(result.args.summary).toBe('All done!');
  });

  test('throws when Claude API returns an error status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn().mockResolvedValue({ error: { message: 'Invalid API key' } }),
    });

    await expect(agent.callClaude([{ role: 'user', content: 'task' }])).rejects.toThrow('Claude API error 401');
  });

  test('sends system prompt and tool definitions in request body', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        content: [{ type: 'tool_use', name: 'done', input: { summary: 'done' }, id: 'tu_1' }],
      }),
    });

    await agent.callClaude([{ role: 'user', content: 'task' }]);

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.tools).toBeDefined();
    expect(body.tools.map(t => t.name)).toContain('write_file');
    expect(body.system).toBeDefined();
  });
});

// ── agenticLoop ───────────────────────────────────────────────────────────────

describe('CoderAgent.agenticLoop', () => {
  let agent;

  beforeEach(() => {
    agent = makeAgent();
    mockSandbox.listDir.mockResolvedValue(['README.md']);
    mockSandbox.writeFile.mockResolvedValue(undefined);
    mockSandbox.readFile.mockResolvedValue('content');
  });

  test('stops when model calls done', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        response: '{"tool":"done","args":{"summary":"built it"}}',
      }),
    });

    await agent.agenticLoop(mockSandbox);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('executes tool and feeds result back before next model call', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        json: jest.fn().mockResolvedValue({
          response: '{"tool":"list_dir","args":{"path":"src"}}',
        }),
      })
      .mockResolvedValueOnce({
        json: jest.fn().mockResolvedValue({
          response: '{"tool":"done","args":{"summary":"listed it"}}',
        }),
      });

    mockSandbox.listDir.mockResolvedValue(['a.js']);

    await agent.agenticLoop(mockSandbox);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockSandbox.listDir).toHaveBeenCalledWith('src');
  });

  test('continues loop when tool throws, passing error as result', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        json: jest.fn().mockResolvedValue({
          response: '{"tool":"read_file","args":{"path":"missing.js"}}',
        }),
      })
      .mockResolvedValueOnce({
        json: jest.fn().mockResolvedValue({
          response: '{"tool":"done","args":{"summary":"handled error"}}',
        }),
      });

    mockSandbox.readFile.mockRejectedValue(new Error('ENOENT: file not found'));

    await expect(agent.agenticLoop(mockSandbox)).resolves.not.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('stops after maxIterations without throwing', async () => {
    agent.maxIterations = 3;
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        response: '{"tool":"exec","args":{"command":"echo hi"}}',
      }),
    });
    mockSandbox.exec.mockResolvedValue({ stdout: 'hi', stderr: '', exitCode: 0 });

    await expect(agent.agenticLoop(mockSandbox)).resolves.not.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('Claude path: feeds all parallel tool_use results back in one user message', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const claudeAgent = new CoderAgent(makeIssue(), null, makeProjectRepo());
    claudeAgent.log = jest.fn();

    mockSandbox.readFile.mockResolvedValue('file content');
    mockSandbox.listDir.mockResolvedValue(['a.js', 'b.js']);

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          content: [
            { type: 'tool_use', name: 'read_file', input: { path: 'a.js' }, id: 'tu_1' },
            { type: 'tool_use', name: 'read_file', input: { path: 'b.js' }, id: 'tu_2' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'All files read. Done.' }],
        }),
      });

    await claudeAgent.agenticLoop(mockSandbox);

    const secondFetchBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    const msgs = secondFetchBody.messages;
    const toolResultMsg = msgs[msgs.length - 1];
    expect(toolResultMsg.role).toBe('user');
    expect(Array.isArray(toolResultMsg.content)).toBe(true);
    expect(toolResultMsg.content).toHaveLength(2);
    expect(toolResultMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect(toolResultMsg.content[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_2' });

    delete process.env.ANTHROPIC_API_KEY;
  });
});

// ── commitAndPush ─────────────────────────────────────────────────────────────

describe('CoderAgent.commitAndPush', () => {
  let agent;

  beforeEach(() => {
    agent = makeAgent();
  });

  test('runs git add, commit, and push in sequence', async () => {
    mockSandbox.exec
      .mockResolvedValueOnce({ stdout: 'M app.js', stderr: '', exitCode: 0 }) // status
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })           // add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })           // commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });          // push

    await agent.commitAndPush(mockSandbox);

    const commands = mockSandbox.exec.mock.calls.map(c => c[0]);
    expect(commands[0]).toContain('status --porcelain');
    expect(commands[1]).toBe('git add -A');
    expect(commands[2]).toContain('commit');
    expect(commands[2]).toContain('[coder-42]');
    expect(commands[3]).toContain('git push origin');
  });

  test('throws when nothing was written (empty git status)', async () => {
    mockSandbox.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await expect(agent.commitAndPush(mockSandbox)).rejects.toThrow('No files were written');
  });

  test('throws when git commit fails', async () => {
    mockSandbox.exec
      .mockResolvedValueOnce({ stdout: 'M app.js', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'nothing to commit', exitCode: 1 });

    await expect(agent.commitAndPush(mockSandbox)).rejects.toThrow('Commit failed');
  });

  test('throws when git push fails', async () => {
    mockSandbox.exec
      .mockResolvedValueOnce({ stdout: 'M app.js', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'remote: Permission denied', exitCode: 1 });

    await expect(agent.commitAndPush(mockSandbox)).rejects.toThrow('Push failed');
  });

  test('writes a .gitignore before git add when none exists (Node stack)', async () => {
    mockSandbox.exec
      .mockResolvedValueOnce({ stdout: 'M app.js', stderr: '', exitCode: 0 }) // status
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })           // add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })           // commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });          // push
    mockSandbox.readFile.mockRejectedValue(new Error('ENOENT'));
    mockSandbox.listDir.mockResolvedValue(['package.json', 'app.js']);

    await agent.commitAndPush(mockSandbox);

    expect(mockSandbox.writeFile).toHaveBeenCalledWith('.gitignore', expect.stringContaining('node_modules/'));
  });

  test('writes a Python .gitignore excluding __pycache__ and .coverage', async () => {
    mockSandbox.exec
      .mockResolvedValueOnce({ stdout: 'M app.py', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    mockSandbox.readFile.mockRejectedValue(new Error('ENOENT'));
    mockSandbox.listDir.mockResolvedValue(['requirements.txt', 'app.py']);

    await agent.commitAndPush(mockSandbox);

    const [, content] = mockSandbox.writeFile.mock.calls.find(c => c[0] === '.gitignore');
    expect(content).toContain('__pycache__/');
    expect(content).toContain('.coverage');
    expect(content).not.toContain('node_modules/');
  });

  test('does not write .gitignore when one already exists', async () => {
    mockSandbox.exec
      .mockResolvedValueOnce({ stdout: 'M app.js', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    mockSandbox.readFile.mockResolvedValue('node_modules/\n');

    await agent.commitAndPush(mockSandbox);

    const gitignoreWrite = mockSandbox.writeFile.mock.calls.find(c => c[0] === '.gitignore');
    expect(gitignoreWrite).toBeUndefined();
  });
});

// ── openPR ────────────────────────────────────────────────────────────────────

describe('CoderAgent.openPR', () => {
  let agent;

  beforeEach(() => {
    agent = makeAgent({ number: 42, title: 'Build a calculator app' });
  });

  test('creates PR with correct title format', async () => {
    await agent.openPR();
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: '[coder-42] Build a calculator app' })
    );
  });

  test('PR body contains Closes reference', async () => {
    await agent.openPR();
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Closes #42') })
    );
  });

  test('PR targets main branch', async () => {
    await agent.openPR();
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'main' })
    );
  });

  test('updates Issue label to status:review', async () => {
    await agent.openPR();
    expect(mockOctokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['status:review'] })
    );
  });
});

// ── run() integration ─────────────────────────────────────────────────────────

describe('CoderAgent.run', () => {
  test('boots sandbox, runs loop, commits, opens PR, and tears down', async () => {
    const agent = makeAgent();

    // agentic loop: one write_file then done
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        json: jest.fn().mockResolvedValue({
          response: '{"tool":"write_file","args":{"path":"app.js","content":"code"}}',
        }),
      })
      .mockResolvedValueOnce({
        json: jest.fn().mockResolvedValue({
          response: '{"tool":"done","args":{"summary":"built calculator"}}',
        }),
      });

    mockSandbox.exec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git checkout -b
      .mockResolvedValueOnce({ stdout: 'M app.js', stderr: '', exitCode: 0 }) // git status
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git commit
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // git push

    await agent.run();

    expect(mockSandbox.boot).toHaveBeenCalled();
    expect(mockSandbox.writeFile).toHaveBeenCalledWith('app.js', 'code');
    expect(mockOctokit.pulls.create).toHaveBeenCalled();
    expect(mockSandbox.teardown).toHaveBeenCalled();
  });

  test('escalates and still tears down on fatal error', async () => {
    const agent = makeAgent();
    mockSandbox.boot.mockRejectedValue(new Error('clone failed'));

    await agent.run();

    expect(agent.log).toHaveBeenCalledWith(expect.stringContaining('Fatal error'));
    expect(mockSandbox.teardown).toHaveBeenCalled();
  });
});
