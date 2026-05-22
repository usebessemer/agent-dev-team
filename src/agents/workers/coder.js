const { createWebhookClient, postAsWorker } = require('../../discord/client');
const { Octokit } = require('@octokit/rest');
const Workspace = require('../../workspace');

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the project repository.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the project repository. Creates parent directories as needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and directories at a path in the project repository.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to repo root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'exec',
    description: 'Run a shell command in the project directory. Returns stdout, stderr, and exitCode.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
  },
  {
    name: 'done',
    description: 'Signal that all required files have been written and the task is complete.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Short description of what was built' },
      },
      required: ['summary'],
    },
  },
];

const SYSTEM_PROMPT = `You are a Coder agent. You implement GitHub Issues by reading the project repository, writing code, and running commands to verify your work.

Use tools to explore the repo, write files, install dependencies, and run tests. When the task is complete and tests pass, call done().

Rules:
- Always read existing files before overwriting them
- Write automated tests for the code you produce, in the same task and PR
- Run the tests after writing them; do not call done() until tests exist and pass
- Only call done() when the task is fully implemented and verified`;

class CoderAgent {
  constructor(issue, projectChannels, projectRepo) {
    this.issue = issue;
    this.projectChannels = projectChannels;
    this.octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    this.owner = projectRepo?.owner || process.env.GITHUB_OWNER;
    this.repo = projectRepo?.repo || process.env.GITHUB_REPO;
    this.ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    this.model = process.env.WORKER_MODEL || 'llama3.2:latest';
    this.anthropicKey = process.env.ANTHROPIC_API_KEY;
    this.agentName = `Coder-task-${issue.number}`;
    this.branchName = `coder/${issue.number}/${this.slugify(issue.title)}`;
    this.maxIterations = parseInt(process.env.CODER_MAX_ITERATIONS) || 25;
    this.webhook = null;
  }

  async run() {
    await this.log(`🚀 Spawned for Issue #${this.issue.number}: ${this.issue.title}`);

    const workspace = new Workspace({
      repoUrl: `https://github.com/${this.owner}/${this.repo}.git`,
      branch: 'main',
      token: process.env.GITHUB_TOKEN,
    });

    try {
      await workspace.boot();
      await this.log(`📦 Workspace ready`);

      const checkout = await workspace.exec(`git checkout -b ${this.branchName}`);
      if (checkout.exitCode !== 0) throw new Error(`Branch creation failed: ${checkout.stderr}`);

      await this.agenticLoop(workspace);
      await this.commitAndPush(workspace);
      await this.openPR();
      await this.log(`✅ PR opened for Issue #${this.issue.number}. Discarding.`);
    } catch (err) {
      await this.log(`❌ Fatal error on Issue #${this.issue.number}: ${err.message}`);
      await this.escalate(err.message);
    } finally {
      await workspace.teardown();
    }
  }

