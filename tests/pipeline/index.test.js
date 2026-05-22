const mockCreateProjectChannel = jest.fn();
const mockArchiveProjectChannel = jest.fn();

const mockDb = {
  saveProject: jest.fn(),
  updateProject: jest.fn(),
  getOpenProjects: jest.fn().mockReturnValue([]),
  closeProject: jest.fn(),
};
jest.mock('../../src/state/db', () => jest.fn(() => mockDb));
jest.mock('../../src/webhooks/github', () => jest.fn(() => ({ start: jest.fn().mockReturnThis(), stop: jest.fn() })));

jest.mock('../../src/discord/client', () => ({
  createBotClient: jest.fn(() => ({
    on: jest.fn(), once: jest.fn(), off: jest.fn(),
    login: jest.fn(), destroy: jest.fn(),
    channels: { fetch: jest.fn() },
    user: { tag: 'Bot#0000' },
  })),
  createWebhookClient: jest.fn(),
  postAsWorker: jest.fn().mockResolvedValue(undefined),
  postToChannel: jest.fn().mockResolvedValue(undefined),
  waitForApproval: jest.fn().mockResolvedValue(true),
  createProjectChannel: (...args) => mockCreateProjectChannel(...args),
  archiveProjectChannel: (...args) => mockArchiveProjectChannel(...args),
}));

const mockOctokit = {
  issues: { listForRepo: jest.fn() },
  pulls: { list: jest.fn() },
  repos: {
    getContent: jest.fn(),
    createOrUpdateFileContents: jest.fn(),
  },
};

jest.mock('@octokit/rest', () => ({ Octokit: jest.fn(() => mockOctokit) }));

jest.mock('../../src/agents/director/index', () => jest.fn(() => ({})));
jest.mock('../../src/agents/managers/pm', () => jest.fn(() => ({
  run: jest.fn().mockResolvedValue(undefined),
  discard: jest.fn().mockResolvedValue(undefined),
  projectRepo: { owner: 'o', repo: 'r' },
  estimate: { hours: 10, cost: 200, currency: 'CAD' },
})));
jest.mock('../../src/agents/managers/techlead', () => jest.fn(() => ({
  run: jest.fn().mockResolvedValue(undefined),
  discard: jest.fn().mockResolvedValue(undefined),
  reviewPR: jest.fn().mockResolvedValue({ approved: true }),
})));

const mockCoderRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/agents/workers/coder', () => jest.fn(() => ({ run: mockCoderRun })));

const mockResearcherRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/agents/workers/researcher', () => jest.fn(() => ({ run: mockResearcherRun })));

const mockWriterRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/agents/workers/writer', () => jest.fn(() => ({ run: mockWriterRun })));

const Pipeline = require('../../src/pipeline/index');
const CoderAgent = require('../../src/agents/workers/coder');
const ResearcherAgent = require('../../src/agents/workers/researcher');
const WriterAgent = require('../../src/agents/workers/writer');

const makeIssue = (n, isPR = false) => ({
  number: n,
  title: `Issue ${n}`,
  pull_request: isPR ? {} : undefined,
  html_url: isPR
    ? `https://github.com/o/r/pull/${n}`
    : `https://github.com/o/r/issues/${n}`,
});

describe('Pipeline.createProjectChannels', () => {
  beforeEach(() => {
    mockCreateProjectChannel.mockResolvedValue({ channelId: 'ch-project-123', webhookUrl: 'https://hooks/test' });
  });

  test('returns object with all required channel keys', async () => {
    const pipeline = new Pipeline();
    const channels = await pipeline.createProjectChannels('test-project');
    expect(channels).toHaveProperty('director');
    expect(channels).toHaveProperty('managers');
    expect(channels).toHaveProperty('workers');
    expect(channels).toHaveProperty('workersWebhook');
  });

  test('uses project channel when director client and guild ID are available', async () => {
    process.env.DISCORD_GUILD_ID = 'guild-1';
    const pipeline = new Pipeline();
    pipeline.director = { client: {} };

    const channels = await pipeline.createProjectChannels('my-app');

    expect(mockCreateProjectChannel).toHaveBeenCalledWith({}, 'guild-1', 'my-app');
    expect(channels.managers).toBe('ch-project-123');
    expect(channels.workersWebhook).toBe('https://hooks/test');
  });

  test('falls back to shared channels when no director client', async () => {
    const pipeline = new Pipeline();
    const channels = await pipeline.createProjectChannels('my-app');
    expect(mockCreateProjectChannel).not.toHaveBeenCalled();
    expect(channels.managers).toBe(process.env.DISCORD_CHANNEL_DIRECTOR);
  });

  test('falls back to shared channels when createProjectChannel returns null', async () => {
    process.env.DISCORD_GUILD_ID = 'guild-1';
    mockCreateProjectChannel.mockResolvedValue({ channelId: null, webhookUrl: null });
    const pipeline = new Pipeline();
    pipeline.director = { client: {} };

    const channels = await pipeline.createProjectChannels('my-app');
    expect(channels.managers).toBe(process.env.DISCORD_CHANNEL_DIRECTOR);
  });
});

