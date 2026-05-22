jest.mock('../../../src/discord/client', () => ({
  createBotClient: jest.fn(() => ({
    on: jest.fn(), once: jest.fn(), off: jest.fn(),
    login: jest.fn(), destroy: jest.fn(),
    channels: { fetch: jest.fn() },
    user: { tag: 'TechLead#0000' },
  })),
  createWebhookClient: jest.fn(),
  postAsWorker: jest.fn().mockResolvedValue(undefined),
  postToChannel: jest.fn().mockResolvedValue(undefined),
  waitForApproval: jest.fn().mockResolvedValue(true),
}));

const mockOctokit = {
  pulls: {
    get: jest.fn(),
    listFiles: jest.fn(),
    merge: jest.fn(),
    list: jest.fn(),
    createReview: jest.fn(),
  },
  issues: {
    createComment: jest.fn(),
    update: jest.fn(),
    listForRepo: jest.fn(),
  },
};
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn(() => mockOctokit) }));

const mockSandbox = {
  boot: jest.fn(),
  teardown: jest.fn(),
  readFile: jest.fn(),
  exec: jest.fn(),
};
jest.mock('../../../src/workspace', () => jest.fn(() => mockSandbox));

const TechLeadAgent = require('../../../src/agents/managers/techlead');

const makeSpec = (overrides = {}) => ({
  projectName: 'test-project',
  architecture: {
    techStack: { language: 'javascript', runtime: 'node', packages: ['express'] },
    components: [{ name: 'frontend' }, { name: 'backend' }],
  },
  ...overrides,
});

const projectRepo = { owner: 'test-owner', repo: 'test-repo' };
const PKG_WITH_TESTS = JSON.stringify({ scripts: { test: 'jest' } });
const PKG_NO_TESTS = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });

function makeAgent() {
  const agent = new TechLeadAgent(makeSpec(), { managers: 'ch-managers' });
  agent.postToManagers = jest.fn();
  agent.standards = { rules: ['Use clear names'] };
  return agent;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSandbox.boot.mockResolvedValue(undefined);
  mockSandbox.teardown.mockResolvedValue(undefined);
  mockOctokit.pulls.list.mockResolvedValue({ data: [] });
  mockOctokit.issues.listForRepo.mockResolvedValue({ data: [] });
  mockOctokit.pulls.merge.mockResolvedValue({});
  mockOctokit.issues.update.mockResolvedValue({});
  mockOctokit.issues.createComment.mockResolvedValue({});
  mockOctokit.pulls.createReview.mockResolvedValue({});
  mockOctokit.pulls.get.mockResolvedValue({
    data: { title: 'Add feature', body: 'Closes #5', number: 1, head: { ref: 'coder/5/add-feature' } },
  });
  mockOctokit.pulls.listFiles.mockResolvedValue({
    data: [{ filename: 'app.js', changes: 10, patch: '+code' }],
  });
});

// ── defineCodingStandards ────────────────────────────────────────────────────

describe('TechLeadAgent.defineCodingStandards', () => {
  test('returns standards with language from spec', async () => {
    const agent = makeAgent();
    const standards = await agent.defineCodingStandards();
    expect(standards.language).toBe('javascript');
  });

  test('returns standards with a non-empty rules array', async () => {
    const agent = makeAgent();
    const standards = await agent.defineCodingStandards();
    expect(Array.isArray(standards.rules)).toBe(true);
    expect(standards.rules.length).toBeGreaterThan(0);
  });

  test('sets this.standards on the agent', async () => {
    const agent = makeAgent();
    await agent.defineCodingStandards();
    expect(agent.standards).toBeDefined();
    expect(agent.standards.language).toBe('javascript');
  });
});

// ── runTests ─────────────────────────────────────────────────────────────────
// Each test owns its exec mock setup — no shared beforeEach for exec.

