#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

process.env.NODE_NO_WARNINGS = process.env.NODE_NO_WARNINGS || '1';
process.noDeprecation = true;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = new Set(['run', 'smoke', 'status', 'help']);
const DEFAULT_SMOKE_PROMPT = '请通过 filesystem MCP 读取当前项目根目录列表，判断 MAGI 是否能看到本体代码。若看到 App.tsx 或 package.json，最终回答第一行必须原样写出 MAGI_CAN_SEE_CODE_YES，并给出证据。';

const usage = () => `MAGI CLI verification flywheel

Usage:
  npm run magi:cli -- "prompt"
  npm run magi:cli -- --prompt "prompt" --expect-tool mcp.call
  npm run magi:status
  npm run magi:smoke
  npm run magi:smoke:full

Commands:
  run       Run one real MAGI council turn from the CLI.
  status    Start the local bridge and list runtime skills/MCP tools.
  smoke     Run deterministic bridge checks; add --full or use magi:smoke:full for a real MAGI prompt.

Useful flags:
  --prompt, -p <text>       Prompt text. Positional text also works.
  --prompt-file <path>      Read prompt from a file.
  --session <id>            Session id for audit/history context. Default: cli-<timestamp>.
  --save-session            Append the run to .magi/state/sessions.json.
  --format text|json|jsonl  Output format. Default: text.
  --stream                  Print final synthesis token deltas as they arrive in text mode.
  --out <path>              Write a JSON report artifact.
  --expect-tool <id>        Assert that a tool id appears in tool traces. Repeatable or comma-separated.
  --expect-phase <phase>    Assert that a stream phase appears. Repeatable or comma-separated.
  --expect-text <text>      Assert that final synthesis contains text. Repeatable.
  --expect-audit            Assert that auditRef exists.
  --expect-no-offline       Assert that no persona fell back to NODE OFFLINE.
  --expect-no-failed-events Assert that no stream events have status=failed.
  --expect-pending          Assert that at least one action is pending approval.
  --bridge-only             Smoke command: skip the real LLM prompt.
  --full                    Smoke command: include the real LLM prompt.
  --quiet                   Suppress live progress in text mode.
`;

const splitList = value => String(value)
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

const parseArgs = argv => {
  const args = {
    command: 'run',
    format: 'text',
    prompt: '',
    promptFile: '',
    session: '',
    runId: '',
    saveSession: false,
    stream: false,
    quiet: false,
    bridgeOnly: false,
    full: false,
    out: '',
    language: '',
    expectTools: [],
    expectPhases: [],
    expectTexts: [],
    expectAudit: false,
    expectNoOffline: false,
    expectNoFailedEvents: false,
    expectPending: false,
  };

  const positionals = [];
  const tokens = [...argv];
  if (tokens[0] && COMMANDS.has(tokens[0])) {
    args.command = tokens.shift();
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = () => {
      i += 1;
      if (i >= tokens.length) throw new Error(`Missing value for ${token}`);
      return tokens[i];
    };

    if (token === '--help' || token === '-h') args.command = 'help';
    else if (token === '--prompt' || token === '-p') args.prompt = next();
    else if (token === '--prompt-file') args.promptFile = next();
    else if (token === '--session') args.session = next();
    else if (token === '--run-id') args.runId = next();
    else if (token === '--save-session') args.saveSession = true;
    else if (token === '--format') args.format = next();
    else if (token === '--json') args.format = 'json';
    else if (token === '--jsonl') args.format = 'jsonl';
    else if (token === '--stream') args.stream = true;
    else if (token === '--quiet') args.quiet = true;
    else if (token === '--bridge-only') args.bridgeOnly = true;
    else if (token === '--full') args.full = true;
    else if (token === '--out') args.out = next();
    else if (token === '--lang' || token === '--language') args.language = next().toUpperCase();
    else if (token === '--expect-tool') args.expectTools.push(...splitList(next()));
    else if (token === '--expect-phase') args.expectPhases.push(...splitList(next()));
    else if (token === '--expect-text') args.expectTexts.push(next());
    else if (token === '--expect-audit') args.expectAudit = true;
    else if (token === '--expect-no-offline') args.expectNoOffline = true;
    else if (token === '--expect-no-failed-events') args.expectNoFailedEvents = true;
    else if (token === '--expect-pending') args.expectPending = true;
    else if (token.startsWith('--')) throw new Error(`Unknown flag: ${token}`);
    else positionals.push(token);
  }

  if (!args.prompt && positionals.length > 0) {
    args.prompt = positionals.join(' ');
  }

  if (!['text', 'json', 'jsonl'].includes(args.format)) {
    throw new Error(`Unsupported format: ${args.format}`);
  }

  return args;
};