describe('Pipeline.spawnWorker', () => {
  test('creates a CoderAgent for issues without type:research label', async () => {
    const pipeline = new Pipeline();
    const issue = makeIssue(1);
    const projectRepo = { owner: 'o', repo: 'r' };

    await pipeline.spawnWorker(issue, {}, projectRepo);

    expect(CoderAgent).toHaveBeenCalledWith(issue, {}, projectRepo);
    expect(mockCoderRun).toHaveBeenCalled();
  });

  test('creates a ResearcherAgent for type:research issues', async () => {
    const pipeline = new Pipeline();
    const issue = { ...makeIssue(2), labels: [{ name: 'type:research' }] };
    const projectRepo = { owner: 'o', repo: 'r' };

    await pipeline.spawnWorker(issue, {}, projectRepo);

    expect(ResearcherAgent).toHaveBeenCalledWith(issue, {}, projectRepo);
    expect(mockResearcherRun).toHaveBeenCalled();
    expect(CoderAgent).not.toHaveBeenCalled();
  });

  test('creates a CoderAgent when labels array is empty', async () => {
    const pipeline = new Pipeline();
    const issue = { ...makeIssue(3), labels: [] };

    await pipeline.spawnWorker(issue, {}, { owner: 'o', repo: 'r' });

    expect(CoderAgent).toHaveBeenCalled();
    expect(ResearcherAgent).not.toHaveBeenCalled();
  });

  test('creates a WriterAgent for type:docs issues', async () => {
    const pipeline = new Pipeline();
    const issue = { ...makeIssue(4), labels: [{ name: 'type:docs' }] };

    await pipeline.spawnWorker(issue, {}, { owner: 'o', repo: 'r' });

    expect(WriterAgent).toHaveBeenCalledWith(issue, {}, { owner: 'o', repo: 'r' });
    expect(mockWriterRun).toHaveBeenCalled();
    expect(CoderAgent).not.toHaveBeenCalled();
    expect(ResearcherAgent).not.toHaveBeenCalled();
  });
});