describe('TechLeadAgent.runTests', () => {
  let agent;

  beforeEach(() => {
    agent = makeAgent();
    // mockReset clears the mockResolvedValueOnce queue so each test owns its exec setup
    mockSandbox.exec.mockReset();
    mockSandbox.readFile.mockResolvedValue(PKG_WITH_TESTS);
  });

  test('returns passed:true when npm test exits 0', async () => {
    mockSandbox.exec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '5 tests passed', stderr: '', exitCode: 0 });

    const result = await agent.runTests(mockSandbox);
    expect(result.passed).toBe(true);
    expect(result.output).toContain('5 tests passed');
  });

  test('returns passed:false when npm test exits non-zero', async () => {
    mockSandbox.exec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '2 tests failed', exitCode: 1 });

    const result = await agent.runTests(mockSandbox);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('2 tests failed');
  });

  test('returns passed:null when package.json is missing', async () => {
    mockSandbox.readFile.mockRejectedValue(new Error('ENOENT'));

    const result = await agent.runTests(mockSandbox);
    expect(result.passed).toBeNull();
    expect(result.output).toContain('No package.json');
  });

  test('returns passed:null when no test script is defined', async () => {
    mockSandbox.readFile.mockResolvedValue(PKG_NO_TESTS);

    const result = await agent.runTests(mockSandbox);
    expect(result.passed).toBeNull();
    expect(result.output).toContain('No test script');
  });

  test('returns passed:false when npm install fails', async () => {
    mockSandbox.exec.mockResolvedValueOnce({ stdout: '', stderr: 'npm ERR! missing package', exitCode: 1 });

    const result = await agent.runTests(mockSandbox);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('npm install failed');
  });

  test('runs npm install before npm test', async () => {
    mockSandbox.exec
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'ok', stderr: '', exitCode: 0 });

    await agent.runTests(mockSandbox);
    expect(mockSandbox.exec.mock.calls[0][0]).toBe('npm install');
    expect(mockSandbox.exec.mock.calls[1][0]).toBe('npm test');
  });
});

// ── runTestsForPR ─────────────────────────────────────────────────────────────

describe('TechLeadAgent.runTestsForPR', () => {
  let agent;

  beforeEach(() => {
    agent = makeAgent();
    agent.runTests = jest.fn().mockResolvedValue({ passed: true, output: 'ok' });
  });

  test('boots sandbox, calls runTests, and tears down', async () => {
    await agent.runTestsForPR('coder/5/feature', 'test-owner', 'test-repo');
    expect(mockSandbox.boot).toHaveBeenCalled();
    expect(agent.runTests).toHaveBeenCalledWith(mockSandbox);
    expect(mockSandbox.teardown).toHaveBeenCalled();
  });

  test('tears down even when runTests throws', async () => {
    agent.runTests = jest.fn().mockRejectedValue(new Error('test runner crashed'));

    const result = await agent.runTestsForPR('coder/5/feature', 'test-owner', 'test-repo');
    expect(mockSandbox.teardown).toHaveBeenCalled();
    expect(result.passed).toBeNull();
    expect(result.output).toContain('Workspace error');
  });

  test('returns passed:null when sandbox boot fails', async () => {
    mockSandbox.boot.mockRejectedValue(new Error('clone failed'));

    const result = await agent.runTestsForPR('coder/5/feature', 'test-owner', 'test-repo');
    expect(result.passed).toBeNull();
    expect(result.output).toContain('Workspace error');
    expect(mockSandbox.teardown).toHaveBeenCalled();
  });
});

// ── getQualitativeReview ──────────────────────────────────────────────────────

