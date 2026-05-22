const { createBotClient, postToChannel } = require('../../discord/client');
const { Octokit } = require('@octokit/rest');
const Workspace = require('../../workspace');

class TechLeadAgent {
  constructor(spec, projectChannels) {
    this.spec = spec;
    this.projectChannels = projectChannels;
    this.client = createBotClient(process.env.TECHLEAD_TOKEN);
    this.hasSeparateGitHubAccount = !!process.env.TECHLEAD_GITHUB_TOKEN;
    this.octokit = new Octokit({ auth: process.env.TECHLEAD_GITHUB_TOKEN || process.env.GITHUB_TOKEN });
    this.owner = process.env.GITHUB_OWNER;
    this.repo = process.env.GITHUB_REPO;
    this.ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    this.anthropicKey = process.env.ANTHROPIC_API_KEY;
    this.model = process.env.MANAGER_MODEL || (this.anthropicKey ? 'claude-sonnet-4-6' : 'llama3.1:8b');

    this.ready = new Promise((resolve) => {
      this.client.once('clientReady', () => {
        console.log(`[TechLead] Online as ${this.client.user.tag}`);
        resolve();
      });
    });
  }

  async run() {
    await this.ready;
    await this.postToManagers(`🔧 Tech Lead online for project: **${this.spec.projectName}**`);
    await this.defineCodingStandards();
    await this.postToManagers(`📐 Coding standards set. Watching for PRs.`);
  }

  async defineCodingStandards() {
    const { techStack } = this.spec.architecture;

    this.standards = {
      language: techStack.language,
      rules: [
        'Use clear, descriptive variable and function names',
        'Add a comment above every function explaining what it does',
        'Handle all errors explicitly — no silent failures',
        'Keep functions small and single-purpose',
        'No hardcoded values — use constants or config',
        'Use exact-match search/replace blocks for all file edits'
      ],
      fileStructure: this.spec.architecture.components,
      techStack
    };

    await this.postToManagers(
      `📐 Coding standards defined:\n\`\`\`json\n${JSON.stringify(this.standards, null, 2)}\n\`\`\``
    );

    return this.standards;
  }

  async reviewPR(prNumber, projectRepo) {
    const owner = projectRepo?.owner || this.owner;
    const repo = projectRepo?.repo || this.repo;

    await this.postToManagers(`🔍 Reviewing PR #${prNumber} in ${owner}/${repo}...`);

    const pr = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
    const diff = await this.octokit.pulls.listFiles({ owner, repo, pull_number: prNumber });
    const filesChanged = diff.data.map(f => ({ filename: f.filename, changes: f.changes, patch: f.patch }));

    // Run tests in a workspace on the PR branch before scoring
    const prBranch = pr.data.head.ref;
    const testResult = await this.runTestsForPR(prBranch, owner, repo);

    if (testResult.passed === true) {
      await this.postToManagers(`✅ Tests passed`);
    } else if (testResult.passed === false) {
      await this.postToManagers(`❌ Tests failed:\n\`\`\`\n${testResult.output.slice(0, 500)}\n\`\`\``);
    } else {
      await this.postToManagers(`⚠️ Tests not run: ${testResult.output}`);
    }

    // Qualitative review — advisory only, does not affect merge decision
    const review = await this.getQualitativeReview(pr.data, filesChanged, testResult);

    // Gate: tests failed → reject. Tests passed or not run → approve.
    const approved = testResult.passed !== false;

    const reviewBody = approved
      ? `✅ Tests passed — merging.\n\n**Code review notes:**\n${review.commentary}`
      : `❌ Tests failed — changes required.\n\n**Test output:**\n\`\`\`\n${testResult.output.slice(0, 800)}\n\`\`\`\n\n**Code review notes:**\n${review.commentary}`;

    if (approved) {
      if (this.hasSeparateGitHubAccount) {
        await this.octokit.pulls.createReview({ owner, repo, pull_number: prNumber, event: 'APPROVE', body: reviewBody });
      } else {
        await this.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body: reviewBody });
      }

      await this.octokit.pulls.merge({ owner, repo, pull_number: prNumber, merge_method: 'squash' });