  async agenticLoop(workspace) {
    const useClaude = !!this.anthropicKey;
    const listing = await workspace.listDir('.');
    const userPrompt = `Task: ${this.issue.title}\n\n${this.issue.body}\n\nRepo root contains: ${listing.join(', ')}`;

    const messages = [{ role: 'user', content: userPrompt }];

    for (let i = 0; i < this.maxIterations; i++) {
      const response = await this.callModel(messages, useClaude);

      if (response.tool === 'done') {
        await this.log(`✅ Agent done: ${response.args.summary}`);
        return;
      }

      if (response.toolUses) {
        // Claude path — one or more parallel tool_use blocks in a single response
        const toolResults = [];
        for (const toolUse of response.toolUses) {
          await this.log(`🔧 ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
          let result;
          try {
            result = await this.executeTool(toolUse.name, toolUse.input, workspace);
          } catch (err) {
            result = `Error: ${err.message}`;
          }
          const resultStr = typeof result === 'object' ? JSON.stringify(result) : String(result ?? '');
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: resultStr });
        }
        messages.push({ role: 'assistant', content: response.raw });
        messages.push({ role: 'user', content: toolResults });
      } else {
        // Ollama path — single tool per response
        await this.log(`🔧 ${response.tool}(${JSON.stringify(response.args)})`);
        let toolResult;
        try {
          toolResult = await this.executeTool(response.tool, response.args, workspace);
        } catch (err) {
          toolResult = `Error: ${err.message}`;
        }
        const resultStr = typeof toolResult === 'object' ? JSON.stringify(toolResult) : String(toolResult ?? '');
        messages.push({ role: 'assistant', content: response.raw });
        messages.push({ role: 'user', content: `Tool result:\n${resultStr}` });
      }
    }

    await this.log(`⚠️ Max iterations reached — committing what was written`);
  }

  async callModel(messages, useClaude) {
    if (useClaude) return this.callClaude(messages);
    return this.callOllama(messages);
  }

  async callClaude(messages) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) throw new Error(`Claude API error ${response.status}: ${data.error?.message}`);

    const toolUses = data.content?.filter(b => b.type === 'tool_use') || [];
    if (toolUses.length > 0) {
      return { toolUses, raw: data.content };
    }

    const text = data.content?.find(b => b.type === 'text')?.text || 'Task complete';
    return { tool: 'done', args: { summary: text }, id: null, raw: data.content };
  }

  async callOllama(messages) {
    const history = messages
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n\n');

    const prompt = `${SYSTEM_PROMPT}

Available tools (respond with JSON only — no markdown):
${TOOLS.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Format: {"tool":"<name>","args":{<params>}}

${history}

assistant:`;

    const response = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: false, options: { temperature: 0.1 } }),
    });

    const data = await response.json();
    const text = (data.response || '').trim();

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON');
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.tool) throw new Error('No tool field');
      return { tool: parsed.tool, args: parsed.args || {}, id: null, raw: text };
    } catch {
      return { tool: 'done', args: { summary: text || 'Task complete' }, id: null, raw: text };
    }
  }

  async executeTool(name, args, workspace) {
    switch (name) {
      case 'read_file': return workspace.readFile(args.path);
      case 'write_file': await workspace.writeFile(args.path, args.content); return 'written';
      case 'list_dir': return workspace.listDir(args.path);
      case 'exec': return workspace.exec(args.command);
      default: return `Unknown tool: ${name}`;
    }
  }

  async commitAndPush(workspace) {
    const status = await workspace.exec('git status --porcelain');
    if (!status.stdout.trim()) {
      throw new Error('No files were written — nothing to commit');
    }

    let hasGitignore = false;
    try {
      await workspace.readFile('.gitignore');
      hasGitignore = true;
    } catch {
      hasGitignore = false;
    }
    if (!hasGitignore) {
      const stack = await this._detectStack(workspace);
      await workspace.writeFile('.gitignore', this._gitignoreContent(stack));
    }

    await workspace.exec('git add -A');
    const commit = await workspace.exec(
      `git -c user.name="Coder Agent" -c user.email="coder@adt.local" commit -m "[coder-${this.issue.number}] ${this.issue.title}"`
    );
    if (commit.exitCode !== 0) throw new Error(`Commit failed: ${commit.stderr}`);

    const push = await workspace.exec(`git push origin ${this.branchName}`);
    if (push.exitCode !== 0) throw new Error(`Push failed: ${push.stderr}`);

    await this.log(`🚢 Branch pushed: ${this.branchName}`);
  }

  async _detectStack(workspace) {
    try {
      const files = await workspace.listDir('.');
      if (files.includes('package.json')) return 'node';
      if (files.some(f => ['requirements.txt', 'setup.py', 'pyproject.toml'].includes(f))) return 'python';
      if (files.includes('go.mod')) return 'go';
    } catch {
      // if listing fails, fall through to combined default
    }
    return null;
  }

  _gitignoreContent(stack) {
    const node = 'node_modules/\ndist/\n*.log\n';
    const python = '__pycache__/\n*.pyc\n*.pyo\n.coverage\n.pytest_cache/\n*.egg-info/\nbuild/\ndist/\n';
    const go = '*.exe\n*.test\nbuild/\n';
    if (stack === 'node') return node;
    if (stack === 'python') return python;
    if (stack === 'go') return go;
    return `${node}${python}${go}`;
  }

  async openPR() {
    const { data: pr } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: `[coder-${this.issue.number}] ${this.issue.title}`,
      head: this.branchName,
      base: 'main',
      body: `Closes #${this.issue.number}\n\nOpened by ${this.agentName}.`,
    });

    await this.octokit.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: this.issue.number,
      labels: ['status:review'],
    });

    await this.log(`🔀 PR #${pr.number} opened: ${pr.html_url}`);
  }

  async escalate(reason) {
    await this.log(`🚨 Escalating: ${reason}`);

    try {
      const { postToChannel, createBotClient } = require('../../discord/client');
      const alertClient = createBotClient(process.env.DIRECTOR_TOKEN);
      alertClient.once('clientReady', async () => {
        await postToChannel(
          alertClient,
          process.env.DISCORD_CHANNEL_ALERTS,
          `🚨 **Worker Escalation**\n**Agent:** ${this.agentName}\n**Issue:** #${this.issue.number} — ${this.issue.title}\n**Reason:** ${reason}`
        );
        alertClient.destroy();
      });
    } catch (err) {
      console.error(`[${this.agentName}] Failed to post alert: ${err.message}`);
    }

    try {
      await this.octokit.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: this.issue.number,
        labels: ['status:blocked'],
      });
    } catch (err) {
      await this.log(`⚠️ Could not update Issue label: ${err.message}`);
    }
  }

  async log(content) {
    console.log(`[${this.agentName}] ${content}`);
    if (this.projectChannels?.workersWebhook) {
      if (!this.webhook) this.webhook = createWebhookClient(this.projectChannels.workersWebhook);
      await postAsWorker(this.webhook, content, this.agentName);
    }
  }

  slugify(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }
}

module.exports = CoderAgent;