describe('Pipeline.watchIssues', () => {
  let pipeline;

  beforeEach(() => {
    jest.useFakeTimers();
    pipeline = new Pipeline();
    pipeline.activeProjects['test-project'] = { channels: {} };
    pipeline.spawnWorker = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function flushAsync(ticks = 10) {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  }

  test('spawns a worker for each open issue', async () => {
    mockOctokit.issues.listForRepo.mockResolvedValue({
      data: [makeIssue(1), makeIssue(2)],
    });

    pipeline.watchIssues('test-project', { owner: 'o', repo: 'r' });
    jest.advanceTimersByTime(5001);
    await flushAsync();

    expect(pipeline.spawnWorker).toHaveBeenCalledTimes(2);
  });

  test('filters out pull requests from the issues list', async () => {
    mockOctokit.issues.listForRepo.mockResolvedValue({
      data: [makeIssue(1), makeIssue(2, true)],
    });

    pipeline.watchIssues('test-project', { owner: 'o', repo: 'r' });
    jest.advanceTimersByTime(5001);
    await flushAsync();

    expect(pipeline.spawnWorker).toHaveBeenCalledTimes(1);
    expect(pipeline.spawnWorker).toHaveBeenCalledWith(
      expect.objectContaining({ number: 1 }),
      expect.anything(),
      expect.anything()
    );
  });

  test('does not respawn already-spawned issues on subsequent polls', async () => {
    mockOctokit.issues.listForRepo.mockResolvedValue({
      data: [makeIssue(1)],
    });

    pipeline.watchIssues('test-project', { owner: 'o', repo: 'r' });

    jest.advanceTimersByTime(5001);
    await flushAsync();

    jest.advanceTimersByTime(30001);
    await flushAsync();

    expect(pipeline.spawnWorker).toHaveBeenCalledTimes(1);
  });
});

describe('Pipeline.watchPRs', () => {
  let pipeline;
  let mockTechLead;

  beforeEach(() => {
    jest.useFakeTimers();
    pipeline = new Pipeline();
    mockTechLead = { reviewPR: jest.fn().mockResolvedValue({ approved: true }) };
    pipeline.activeProjects['test-project'] = { channels: {}, techLead: mockTechLead };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function flushAsync(ticks = 10) {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  }

  test('triggers Tech Lead review for each open PR', async () => {
    mockOctokit.pulls.list.mockResolvedValue({
      data: [{ number: 10 }, { number: 11 }],
    });

    pipeline.watchPRs('test-project', { owner: 'o', repo: 'r' });
    jest.advanceTimersByTime(10001);
    await flushAsync();

    expect(mockTechLead.reviewPR).toHaveBeenCalledTimes(2);
  });

  test('skips a draft PR without calling reviewPR', async () => {
    mockOctokit.pulls.list.mockResolvedValue({
      data: [{ number: 5, draft: true }],
    });

    pipeline.watchPRs('test-project', { owner: 'o', repo: 'r' });
    jest.advanceTimersByTime(10001);
    await flushAsync();

    expect(mockTechLead.reviewPR).not.toHaveBeenCalled();
  });

  test('re-evaluates a draft PR on the next poll after it is promoted', async () => {
    mockOctokit.pulls.list
      .mockResolvedValueOnce({ data: [{ number: 5, draft: true }] })
      .mockResolvedValueOnce({ data: [{ number: 5, draft: false }] });

    pipeline.watchPRs('test-project', { owner: 'o', repo: 'r' });
    jest.advanceTimersByTime(10001);
    await flushAsync();

    expect(mockTechLead.reviewPR).not.toHaveBeenCalled();

    jest.advanceTimersByTime(300001);
    await flushAsync();

    expect(mockTechLead.reviewPR).toHaveBeenCalledWith(5, expect.anything());
  });

  test('does not re-review already reviewed PRs on subsequent polls', async () => {
    mockOctokit.pulls.list.mockResolvedValue({
      data: [{ number: 10 }],
    });

    pipeline.watchPRs('test-project', { owner: 'o', repo: 'r' });

    jest.advanceTimersByTime(10001);
    await flushAsync();

    jest.advanceTimersByTime(30001);
    await flushAsync();

    expect(mockTechLead.reviewPR).toHaveBeenCalledTimes(1);
  });
});

describe('Pipeline.spawnManagers', () => {
  const makeSpec = () => ({
    spec: { projectName: 'test-project', deliverables: [] },
  });

  async function flushPromises(ticks = 5) {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  }

  let pipeline;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateProjectChannel.mockResolvedValue({ channelId: 'ch-123', webhookUrl: null });
    mockDb.saveProject.mockReturnValue(undefined);
    pipeline = new Pipeline({ db: mockDb });
    pipeline.watchIssues = jest.fn();
    pipeline.watchPRs = jest.fn();
  });

  test('starts watchers when PM succeeds with a valid projectRepo', async () => {
    const PMAgent = require('../../src/agents/managers/pm');
    PMAgent.mockImplementation(() => ({
      run: jest.fn().mockResolvedValue(undefined),
      projectRepo: { owner: 'o', repo: 'r' },
      estimate: { hours: 8 },
    }));

    await pipeline.spawnManagers(makeSpec());
    await flushPromises();

    expect(pipeline.watchIssues).toHaveBeenCalledWith('test-project', { owner: 'o', repo: 'r' });
    expect(pipeline.watchPRs).toHaveBeenCalledWith('test-project', { owner: 'o', repo: 'r' });
    expect(mockDb.saveProject).toHaveBeenCalledWith('test-project', expect.objectContaining({
      projectRepo: { owner: 'o', repo: 'r' },
    }));
  });

  test('does not start watchers when PM succeeds but projectRepo is null', async () => {
    const PMAgent = require('../../src/agents/managers/pm');
    PMAgent.mockImplementation(() => ({
      run: jest.fn().mockResolvedValue(undefined),
      projectRepo: null,
      estimate: null,
    }));

    await pipeline.spawnManagers(makeSpec());
    await flushPromises();

    expect(pipeline.watchIssues).not.toHaveBeenCalled();
    expect(pipeline.watchPRs).not.toHaveBeenCalled();
    expect(mockDb.saveProject).not.toHaveBeenCalled();
  });

  test('does not start watchers when PM throws', async () => {
    const PMAgent = require('../../src/agents/managers/pm');
    PMAgent.mockImplementation(() => ({
      run: jest.fn().mockRejectedValue(new Error('PM crashed hard')),
      projectRepo: null,
      estimate: null,
    }));

    await pipeline.spawnManagers(makeSpec());
    await flushPromises();

    expect(pipeline.watchIssues).not.toHaveBeenCalled();
    expect(pipeline.watchPRs).not.toHaveBeenCalled();
  });
});

describe('Pipeline.closeProject', () => {
  let pipeline;
  const existingHistory = { projects: [{ projectName: 'old-project' }] };
  const existingContent = Buffer.from(JSON.stringify(existingHistory)).toString('base64');

  beforeEach(() => {
    pipeline = new Pipeline();
    pipeline.activeProjects['test-project'] = {
      pm: { estimate: { hours: 10, cost: 200, currency: 'CAD' }, discard: jest.fn().mockResolvedValue(undefined) },
      techLead: { discard: jest.fn().mockResolvedValue(undefined) },
      channels: {},
    };
    mockOctokit.repos.getContent.mockResolvedValue({ data: { content: existingContent, sha: 'abc123' } });
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});
  });

  test('appends new entry with correct schema to bessemer-state', async () => {
    await pipeline.closeProject('test-project');
    const call = mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    const written = JSON.parse(Buffer.from(call.content, 'base64').toString('utf8'));
    const newEntry = written.projects[1];
    expect(newEntry).toMatchObject({
      projectName: 'test-project',
      closedAt: expect.any(String),
      estimate: { hours: 10, cost: 200, currency: 'CAD' },
      actuals: { hours: 10, cost: 200, currency: 'CAD' },
      variance: 0,
      notes: expect.any(String),
    });
  });

  test('writes projectType from spec into bessemer-state entry', async () => {
    pipeline.activeProjects['test-project'].spec = { projectType: 'api-service' };
    await pipeline.closeProject('test-project');
    const call = mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    const written = JSON.parse(Buffer.from(call.content, 'base64').toString('utf8'));
    expect(written.projects[1].projectType).toBe('api-service');
  });

  test('writes null projectType when spec is missing', async () => {
    await pipeline.closeProject('test-project');
    const call = mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    const written = JSON.parse(Buffer.from(call.content, 'base64').toString('utf8'));
    expect(written.projects[1].projectType).toBeNull();
  });

  test('preserves existing bessemer-state entries (append-only)', async () => {
    await pipeline.closeProject('test-project');
    const call = mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    const written = JSON.parse(Buffer.from(call.content, 'base64').toString('utf8'));
    expect(written.projects).toHaveLength(2);
    expect(written.projects[0].projectName).toBe('old-project');
  });

  test('uses correct SHA when writing to bessemer-state', async () => {
    await pipeline.closeProject('test-project');
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'abc123' })
    );
  });

  test('still closes project when bessemer-state write fails', async () => {
    mockOctokit.repos.getContent.mockRejectedValue(new Error('network error'));
    await expect(pipeline.closeProject('test-project')).resolves.not.toThrow();
    expect(pipeline.activeProjects['test-project']).toBeUndefined();
  });

  test('discards PM and Tech Lead agents on close', async () => {
    const pm = pipeline.activeProjects['test-project'].pm;
    const techLead = pipeline.activeProjects['test-project'].techLead;
    await pipeline.closeProject('test-project');
    expect(pm.discard).toHaveBeenCalled();
    expect(techLead.discard).toHaveBeenCalled();
  });

  test('removes project from activeProjects', async () => {
    await pipeline.closeProject('test-project');
    expect(pipeline.activeProjects['test-project']).toBeUndefined();
  });

  test('archives project channel when it differs from the director channel', async () => {
    process.env.DISCORD_GUILD_ID = 'guild-1';
    mockArchiveProjectChannel.mockResolvedValue(undefined);
    pipeline.director = { client: {} };
    pipeline.activeProjects['test-project'].channels = { managers: 'ch-project-123' };

    await pipeline.closeProject('test-project');

    expect(mockArchiveProjectChannel).toHaveBeenCalledWith({}, 'ch-project-123', 'guild-1');
  });

  test('does not archive when project channel is the shared director channel', async () => {
    pipeline.activeProjects['test-project'].channels = {
      managers: process.env.DISCORD_CHANNEL_DIRECTOR,
    };

    await pipeline.closeProject('test-project');

    expect(mockArchiveProjectChannel).not.toHaveBeenCalled();
  });

  test('marks project as closed in DB', async () => {
    await pipeline.closeProject('test-project');
    expect(mockDb.closeProject).toHaveBeenCalledWith('test-project');
  });
});

