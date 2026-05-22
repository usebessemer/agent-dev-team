const path = require('path');

// Must be hoisted before Workspace is required so promisify picks up the mock
jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  mkdtemp: jest.fn(),
  rm: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  mkdir: jest.fn(),
  readdir: jest.fn(),
}));

const childProcess = require('child_process');
const fsp = require('fs/promises');
const Workspace = require('../../src/workspace/index');

const WORKDIR = '/tmp/adt-workspace-abc123';
const REPO_URL = 'https://github.com/test-owner/test-repo.git';
const TOKEN = 'ghp_testtoken';

function makeExecResult(stdout = '', stderr = '', exitCode = 0) {
  if (exitCode === 0) {
    return (cmd, opts, cb) => cb(null, { stdout, stderr });
  }
  const err = Object.assign(new Error('Command failed'), { stdout, stderr, code: exitCode });
  return (cmd, opts, cb) => cb(err);
}

function mockExecSuccess(stdout = '', stderr = '') {
  childProcess.exec.mockImplementation(makeExecResult(stdout, stderr, 0));
}

function mockExecFailure(exitCode = 1, stderr = 'command failed') {
  childProcess.exec.mockImplementation(makeExecResult('', stderr, exitCode));
}

beforeEach(() => {
  jest.clearAllMocks();
  fsp.mkdtemp.mockResolvedValue(WORKDIR);
  fsp.rm.mockResolvedValue(undefined);
  fsp.mkdir.mockResolvedValue(undefined);
  fsp.writeFile.mockResolvedValue(undefined);
});

function makeWorkspace(overrides = {}) {
  return new Workspace({
    repoUrl: REPO_URL,
    branch: 'main',
    token: TOKEN,
    ...overrides,
  });
}

describe('Workspace.boot', () => {
  test('creates temp dir and clones repo', async () => {
    mockExecSuccess();
    const sb = makeWorkspace();
    await sb.boot();

    expect(fsp.mkdtemp).toHaveBeenCalledTimes(1);
    expect(childProcess.exec).toHaveBeenCalledTimes(1);
    const [cmd] = childProcess.exec.mock.calls[0];
    expect(cmd).toContain('git clone');
    expect(cmd).toContain('--depth 1');
    expect(cmd).toContain('--branch main');
    expect(sb.workdir).toBe(WORKDIR);
  });

  test('embeds token in clone URL without logging it', async () => {
    mockExecSuccess();
    const sb = makeWorkspace();
    await sb.boot();

    const [cmd] = childProcess.exec.mock.calls[0];
    expect(cmd).toContain('x-access-token');
    expect(cmd).toContain(TOKEN);
  });

  test('teardown is called and error re-thrown if clone fails', async () => {
    mockExecFailure(128, 'repository not found');
    const sb = makeWorkspace();

    await expect(sb.boot()).rejects.toThrow();
    expect(fsp.rm).toHaveBeenCalledWith(WORKDIR, { recursive: true, force: true });
    expect(sb.workdir).toBeNull();
  });
});

describe('Workspace.exec', () => {
  test('runs command in workdir and returns stdout/stderr/exitCode', async () => {
    mockExecSuccess('hello', '');
    const sb = makeWorkspace();
    sb.workdir = WORKDIR;

    const result = await sb.exec('echo hello');
    expect(result).toEqual({ stdout: 'hello', stderr: '', exitCode: 0 });
  });

  test('returns non-zero exitCode without throwing on command failure', async () => {
    mockExecFailure(1, 'npm ERR! missing script: test');
    const sb = makeWorkspace();
    sb.workdir = WORKDIR;

    const result = await sb.exec('npm test');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('npm ERR!');
  });

  test('throws if called before boot', async () => {
    const sb = makeWorkspace();
    await expect(sb.exec('ls')).rejects.toThrow('Workspace not booted');
  });
});

describe('Workspace.readFile', () => {
  test('reads file relative to workdir', async () => {
    fsp.readFile.mockResolvedValue('file contents');
    const sb = makeWorkspace();
    sb.workdir = WORKDIR;

    const result = await sb.readFile('src/index.js');
    expect(fsp.readFile).toHaveBeenCalledWith(
      path.join(WORKDIR, 'src/index.js'),
      'utf8'
    );
    expect(result).toBe('file contents');
  });

  test('throws if called before boot', async () => {
    const sb = makeWorkspace();
    await expect(sb.readFile('README.md')).rejects.toThrow('Workspace not booted');
  });
});

describe('Workspace.writeFile', () => {
  test('creates parent dirs and writes file relative to workdir', async () => {
    const sb = makeWorkspace();
    sb.workdir = WORKDIR;

    await sb.writeFile('src/new/file.js', 'content');
    expect(fsp.mkdir).toHaveBeenCalledWith(
      path.join(WORKDIR, 'src/new'),
      { recursive: true }
    );
    expect(fsp.writeFile).toHaveBeenCalledWith(
      path.join(WORKDIR, 'src/new/file.js'),
      'content',
      'utf8'
    );
  });

  test('throws if called before boot', async () => {
    const sb = makeWorkspace();
    await expect(sb.writeFile('file.js', '')).rejects.toThrow('Workspace not booted');
  });
});

describe('Workspace.listDir', () => {
  test('lists directory relative to workdir', async () => {
    fsp.readdir.mockResolvedValue(['a.js', 'b.js']);
    const sb = makeWorkspace();
    sb.workdir = WORKDIR;

    const entries = await sb.listDir('src');
    expect(fsp.readdir).toHaveBeenCalledWith(path.join(WORKDIR, 'src'));
    expect(entries).toEqual(['a.js', 'b.js']);
  });

  test('throws if called before boot', async () => {
    const sb = makeWorkspace();
    await expect(sb.listDir('.')).rejects.toThrow('Workspace not booted');
  });
});

describe('Workspace.teardown', () => {
  test('removes workdir and sets it to null', async () => {
    const sb = makeWorkspace();
    sb.workdir = WORKDIR;

    await sb.teardown();
    expect(fsp.rm).toHaveBeenCalledWith(WORKDIR, { recursive: true, force: true });
    expect(sb.workdir).toBeNull();
  });

  test('is a no-op if called before boot', async () => {
    const sb = makeWorkspace();
    await expect(sb.teardown()).resolves.not.toThrow();
    expect(fsp.rm).not.toHaveBeenCalled();
  });

  test('is safe to call twice', async () => {
    const sb = makeWorkspace();
    sb.workdir = WORKDIR;

    await sb.teardown();
    await sb.teardown();
    expect(fsp.rm).toHaveBeenCalledTimes(1);
  });
});