describe('TechLeadAgent.getQualitativeReview', () => {
  let agent;

  beforeEach(() => {
    agent = makeAgent();
  });

  test('returns parsed commentary from valid model JSON response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        response: '{"commentary":"Good naming, error handling could be tighter","suggestions":["add try/catch"]}',
      }),
    });

    const result = await agent.getQualitativeReview({ title: 'Add feature', body: 'description' }, []);
    expect(result.commentary).toBe('Good naming, error handling could be tighter');
    expect(result.suggestions).toEqual(['add try/catch']);
  });

  test('returns fallback commentary when model returns non-JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ response: 'Looks good to me!' }),
    });

    const result = await agent.getQualitativeReview({ title: 'Add feature', body: 'description' }, []);
    expect(result.commentary).toContain('details');
    expect(result.suggestions).toEqual([]);
  });

  test('does not include a score field in the return value', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        response: '{"commentary":"Looks solid","suggestions":[]}',
      }),
    });

    const result = await agent.getQualitativeReview({ title: 'Add feature', body: 'description' }, []);
    expect(result).not.toHaveProperty('score');
  });

  test('includes test result context in the prompt when provided', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ response: '{"commentary":"ok","suggestions":[]}' }),
    });

    await agent.getQualitativeReview(
      { title: 'Add feature', body: 'description' },
      [],
      { passed: false, output: '3 tests failed' }
    );

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.prompt).toContain('FAILED');
    expect(body.prompt).toContain('3 tests failed');
  });

  test('prompt does not ask for a numeric score', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ response: '{"commentary":"ok","suggestions":[]}' }),
    });

    await agent.getQualitativeReview({ title: 'Add feature', body: 'description' }, []);

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.prompt).not.toContain('Score this PR');
    expect(body.prompt).not.toContain('1-10');
  });

  test('parses Claude-shaped response (content[0].text) without throwing', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const claudeAgent = makeAgent();

    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        content: [{ text: '{"commentary":"Clean code","suggestions":["add more tests"]}' }],
      }),
    });

    const result = await claudeAgent.getQualitativeReview({ title: 'Add feature', body: 'desc' }, []);
    expect(result.commentary).toBe('Clean code');
    expect(result.suggestions).toEqual(['add more tests']);

    delete process.env.ANTHROPIC_API_KEY;
  });

  test('sends request to Anthropic endpoint when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const claudeAgent = makeAgent();

    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        content: [{ text: '{"commentary":"ok","suggestions":[]}' }],
      }),
    });

    await claudeAgent.getQualitativeReview({ title: 'Add feature', body: 'desc' }, []);
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');

    delete process.env.ANTHROPIC_API_KEY;
  });
});

// ── reviewPR ─────────────────────────────────────────────────────────────────
// runTestsForPR and getQualitativeReview are mocked — decision logic is under test.

describe('TechLeadAgent.reviewPR', () => {
  let agent;

  function mockReview() {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        response: '{"commentary":"Looks solid","suggestions":[]}',
      }),
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    agent = makeAgent();
    agent.runTestsForPR = jest.fn().mockResolvedValue({ passed: true, output: '5 tests passed' });
    mockReview();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function runReviewPR(a, prNum, repo) {
    const promise = a.reviewPR(prNum, repo);
    await jest.runAllTimersAsync();
    return promise;
  }

  test('merges PR when tests pass', async () => {
    const result = await runReviewPR(agent, 1, projectRepo);
    expect(result.approved).toBe(true);
    expect(mockOctokit.pulls.merge).toHaveBeenCalled();
  });

  test('merges PR when tests not run (no package.json)', async () => {
    agent.runTestsForPR.mockResolvedValue({ passed: null, output: 'No package.json found' });

    const result = await runReviewPR(agent, 1, projectRepo);
    expect(result.approved).toBe(true);
    expect(mockOctokit.pulls.merge).toHaveBeenCalled();
  });

  test('rejects PR when tests fail', async () => {
    agent.runTestsForPR.mockResolvedValue({ passed: false, output: '5 tests failed' });

    const result = await runReviewPR(agent, 1, projectRepo);
    expect(result.approved).toBe(false);
    expect(mockOctokit.pulls.merge).not.toHaveBeenCalled();
  });

  test('approval comment contains "Tests passed"', async () => {
    await runReviewPR(agent, 1, projectRepo);
    expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Tests passed') })
    );
  });

  test('rejection comment contains "Tests failed" and test output', async () => {
    agent.runTestsForPR.mockResolvedValue({ passed: false, output: 'FAIL src/app.test.js' });

    await runReviewPR(agent, 1, projectRepo);
    expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Tests failed') })
    );
    expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('FAIL src/app.test.js') })
    );
  });

  test('approval comment includes qualitative commentary', async () => {
    await runReviewPR(agent, 1, projectRepo);
    expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Looks solid') })
    );
  });

  test('approval comment does not contain a numeric score', async () => {
    await runReviewPR(agent, 1, projectRepo);
    const call = mockOctokit.issues.createComment.mock.calls[0][0];
    expect(call.body).not.toMatch(/Score:\s*\d+\/10/);
  });

  test('closes linked issue after merge', async () => {
    await runReviewPR(agent, 1, projectRepo);
    expect(mockOctokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 5, state: 'closed' })
    );
  });

  test('result includes testResult and review, not score', async () => {
    const result = await runReviewPR(agent, 1, projectRepo);
    expect(result.testResult).toBeDefined();
    expect(result.review).toBeDefined();
    expect(result).not.toHaveProperty('score');
  });

  test('uses head.ref from PR data as the workspace branch', async () => {
    await runReviewPR(agent, 1, projectRepo);
    expect(agent.runTestsForPR).toHaveBeenCalledWith('coder/5/add-feature', 'test-owner', 'test-repo');
  });
});

