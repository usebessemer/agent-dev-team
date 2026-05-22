const { createBotClient, postToChannel, waitForApproval } = require('../../discord/client');
const Anthropic = require('@anthropic-ai/sdk');

const DIRECTOR_SYSTEM_PROMPT = `You are the Director of an AI software development team. You help executives define project specifications and coordinate work across PM, Tech Lead, and Coder agents. You are precise, technical, and always follow the exact output format requested.`;

/**
 * Director Agent — the only persistent agent in the system.
 * Collaborates with the executive to build project specs.
 * Spins up PM and Tech Lead on spec confirmation.
 */

class Director {
  constructor() {
    this.client = createBotClient(process.env.DIRECTOR_TOKEN);
    this.ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    this.useClaudeApi = !!process.env.ANTHROPIC_API_KEY;
    this.model = process.env.DIRECTOR_MODEL || (this.useClaudeApi ? 'claude-opus-4-7' : 'llama3.1:8b');
    this.anthropic = this.useClaudeApi
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null;

    if (this.useClaudeApi) {
      console.log(`[Director] Using Claude API (${this.model})`);
    }

    this.ready = false;
    this.startTime = Date.now();
    this.activeBriefs = {};

    this.client.once('clientReady', () => {
      console.log(`[Director] Online as ${this.client.user.tag}`);
      this.ready = true;
      this.listen();
    });
  }

  listen() {
    this.client.on('messageCreate', async (message) => {
      if (message.author.bot) return;
      if (message.channelId !== process.env.DISCORD_CHANNEL_DIRECTOR) return;
      if (message.createdTimestamp < this.startTime) return;

      console.log(`[Director] Received message: ${message.content}`);
      await this.handleMessage(message);
    });
  }

  _sanitizeName(name) {
    return name.toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || null;
  }

  async handleMessage(message) {
    const content = message.content.trim();
    const channelId = message.channelId;

    if (content.toLowerCase().startsWith('brief:')) {
      const raw = content.slice(6).trim();
      const nameMatch = raw.match(/^\[([^\]]+)\]\s*(.*)/s);
      const projectName = nameMatch ? this._sanitizeName(nameMatch[1]) : null;
      const brief = nameMatch ? nameMatch[2].trim() : raw;
      await this.startBriefConversation(brief, message, projectName);
      return;
    }

    if (content.toLowerCase().startsWith('close:')) {
      const projectName = content.slice(6).trim();
      await this.closeProject(projectName);
      return;
    }

    if (this.activeBriefs[channelId]) {
      if (content.toLowerCase() === 'confirm') {
        await this.confirmSpec(channelId);
      } else if (content.toLowerCase() === 'cancel') {
        delete this.activeBriefs[channelId];
        await postToChannel(this.client, channelId, '🗑️ Draft spec cleared. Send a new brief when ready.');
      } else {
        await this.refineSpec(channelId, content);
      }
      return;
    }