const readTextIfExists = async filePath => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const readJsonIfExists = async (filePath, fallback = null) => {
  const raw = await readTextIfExists(filePath);
  if (raw === null) return fallback;
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
};

const writeJsonFile = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const parseEnvLine = line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const index = trimmed.indexOf('=');
  if (index === -1) return null;
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  value = value.replace(/^['"]|['"]$/g, '');
  return key ? [key, value] : null;
};

const loadEnvFiles = async root => {
  const merged = {};
  for (const name of ['.env', '.env.local']) {
    const raw = await readTextIfExists(path.join(root, name));
    if (!raw) continue;
    raw.split(/\r?\n/).forEach(line => {
      const parsed = parseEnvLine(line);
      if (parsed) merged[parsed[0]] = parsed[1];
    });
  }

  Object.entries(merged).forEach(([key, value]) => {
    if (process.env[key] === undefined) process.env[key] = value;
  });
};

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const makeId = prefix => `${prefix}-${nowStamp()}-${Math.random().toString(16).slice(2, 8)}`;
const detectLanguage = prompt => /[\u3400-\u9FFF]/.test(prompt) ? 'CN' : 'EN';

const startVite = async root => {
  const { createServer } = await import('vite');
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      strictPort: false,
    },
  });

  await server.listen();
  const baseUrl = (server.resolvedUrls?.local?.[0] || `http://127.0.0.1:${process.env.VITE_PORT || 3000}/`).replace(/\/$/, '');
  process.env.MAGI_BRIDGE_BASE_URL = baseUrl;
  process.env.VITE_DEV_SERVER_URL = baseUrl;
  return { server, baseUrl };
};

const loadRuntimeModules = async server => {
  const [aiService, harnessService, bridgeService] = await Promise.all([
    server.ssrLoadModule('/services/aiService.ts'),
    server.ssrLoadModule('/services/harnessService.ts'),
    server.ssrLoadModule('/services/bridgeService.ts'),
  ]);

  return { aiService, harnessService, bridgeService };
};

