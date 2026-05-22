const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

class Workspace {
  constructor({ repoUrl, branch = 'main', token, timeoutMs = 300000 }) {
    this.repoUrl = repoUrl;
    this.branch = branch;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.workdir = null;
  }

  async boot() {
    this.workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'adt-workspace-'));
    try {
      const result = await this._exec(`git clone --depth 1 --branch ${this.branch} ${this._authUrl()} .`);
      if (result.exitCode !== 0) {
        throw new Error(`git clone failed (exit ${result.exitCode}): ${result.stderr}`);
      }
    } catch (err) {
      await this.teardown();
      throw err;
    }
  }

  async exec(cmd) {
    if (!this.workdir) throw new Error('Workspace not booted — call boot() first');
    return this._exec(cmd);
  }

  async readFile(filePath) {
    if (!this.workdir) throw new Error('Workspace not booted — call boot() first');
    return fs.readFile(path.join(this.workdir, filePath), 'utf8');
  }

  async writeFile(filePath, content) {
    if (!this.workdir) throw new Error('Workspace not booted — call boot() first');
    const abs = path.join(this.workdir, filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async listDir(dirPath) {
    if (!this.workdir) throw new Error('Workspace not booted — call boot() first');
    return fs.readdir(path.join(this.workdir, dirPath));
  }

  async teardown() {
    if (!this.workdir) return;
    const dir = this.workdir;
    this.workdir = null;
    await fs.rm(dir, { recursive: true, force: true });
  }

  _authUrl() {
    // Token embedded in URL only for git clone — never logged
    const parsed = new URL(this.repoUrl);
    parsed.username = 'x-access-token';
    parsed.password = this.token;
    return parsed.toString();
  }

  async _exec(cmd) {
    try {
      const { stdout, stderr } = await exec(cmd, {
        cwd: this.workdir,
        timeout: this.timeoutMs,
      });
      return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
    } catch (err) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.code ?? 1,
      };
    }
  }
}

module.exports = Workspace;