    const text = await this.think(content);
    const truncated = text.length > 1900 ? text.slice(0, 1900) + '...' : text;
    await postToChannel(this.client, channelId, truncated);
  }

  async startBriefConversation(brief, message, projectName = null) {
    const channelId = message.channelId;
    await postToChannel(this.client, channelId, '📋 Brief received. Building draft spec...');

    const spec = await this.buildSpec(brief, projectName);
    this.activeBriefs[channelId] = { spec, brief };

    await postToChannel(this.client, channelId, this._formatDraftSpec(spec));
  }

  async refineSpec(channelId, instruction) {
    const { spec } = this.activeBriefs[channelId];
    await postToChannel(this.client, channelId, '🔄 Updating spec...');

    const updatedSpec = await this._refineSpecWithModel(spec, instruction, channelId);
    this.activeBriefs[channelId].spec = updatedSpec;

    if (updatedSpec !== spec) {
      await postToChannel(this.client, channelId, this._formatDraftSpec(updatedSpec));
    }
  }

  async confirmSpec(channelId) {
    const activeBrief = this.activeBriefs[channelId];
    if (!activeBrief) return;

    const { spec } = activeBrief;
    delete this.activeBriefs[channelId];

    const approvalsChannel = process.env.DISCORD_CHANNEL_APPROVALS;
    const summaryMessage =
      `**New Project Spec — Awaiting Approval**\n\n` +
      `**Project:** ${spec.spec.projectName}\n` +
      `**Goal:** ${spec.spec.brief.desiredOutcome}\n\n` +
      `**Deliverables:**\n${spec.spec.deliverables.map(d => `- ${d.name}: ${d.description}`).join('\n')}\n\n` +
      `**Tech Stack:** ${spec.spec.architecture.techStack.language} / ${spec.spec.architecture.techStack.packages.join(', ')}\n\n` +
      `Type \`approve: ${spec.spec.projectName}\` to confirm or \`reject: ${spec.spec.projectName}\` to request changes. (Plain \`approve\`/\`reject\` also works.)`;

    const approvalMessage = await this.client.channels
      .fetch(approvalsChannel)
      .then(channel => channel.send(summaryMessage));

    await postToChannel(this.client, channelId, 'Spec sent to #approvals. Waiting for your confirmation.');

    try {
      const approved = await waitForApproval(this.client, approvalMessage.id, approvalsChannel, spec.spec.projectName);

      if (approved) {
        await postToChannel(this.client, channelId, '✅ Spec approved. Spinning up PM and Tech Lead...');
        await this.spawnManagers(spec);
      } else {
        await postToChannel(this.client, channelId, '❌ Spec rejected. Send me a revised brief when ready.');
      }
    } catch (err) {
      await postToChannel(this.client, process.env.DISCORD_CHANNEL_ALERTS, `⚠️ Approval timed out for project: ${spec.spec.projectName}`);
    }
  }

  _formatDraftSpec(spec) {
    const s = spec.spec;
    const deliverables = s.deliverables.map(d => `  - ${d.name}`).join('\n');
    const packages = s.architecture.techStack.packages.join(', ');
    const formatted =
      `**Draft Spec — ${s.projectName}**\n\n` +
      `**Goal:** ${s.brief.desiredOutcome}\n\n` +
      `**Stack:** ${s.architecture.techStack.language} / ${s.architecture.techStack.runtime} / ${packages}\n\n` +
      `**Deliverables:**\n${deliverables}\n\n` +
      `Reply with changes, or type \`confirm\` to send to #approvals. Type \`cancel\` to start over.`;
    return formatted.length > 1900 ? formatted.slice(0, 1900) + '...' : formatted;
  }

  async _refineSpecWithModel(currentSpec, instruction, channelId = null) {
    const MAX_ATTEMPTS = 3;
    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return this.useClaudeApi
          ? await this._refineSpecWithClaude(currentSpec, instruction, lastError)
          : await this._refineSpecWithOllama(currentSpec, instruction, lastError);
      } catch (err) {
        lastError = err.message;
        console.error(`[Director] Refinement attempt ${attempt + 1} failed: ${err.message}`);
      }
    }
    if (channelId) {
      await postToChannel(this.client, channelId,
        `⚠️ Couldn't apply that refinement after ${MAX_ATTEMPTS} tries. The previous spec stands. Try rephrasing?`);
    }
    return currentSpec;
  }

  async _refineSpecWithClaude(currentSpec, instruction, lastError = null) {
    const errorHint = lastError
      ? `\n\nYour previous attempt failed with: "${lastError}". Fix the JSON and try again.`
      : '';
    const prompt =
      `Here is the current project spec:\n\n${JSON.stringify(currentSpec, null, 2)}\n\n` +
      `The user wants to change: "${instruction}"\n\n` +
      `Return ONLY the updated spec as valid JSON (no markdown, no backticks). Preserve all fields that do not need to change.` +
      errorHint;

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: [{ type: 'text', text: DIRECTOR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('No JSON object found in model response');
  }

  async _refineSpecWithOllama(currentSpec, instruction, lastError = null) {
    const errorHint = lastError
      ? ` Your previous attempt failed with: "${lastError}". Fix the JSON.`
      : '';
    const response = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: `You are the Director. Here is the current project spec:\n${JSON.stringify(currentSpec)}\n\nThe user wants: "${instruction}"\n\nReturn ONLY the updated spec as valid JSON, preserving unchanged fields.${errorHint}`,
        stream: false
      })
    });
    const data = await response.json();
    const text = data.response.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('No JSON object found in model response');
  }

  async buildSpec(brief, projectName = null) {
    return this.useClaudeApi
      ? this._buildSpecWithClaude(brief, projectName)
      : this._buildSpecWithOllama(brief, projectName);
  }

  async _buildSpecWithClaude(brief, projectName = null) {
    const MAX_ATTEMPTS = 3;
    let lastErrors = [];
    const basePrompt = this._buildSpecPrompt(brief, projectName);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const prompt = attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nPrevious attempt had these validation errors: ${lastErrors.join('; ')}. Fix them and return valid JSON.`;

      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: [
          {
            type: 'text',
            text: DIRECTOR_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [{ role: 'user', content: prompt }]
      });

      const text = response.content[0].text.trim();
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const errors = this._validateSpec(parsed);
          if (!errors.length) {
            if (projectName) parsed.projectName = projectName;
            console.log(`[Director] Spec generated for: ${parsed.projectName} (${parsed.projectType})`);
            return this._wrapSpec(parsed, brief);
          }
          lastErrors = errors;
          console.warn(`[Director] Spec validation failed (attempt ${attempt + 1}):`, errors.join(', '));
        }
      } catch (err) {
        lastErrors = [`JSON parse error: ${err.message}`];
        console.error('[Director] Failed to parse spec JSON:', err.message);
      }
    }

    console.error('[Director] Spec generation failed after max attempts, using fallback.');
    return this._fallbackSpec(projectName || 'new-project', brief);
  }

  async _buildSpecWithOllama(brief, projectName = null) {
    const MAX_ATTEMPTS = 3;
    let lastErrors = [];
    const basePrompt = this._buildSpecPrompt(brief, projectName);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const prompt = attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nPrevious attempt had these validation errors: ${lastErrors.join('; ')}. Fix them and return valid JSON.`;

      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt, stream: false })
      });
      const data = await response.json();
      const text = data.response.trim();

      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const errors = this._validateSpec(parsed);
          if (!errors.length) {
            if (projectName) parsed.projectName = projectName;
            console.log(`[Director] Spec generated for: ${parsed.projectName} (${parsed.projectType})`);
            return this._wrapSpec(parsed, brief);
          }
          lastErrors = errors;
          console.warn(`[Director] Spec validation failed (attempt ${attempt + 1}):`, errors.join(', '));
        }
      } catch (err) {
        lastErrors = [`JSON parse error: ${err.message}`];
        console.error('[Director] Failed to parse spec JSON:', err.message);
      }
    }

    console.error('[Director] Spec generation failed after max attempts, using fallback.');
    return this._fallbackSpec(projectName || 'new-project', brief);
  }

  _buildSpecPrompt(brief, projectName = null) {
    const nameInstruction = projectName ? `Use "${projectName}" as the projectName.` : '';
    return (
      `Generate a complete project spec as JSON for this brief: "${brief}"\n\n` +
      `Required JSON fields:\n` +
      `- projectName: kebab-case string, max 30 chars${nameInstruction ? ` (${nameInstruction})` : ''}\n` +
      `- projectType: one of "cli", "web-app", "api-service", "data-pipeline", "docs-site"\n` +
      `- brief: { problemStatement, desiredOutcome, constraints: { technical: [strings] }, antiGoals: [strings] }\n` +
      `- architecture: { overview, components: [{ name, description }], techStack: { language, runtime, packages: [strings] } }\n` +
      `- deliverables: [{ name, type: "code" or "docs", description, acceptanceCriteria: [strings, at least 1] }]\n\n` +
      `IMPORTANT deliverables rules:\n` +
      `- Do NOT create a standalone testing, "Test Suite", or QA deliverable. Tests are not a separate deliverable.\n` +
      `- Every deliverable of type "code" must include its own automated tests, expressed as acceptanceCriteria entries (e.g. "unit tests cover X", "test suite passes").\n\n` +
      `Supported stacks: JavaScript/node (express, jest, etc.), Python/python3 (flask, pytest, pandas, etc.), Go/go (standard library).\n` +
      `Match the tech stack to the brief — a Python brief gets Python, a Go brief gets Go.\n\n` +
      `Respond with ONLY valid JSON (no markdown, no backticks, no explanation).`
    );
  }

  _validateSpec(spec) {
    const errors = [];
    const validTypes = ['cli', 'web-app', 'api-service', 'data-pipeline', 'docs-site'];

    if (!spec.projectName || typeof spec.projectName !== 'string') {
      errors.push('projectName is required and must be a string');
    }
    if (!validTypes.includes(spec.projectType)) {
      errors.push(`projectType must be one of: ${validTypes.join(', ')}`);
    }
    if (!spec.brief?.desiredOutcome) {
      errors.push('brief.desiredOutcome is required');
    }
    if (!spec.architecture?.techStack?.language) {
      errors.push('architecture.techStack.language is required');
    }
    if (!Array.isArray(spec.architecture?.techStack?.packages)) {
      errors.push('architecture.techStack.packages must be an array');
    }
    if (!Array.isArray(spec.deliverables) || spec.deliverables.length === 0) {
      errors.push('deliverables must be a non-empty array');
    }
    for (const d of (spec.deliverables || [])) {
      if (!d.name) errors.push('each deliverable must have a name');
      if (!Array.isArray(d.acceptanceCriteria) || d.acceptanceCriteria.length === 0) {
        errors.push(`deliverable "${d.name || '(unnamed)'}" must have at least one acceptanceCriteria`);
      }
      if (/test|qa/i.test(d.name || '')) {
        errors.push(`deliverable "${d.name}" looks like a standalone test/QA deliverable — fold tests into the code deliverable's acceptanceCriteria instead`);
      }
    }

    return errors;
  }

  _wrapSpec(innerSpec, brief) {
    const sanitized = (innerSpec.projectName || '').toLowerCase()
      .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
      || 'new-project';

    return {
      spec: {
        projectName: sanitized,
        projectType: innerSpec.projectType,
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        brief: {
          problemStatement: innerSpec.brief?.problemStatement || brief,
          desiredOutcome: innerSpec.brief?.desiredOutcome || brief,
          constraints: innerSpec.brief?.constraints || { technical: [] },
          antiGoals: innerSpec.brief?.antiGoals || []
        },
        architecture: innerSpec.architecture,
        team: {
          workers: ['coder'],
          managers: ['pm', 'techlead'],
          efficiency: false
        },
        deliverables: innerSpec.deliverables,
        openQuestions: []
      }
    };
  }

  _fallbackSpec(projectName, brief) {
    console.warn(`[Director] Using fallback Express spec for: ${projectName}`);
    return {
      spec: {
        projectName,
        projectType: 'web-app',
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        brief: {
          problemStatement: brief,
          desiredOutcome: brief,
          constraints: { technical: ['Node.js only', 'no external databases'] },
          antiGoals: []
        },
        architecture: {
          overview: 'Single page web application with Express backend',
          components: [
            { name: 'frontend', description: 'HTML/CSS/JS user interface' },
            { name: 'backend', description: 'Express.js server' }
          ],
          techStack: { language: 'javascript', runtime: 'node', packages: ['express'] }
        },
        team: { workers: ['coder'], managers: ['pm', 'techlead'], efficiency: false },
        deliverables: [
          {
            name: `${projectName}-app`,
            type: 'code',
            description: `Web application for ${projectName}`,
            acceptanceCriteria: ['Application loads without errors', 'Core functionality works']
          }
        ],
        openQuestions: []
      }
    };
  }

  async think(prompt) {
    return this.useClaudeApi
      ? this._thinkWithClaude(prompt)
      : this._thinkWithOllama(prompt);
  }

  async _thinkWithClaude(prompt) {
    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: DIRECTOR_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: prompt }]
    });

    return response.content[0].text.trim();
  }

  async _thinkWithOllama(prompt) {
    const response = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: `You are the Director of an AI software development team. ${prompt}`,
        stream: false
      })
    });

    const data = await response.json();
    return data.response.trim();
  }

  async closeProject(projectName) {
    const directorChannel = process.env.DISCORD_CHANNEL_DIRECTOR;
    console.log(`[Director] Closing project: ${projectName}`);

    await postToChannel(
      this.client,
      directorChannel,
      `🔒 Closing project **${projectName}**...`
    );

    if (this.onProjectClose) {
      await this.onProjectClose(projectName);
    }

    await postToChannel(
      this.client,
      directorChannel,
      `✅ Project **${projectName}** closed. Estimation history updated.`
    );
  }

  async spawnManagers(spec) {
    console.log(`[Director] Spawning managers for project: ${spec.spec.projectName}`);
    await postToChannel(
      this.client,
      process.env.DISCORD_CHANNEL_DIRECTOR,
      `🚀 PM and Tech Lead are being spun up for **${spec.spec.projectName}**. Stand by.`
    );
  }
}

module.exports = Director;