describe('Pipeline.resume', () => {
  const makeRow = (overrides = {}) => ({
    name: 'test-project',
    spec: { projectName: 'test-project', projectType: 'web-app', architecture: { techStack: { language: 'js', runtime: 'node', packages: [] } } },
    channels: { managers: 'ch-managers' },
    projectRepo: { owner: 'o', repo: 'r' },
    estimate: { hours: 10, cost: 200, currency: 'CAD' },
    ...overrides,
  });

  let pipeline;

  beforeEach(() => {
    jest.useFakeTimers();
    mockDb.getOpenProjects.mockReturnValue([]);
    mockOctokit.pulls.list.mockResolvedValue({ data: [] });
    pipeline = new Pipeline({ db: mockDb });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function flushAsync(ticks = 20) {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  }

  test('does nothing when no open projects', async () => {
    mockDb.getOpenProjects.mockReturnValue([]);
    await pipeline.resume();
    expect(pipeline.activeProjects).toEqual({});
  });

  test('restores a project into activeProjects', async () => {
    mockDb.getOpenProjects.mockReturnValue([makeRow()]);
    await pipeline.resume();
    expect(pipeline.activeProjects['test-project']).toBeDefined();
  });

  test('sets pm.projectRepo and pm.estimate from DB row', async () => {
    mockDb.getOpenProjects.mockReturnValue([makeRow()]);
    await pipeline.resume();
    const { pm } = pipeline.activeProjects['test-project'];
    expect(pm.projectRepo).toEqual({ owner: 'o', repo: 'r' });
    expect(pm.estimate).toEqual({ hours: 10, cost: 200, currency: 'CAD' });
  });

  test('starts watchers for each resumed project', async () => {
    mockDb.getOpenProjects.mockReturnValue([makeRow()]);
    pipeline.watchIssues = jest.fn();
    pipeline.watchPRs = jest.fn();
    await pipeline.resume();
    expect(pipeline.watchIssues).toHaveBeenCalledWith('test-project', { owner: 'o', repo: 'r' });
    expect(pipeline.watchPRs).toHaveBeenCalledWith('test-project', { owner: 'o', repo: 'r' });
  });

  test('skips a project when projectRepo is null', async () => {
    mockDb.getOpenProjects.mockReturnValue([makeRow({ projectRepo: null })]);
    pipeline.watchIssues = jest.fn();
    await pipeline.resume();
    expect(pipeline.watchIssues).not.toHaveBeenCalled();
    expect(pipeline.activeProjects['test-project']).toBeUndefined();
  });

  test('pre-populates spawnedIssues from open PRs', async () => {
    mockOctokit.pulls.list.mockResolvedValue({
      data: [{ number: 10, body: 'Closes #3' }, { number: 11, body: 'Closes #5' }],
    });
    mockDb.getOpenProjects.mockReturnValue([makeRow()]);
    pipeline.watchIssues = jest.fn();
    pipeline.watchPRs = jest.fn();
    await pipeline.resume();
    const { spawnedIssues } = pipeline.activeProjects['test-project'];
    expect(spawnedIssues.has(3)).toBe(true);
    expect(spawnedIssues.has(5)).toBe(true);
    expect(spawnedIssues.has(1)).toBe(false);
  });

  test('continues resuming other projects if one fails', async () => {
    const badRow = makeRow({ name: 'bad-project' });
    const goodRow = makeRow({ name: 'good-project' });
    mockDb.getOpenProjects.mockReturnValue([badRow, goodRow]);

    const TechLeadAgent = require('../../src/agents/managers/techlead');
    TechLeadAgent
      .mockImplementationOnce(() => { throw new Error('instantiation failed'); })
      .mockImplementationOnce(() => ({ run: jest.fn().mockResolvedValue(undefined), discard: jest.fn() }));

    pipeline.watchIssues = jest.fn();
    pipeline.watchPRs = jest.fn();
    await pipeline.resume();

    expect(pipeline.activeProjects['good-project']).toBeDefined();
    expect(pipeline.activeProjects['bad-project']).toBeUndefined();
  });
});