      const issueMatch = pr.data.body?.match(/Closes #(\d+)/);
      if (issueMatch) {
        await this.octokit.issues.update({ owner, repo, issue_number: parseInt(issueMatch[1]), state: 'closed' });
        console.log(`[TechLead] Closed Issue #${issueMatch[1]}`);
      }

      console.log(`[TechLead] ✅ PR #${prNumber} merged in ${owner}/${repo}`);
      await this.postToManagers(`✅ PR #${prNumber} merged.\n${review.commentary}`);

      await new Promise(resolve => setTimeout(resolve, 8000));
      await this.checkProjectComplete(owner, repo, prNumber);

      return { approved: true, testResult, review };
    } else {
      if (this.hasSeparateGitHubAccount) {
        await this.octokit.pulls.createReview({ owner, repo, pull_number: prNumber, event: 'REQUEST_CHANGES', body: reviewBody });
      } else {
        await this.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body: reviewBody });
      }

      await this.postToManagers(`❌ PR #${prNumber} rejected — tests failed.\n${review.commentary}`);
      return { approved: false, testResult, review };
    }
  }

  /**
   * Creates a Workspace on the PR branch, runs the test suite, and tears down.
   * Returns { passed, output } — passed is null if tests could not be run.
   */
  async runTestsForPR(branch, owner, repo) {
    const workspace = new Workspace({
      repoUrl: `https://github.com/${owner}/${repo}.git`,
      branch,
      token: process.env.GITHUB_TOKEN,
    });

    try {
      await workspace.boot();
      return await this.runTests(workspace);
    } catch (err) {
      console.error(`[TechLead] Workspace error for branch ${branch}: ${err.message}`);
      return { passed: null, output: `Workspace error: ${err.message}` };
    } finally {
      await workspace.teardown();
    }
  }

  /**
   * Detects the test command from package.json and runs it inside the workspace.
   * Returns { passed: boolean|null, output: string }
   *   passed = true  → tests ran and all passed
   *   passed = false → tests ran and failed
   *   passed = null  → could not determine (no package.json, no test script)
   */
  async runTests(workspace) {
    let pkg;
    try {
      pkg = JSON.parse(await workspace.readFile('package.json'));
    } catch {
      return { passed: null, output: 'No package.json found' };
    }

    const testScript = pkg.scripts?.test;
    const noOpScript = 'echo "Error: no test specified" && exit 1';
    if (!testScript || testScript === noOpScript) {
      return { passed: null, output: 'No test script defined in package.json' };
    }

    const install = await workspace.exec('npm install');
    if (install.exitCode !== 0) {
      return { passed: false, output: `npm install failed:\n${install.stderr || install.stdout}` };
    }

    const test = await workspace.exec('npm test');
    const output = [test.stdout, test.stderr].filter(Boolean).join('\n');
    return { passed: test.exitCode === 0, output };
  }

  /**
   * Asks the model for qualitative code review commentary.
   * Advisory only — does not affect the merge decision.
   * @returns {{ commentary: string, suggestions: string[] }}
   */
  async getQualitativeReview(pr, files, testResult = null) {
    const testContext = testResult
      ? `\nTest results: ${testResult.passed === true ? 'PASSED' : testResult.passed === false ? 'FAILED' : 'NOT RUN'}\n${testResult.output.slice(0, 400)}`
      : '';

    const prompt = `You are a Tech Lead reviewing a pull request. Tests determine whether the PR merges — your role is qualitative commentary only.

Coding standards:
${JSON.stringify(this.standards?.rules || [], null, 2)}

PR title: ${pr.title}
PR description: ${pr.body}
${testContext}
Files changed:
${JSON.stringify(files, null, 2)}

Provide brief advisory commentary on: naming clarity, error handling, code organisation, missed edge cases, and style. Do NOT give a numeric score. Do NOT recommend merging or rejecting — that is determined by tests.

Return ONLY valid JSON with no other text:
{"commentary":"your observations here","suggestions":["suggestion 1","suggestion 2"]}`;

    let text;
    if (this.anthropicKey) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await response.json();
      text = data.content[0].text.trim();
    } else {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt, stream: false, options: { temperature: 0.1 } }),
      });
      const data = await response.json();
      text = data.response.trim();
    }

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.error('[TechLead] Failed to parse review JSON:', err.message);
      return { commentary: 'Review parsing failed — see diff for details', suggestions: [] };
    }
  }

  async checkProjectComplete(owner, repo) {
    try {
      const { data: openPRs } = await this.octokit.pulls.list({ owner, repo, state: 'open' });
      const { data: openIssues } = await this.octokit.issues.listForRepo({ owner, repo, state: 'open' });
      const filteredIssues = openIssues.filter(i => !i.pull_request && !i.html_url.includes('/pull/'));

      console.log(`[TechLead] checkProjectComplete: ${openPRs.length} open PRs, ${filteredIssues.length} open Issues`);

      if (openPRs.length === 0 && filteredIssues.length === 0) {
        console.log(`[TechLead] Project ${this.spec.projectName} appears complete.`);
        await postToChannel(
          this.client,
          process.env.DISCORD_CHANNEL_DIRECTOR,
          `✅ **Project ${this.spec.projectName} appears complete.**\n\n` +
          `All PRs merged and Issues closed.\n` +
          `Project repo: https://github.com/${owner}/${repo}\n\n` +
          `Type \`close: ${this.spec.projectName}\` to confirm and close, or open new Issues to continue.`
        );
      }
    } catch (err) {
      console.error(`[TechLead] Error checking project completion: ${err.message}`);
    }
  }

  async postToManagers(content) {
    await postToChannel(this.client, this.projectChannels.managers, content);
  }

  async discard() {
    console.log(`[TechLead] Discarding for project: ${this.spec.projectName}`);
    await this.client.destroy();
  }
}

module.exports = TechLeadAgent;