const loadHarness = async (root, harnessService) => {
  const stateDir = path.join(root, '.magi', 'state');
  const savedSettings = await readJsonIfExists(path.join(stateDir, 'settings.json'), null);
  const settings = {
    ...harnessService.createDefaultHarnessSettings(),
    ...(savedSettings || {}),
  };

  if (!settings.apiKey && process.env.OPENAI_API_KEY) settings.apiKey = process.env.OPENAI_API_KEY;
  if (!settings.baseURL && process.env.OPENAI_BASE_URL) settings.baseURL = process.env.OPENAI_BASE_URL;
  if (!settings.modelName && process.env.OPENAI_MODEL_NAME) settings.modelName = process.env.OPENAI_MODEL_NAME;
  if (!settings.tavilyApiKey && process.env.VITE_TAVILY_API_KEY) settings.tavilyApiKey = process.env.VITE_TAVILY_API_KEY;

  const savedDocuments = await readJsonIfExists(path.join(stateDir, 'documents.json'), null);
  let documents;
  if (savedDocuments) {
    documents = harnessService.normalizeHarnessDocuments(savedDocuments);
  } else {
    documents = harnessService.createInitialHarnessDocuments();
    await Promise.all(harnessService.HARNESS_DOCUMENT_DEFINITIONS.map(async definition => {
      const filePath = path.join(root, 'public', definition.path.replace(/^\//, ''));
      const content = await readTextIfExists(filePath);
      if (content !== null) {
        documents[definition.id] = {
          id: definition.id,
          label: definition.label,
          path: definition.path,
          content,
        };
      }
    }));
  }

  const memories = await readJsonIfExists(path.join(stateDir, 'memories.json'), []);
  const sessions = await readJsonIfExists(path.join(stateDir, 'sessions.json'), []);

  return {
    settings,
    documents,
    memories: Array.isArray(memories) ? memories : [],
    sessions: Array.isArray(sessions) ? sessions : [],
  };
};

const getSessionHistory = (sessions, sessionId) => {
  const session = sessions.find(item => item?.id === sessionId);
  return Array.isArray(session?.messages) ? session.messages : [];
};

const saveSessionRun = async (root, sessions, sessionId, language, prompt, response) => {
  const now = Date.now();
  const userMessage = {
    id: makeId('msg-user'),
    role: 'user',
    content: prompt,
    timestamp: now - 1,
  };
  const modelMessage = {
    id: makeId('msg-model'),
    role: 'model',
    content: '',
    magiData: response,
    timestamp: now,
  };

  const existing = sessions.find(item => item?.id === sessionId);
  const nextSession = existing
    ? {
      ...existing,
      messages: [...(existing.messages || []), userMessage, modelMessage],
      lastUpdated: now,
      language,
    }
    : {
      id: sessionId,
      title: prompt.slice(0, 48) || 'CLI Verification',
      messages: [userMessage, modelMessage],
      language,
      lastUpdated: now,
    };

  const nextSessions = [
    nextSession,
    ...sessions.filter(item => item?.id !== sessionId),
  ];

  await writeJsonFile(path.join(root, '.magi', 'state', 'sessions.json'), nextSessions);
};

const countBy = values => values.reduce((acc, value) => {
  acc[value] = (acc[value] || 0) + 1;
  return acc;
}, {});

const summarizeResponse = (response, streamEvents, textDeltaCount, latencyMs) => {
  const toolTraces = response.toolTraces || [];
  const offlinePersonas = ['melchior', 'balthasar', 'casper']
    .filter(key => /OFFLINE|TIMEOUT OR HARNESS FAILURE|NODE OFFLINE/i.test(response[key]?.analysis || ''))
    .map(key => response[key]?.systemName || key);
  const failedEvents = streamEvents
    .filter(event => event.status === 'failed')
    .map(event => `${event.phase}:${event.actor}:${event.message}`);
  return {
    latencyMs,
    finalDecision: response.finalDecision,
    requiresUserInput: Boolean(response.requiresUserInput),
    synthesisChars: response.synthesis?.length || 0,
    textDeltaCount,
    eventCount: streamEvents.length,
    phases: countBy(streamEvents.map(event => event.phase)),
    tools: toolTraces.map(trace => ({
      actor: trace.systemName,
      toolId: trace.toolId,
      status: trace.status,
      summary: trace.summary,
    })),
    toolStatus: countBy(toolTraces.map(trace => trace.status)),
    pendingActions: response.pendingActions?.length || 0,
    clarifications: response.clarificationRequests?.length || 0,
    offlinePersonas,
    failedEvents,
    auditRef: response.auditRef,
  };
};

const emitJsonLine = item => {
  process.stdout.write(`${JSON.stringify(item)}\n`);
};

const formatEvent = event => {
  const time = new Date(event.timestamp).toLocaleTimeString();
  return `[${time}] ${event.phase} ${event.actor} ${event.status} - ${event.message}`;
};

const printTextReport = (report, streamed) => {
  if (streamed) process.stdout.write('\n\n');
  process.stdout.write('MAGI CLI result\n');
  process.stdout.write(`Session: ${report.sessionId}\n`);
  process.stdout.write(`Run: ${report.runId}\n`);
  process.stdout.write(`Latency: ${report.summary.latencyMs}ms\n`);
  process.stdout.write(`Decision: ${report.summary.requiresUserInput ? 'WAIT' : report.summary.finalDecision ? 'YES' : 'NO'}\n`);
  process.stdout.write(`Tools: ${report.summary.tools.length} trace(s); pending=${report.summary.pendingActions}; clarifications=${report.summary.clarifications}\n`);
  if (report.summary.offlinePersonas.length > 0) {
    process.stdout.write(`Offline personas: ${report.summary.offlinePersonas.join(', ')}\n`);
  }
  if (report.summary.failedEvents.length > 0) {
    process.stdout.write(`Failed events: ${report.summary.failedEvents.join('; ')}\n`);
  }
  if (report.summary.auditRef?.filePath) {
    process.stdout.write(`Audit: ${report.summary.auditRef.filePath}\n`);
  }
  process.stdout.write('\nFinal synthesis:\n');
  process.stdout.write(`${report.response.synthesis || '(empty)'}\n`);
};

const assertReport = (report, args) => {
  const failures = [];
  const phases = new Set(report.events.map(event => event.phase));
  const toolIds = new Set((report.response.toolTraces || []).map(trace => trace.toolId));

  if (!report.response.synthesis?.trim()) failures.push('Final synthesis is empty.');
  args.expectTools.forEach(toolId => {
    if (!toolIds.has(toolId)) failures.push(`Expected tool trace not found: ${toolId}`);
  });
  args.expectPhases.forEach(phase => {
    if (!phases.has(phase)) failures.push(`Expected stream phase not found: ${phase}`);
  });
  args.expectTexts.forEach(text => {
    if (!report.response.synthesis?.includes(text)) failures.push(`Expected final synthesis to contain: ${text}`);
  });
  if (args.expectAudit && !report.response.auditRef) {
    failures.push('Expected auditRef, but none was returned.');
  }
  if (args.expectNoOffline && report.summary.offlinePersonas.length > 0) {
    failures.push(`Expected no offline personas, but got: ${report.summary.offlinePersonas.join(', ')}`);
  }
  if (args.expectNoFailedEvents && report.summary.failedEvents.length > 0) {
    failures.push(`Expected no failed events, but got: ${report.summary.failedEvents.join('; ')}`);
  }
  if (args.expectPending && report.summary.pendingActions < 1) {
    failures.push('Expected at least one pending approval action, but none was returned.');
  }

  if (failures.length > 0) {
    const error = new Error(`CLI assertions failed:\n- ${failures.join('\n- ')}`);
    error.failures = failures;
    throw error;
  }
};

const writeReportArtifact = async (root, args, report) => {
  const target = args.out
    ? path.resolve(root, args.out)
    : args.command === 'smoke'
      ? path.join(root, '.magi', 'artifacts', 'cli', `${report.runId}.json`)
      : '';

  if (!target) return '';
  await writeJsonFile(target, report);
  return target;
};

const runPrompt = async (ctx, prompt, args) => {
  const sessionId = args.session || makeId('cli');
  const runId = args.runId || makeId('run');
  const language = args.language === 'EN' || args.language === 'CN'
    ? args.language
    : detectLanguage(prompt);
  const history = getSessionHistory(ctx.harness.sessions, sessionId);
  const events = [];
  let textDeltaCount = 0;
  const startedAt = Date.now();

  const response = await ctx.modules.aiService.queryMagiSystem(
    prompt,
    history,
    language,
    ctx.harness.memories,
    {
      settings: ctx.harness.settings,
      documents: ctx.harness.documents,
    },
    {
      sessionId,
      runId,
      onEvent: event => {
        events.push(event);
        if (args.format === 'jsonl') emitJsonLine({ type: 'event', event });
        if (args.format === 'text' && !args.quiet) process.stderr.write(`${formatEvent(event)}\n`);
      },
      onTextDelta: event => {
        textDeltaCount += 1;
        if (args.format === 'jsonl') emitJsonLine({ type: 'text_delta', event });
        if (args.format === 'text' && args.stream) process.stdout.write(event.delta);
      },
    },
  );

  const latencyMs = Date.now() - startedAt;
  const report = {
    type: 'magi-run',
    prompt,
    sessionId,
    runId,
    language,
    startedAt,
    latencyMs,
    summary: summarizeResponse(response, events, textDeltaCount, latencyMs),
    events,
    response,
  };

  assertReport(report, args);
  const artifact = await writeReportArtifact(ROOT, args, report);
  if (artifact) report.artifact = artifact;

  if (args.saveSession) {
    await saveSessionRun(ROOT, ctx.harness.sessions, sessionId, language, prompt, response);
  }

  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (args.format === 'jsonl') {
    emitJsonLine({ type: 'result', report });
  } else {
    printTextReport(report, args.stream);
    if (artifact) process.stdout.write(`\nArtifact: ${artifact}\n`);
  }

  return report;
};

const extractTools = payload => {
  if (Array.isArray(payload?.tools)) return payload.tools;
  if (Array.isArray(payload?.result?.tools)) return payload.result.tools;
  return [];
};

const runStatus = async ctx => {
  const status = await ctx.modules.bridgeService.getBridgeStatus();
  const mcpTools = {};
  for (const server of status.mcpServers || []) {
    try {
      mcpTools[server] = extractTools(await ctx.modules.bridgeService.listMcpTools(server));
    } catch (error) {
      mcpTools[server] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { status, mcpTools };
};

const runBridgeSmoke = async ctx => {
  const { status, mcpTools } = await runStatus(ctx);
  const checks = [
    { name: 'bridge online', ok: Boolean(status.ok) },
    { name: 'skills discovered', ok: Array.isArray(status.skills) && status.skills.length > 0, detail: `${status.skills?.length || 0}` },
    { name: 'filesystem MCP listed', ok: status.mcpServers?.includes('filesystem') },
    { name: 'browser MCP listed', ok: status.mcpServers?.includes('browser') },
  ];

  const browserTools = Array.isArray(mcpTools.browser) ? mcpTools.browser : [];
  const filesystemTools = Array.isArray(mcpTools.filesystem) ? mcpTools.filesystem : [];
  checks.push({ name: 'browser MCP exposes tools', ok: browserTools.length >= 6, detail: `${browserTools.length}` });
  checks.push({ name: 'filesystem MCP exposes directory_tree', ok: filesystemTools.some(tool => tool.name === 'directory_tree') });

  if (filesystemTools.some(tool => tool.name === 'list_allowed_directories')) {
    try {
      const result = await ctx.modules.bridgeService.executeBridgeTool(
        'mcp.call',
        { server: 'filesystem', tool: 'list_allowed_directories', arguments: {} },
        'CLI-SMOKE',
      );
      checks.push({ name: 'filesystem MCP read call executes', ok: Boolean(result.ok), detail: JSON.stringify(result.result).slice(0, 300) });
    } catch (error) {
      checks.push({ name: 'filesystem MCP read call executes', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  return { status, mcpTools, checks };
};

const printStatus = payload => {
  process.stdout.write('MAGI bridge status\n');
  process.stdout.write(`Base: ${process.env.MAGI_BRIDGE_BASE_URL}\n`);
  process.stdout.write(`CWD: ${payload.status.cwd}\n`);
  process.stdout.write(`Skills: ${payload.status.skills?.length || 0}\n`);
  process.stdout.write(`MCP servers: ${(payload.status.mcpServers || []).join(', ') || 'none'}\n`);
  Object.entries(payload.mcpTools).forEach(([server, tools]) => {
    if (!Array.isArray(tools)) {
      process.stdout.write(`- ${server}: ERROR ${tools.error}\n`);
      return;
    }
    process.stdout.write(`- ${server}: ${tools.length} tool(s) ${tools.map(tool => tool.name).join(', ')}\n`);
  });
  if (payload.status.auditDir) process.stdout.write(`Audit dir: ${payload.status.auditDir}\n`);
  if (payload.status.artifactDir) process.stdout.write(`Artifact dir: ${payload.status.artifactDir}\n`);
};

const printSmoke = payload => {
  process.stdout.write('MAGI CLI smoke\n');
  payload.checks.forEach(check => {
    process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` (${check.detail})` : ''}\n`);
  });
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    process.stdout.write(usage());
    return;
  }

  await loadEnvFiles(ROOT);
  const { server, baseUrl } = await startVite(ROOT);

  try {
    const modules = await loadRuntimeModules(server);
    const harness = await loadHarness(ROOT, modules.harnessService);
    const ctx = { modules, harness, baseUrl };

    if (args.command === 'status') {
      const payload = await runStatus(ctx);
      if (args.format === 'json') process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else printStatus(payload);
      return;
    }

    if (args.command === 'smoke') {
      const bridgePayload = await runBridgeSmoke(ctx);
      const failed = bridgePayload.checks.filter(check => !check.ok);
      if (args.format === 'json' && (args.bridgeOnly || !args.full)) {
        process.stdout.write(`${JSON.stringify({ type: 'bridge-smoke', ...bridgePayload }, null, 2)}\n`);
      } else if (args.format === 'jsonl') {
        emitJsonLine({ type: 'bridge_smoke', ...bridgePayload });
      } else {
        printSmoke(bridgePayload);
      }

      if (failed.length > 0) {
        throw new Error(`Bridge smoke failed: ${failed.map(check => check.name).join(', ')}`);
      }

      if (args.bridgeOnly || !args.full) return;

      args.expectTools.push(...(args.expectTools.length ? [] : ['mcp.call']));
      args.expectPhases.push(...(args.expectPhases.length ? [] : ['council-tools', 'synthesis-tools', 'synthesis-stream']));
      args.expectTexts.push(...(args.expectTexts.length ? [] : ['MAGI_CAN_SEE_CODE_YES']));
      args.expectAudit = true;
      args.expectNoOffline = true;
      args.expectNoFailedEvents = true;
      await runPrompt(ctx, args.prompt || DEFAULT_SMOKE_PROMPT, args);
      return;
    }

    if (args.promptFile) {
      args.prompt = await fs.readFile(path.resolve(ROOT, args.promptFile), 'utf8');
    }
    if (!args.prompt.trim()) throw new Error('Prompt is required. Use --prompt or positional text.');
    await runPrompt(ctx, args.prompt.trim(), args);
  } finally {
    await server.close();
  }
};

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