// ── reviewPR — separate GitHub account ───────────────────────────────────────

describe('TechLeadAgent.reviewPR — separate GitHub account', () => {
  let agent;

  function mockReview() {
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({
        response: '{"commentary":"Looks solid","suggestions":[]}',
      }),
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.TECHLEAD_GITHUB_TOKEN = 'separate-token';
    agent = makeAgent();
    agent.runTestsForPR = jest.fn().mockResolvedValue({ passed: true, output: '5 tests passed' });
    mockReview();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.TECHLEAD_GITHUB_TOKEN;
  });

  async function runReviewPR(a, prNum, repo) {
    const promise = a.reviewPR(prNum, repo);
    await jest.runAllTimersAsync();
    return promise;
  }

  test('hasSeparateGitHubAccount is true when TECHLEAD_GITHUB_TOKEN is set', () => {
    expect(agent.hasSeparateGitHubAccount).toBe(true);
  });

  test('uses pulls.createReview APPROVE when tests pass', async () => {
    await runReviewPR(agent, 1, projectRepo);
    expect(mockOctokit.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE', pull_number: 1 })
    );
    expect(mockOctokit.issues.createComment).not.toHaveBeenCalled();
  });

  test('uses pulls.createReview REQUEST_CHANGES when tests fail', async () => {
    agent.runTestsForPR.mockResolvedValue({ passed: false, output: 'Tests failed' });

    await runReviewPR(agent, 1, projectRepo);
    expect(mockOctokit.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'REQUEST_CHANGES', pull_number: 1 })
    );
    expect(mockOctokit.issues.createComment).not.toHaveBeenCalled();
    expect(mockOctokit.pulls.merge).not.toHaveBeenCalled();
  });

  test('approval review body contains "Tests passed"', async () => {
    await runReviewPR(agent, 1, projectRepo);
    expect(mockOctokit.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Tests passed') })
    );
  });

  test('rejection review body contains "Tests failed"', async () => {
    agent.runTestsForPR.mockResolvedValue({ passed: false, output: 'Test suite failed' });

    await runReviewPR(agent, 1, projectRepo);
    expect(mockOctokit.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Tests failed') })
    );
  });

  test('review body does not contain a numeric score', async () => {
    await runReviewPR(agent, 1, projectRepo);
    const call = mockOctokit.pulls.createReview.mock.calls[0][0];
    expect(call.body).not.toMatch(/Score:\s*\d+\/10/);
  });
});
