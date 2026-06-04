const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const APP_DIR = __dirname;
const PORT = Number(process.env.LEARNING_ASSISTANT_PORT || 43117);
const LOCAL_ENV = path.join(APP_DIR, ".env.local");
const MAX_BODY = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 80 * 1024;
const MAX_FILES = 8;
const CODEX_TIMEOUT_MS = Number(process.env.LEARNING_ASSISTANT_CODEX_TIMEOUT_MS || 180000);
const CODEX_REASONING_EFFORT = process.env.LEARNING_ASSISTANT_CODEX_REASONING_EFFORT || "low";
const MAX_HISTORY_MESSAGES = Number(process.env.LEARNING_ASSISTANT_HISTORY_MESSAGES || 40);
const CODEX_HOME = process.env.CODEX_HOME || "D:\\1AI-Workbench\\project\\workbench\\workspace\\runtime\\.codex-home-official";
const CODEX_SESSION_STORE = path.join(APP_DIR, ".codex-sessions.local.json");
const PROGRESS_DIR = path.join(ROOT, "learning-progress");
const PROGRESS_FILE = path.join(PROGRESS_DIR, "progress.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function readLocalEnv() {
  if (!fs.existsSync(LOCAL_ENV)) {
    return {};
  }
  const env = {};
  const lines = fs.readFileSync(LOCAL_ENV, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const splitAt = trimmed.indexOf("=");
    if (splitAt === -1) {
      continue;
    }
    const key = trimmed.slice(0, splitAt).trim();
    let value = trimmed.slice(splitAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function getConfig() {
  const local = readLocalEnv();
  return {
    apiKey: process.env.OPENAI_API_KEY || local.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || local.OPENAI_MODEL || "gpt-5-mini"
  };
}

function saveConfig({ apiKey, model }) {
  const existing = getConfig();
  const next = {
    apiKey: apiKey || existing.apiKey,
    model: model || existing.model || "gpt-5-mini"
  };
  const content = [
    "# Local only. Do not commit this file.",
    `OPENAI_API_KEY=${next.apiKey}`,
    `OPENAI_MODEL=${next.model}`,
    ""
  ].join("\n");
  fs.writeFileSync(LOCAL_ENV, content, "utf8");
  return next;
}

function findOnPath(commandName) {
  const paths = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? [".ps1", ".cmd", ".bat", ".exe", ""] : [""];
  for (const dir of paths) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${commandName}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "";
}

function getCodexCommand() {
  const configured = process.env.LEARNING_ASSISTANT_CODEX_COMMAND;
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const bundled = "D:\\Node\\node_global\\node_modules\\@openai\\codex\\bin\\codex.js";
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  return findOnPath("codex") || findOnPath("codex-openai");
}

function codexProviderStatus() {
  const command = getCodexCommand();
  return {
    available: Boolean(command),
    command
  };
}

function readCodexSessionStore() {
  try {
    if (!fs.existsSync(CODEX_SESSION_STORE)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(CODEX_SESSION_STORE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCodexSessionStore(store) {
  fs.writeFileSync(CODEX_SESSION_STORE, JSON.stringify(store, null, 2), "utf8");
}

function normalizeSessionKey(key) {
  return String(key || "").trim().slice(0, 120);
}

function getCodexSessionId(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return "";
  }
  return readCodexSessionStore()[key]?.sessionId || "";
}

function saveCodexSessionId(sessionKey, sessionId) {
  const key = normalizeSessionKey(sessionKey);
  if (!key || !sessionId) {
    return;
  }
  const store = readCodexSessionStore();
  store[key] = {
    sessionId,
    updatedAt: new Date().toISOString()
  };
  writeCodexSessionStore(store);
}

function deleteCodexSessionId(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return;
  }
  const store = readCodexSessionStore();
  delete store[key];
  writeCodexSessionStore(store);
}

function killProcessTree(child) {
  if (!child.pid || child.killed) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    });
    return;
  }
  child.kill();
}

function runLocalCommand(command, args, options = {}) {
  const timeout = options.timeout || 120000;
  const allowNonZero = Boolean(options.allowNonZero);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never"
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killProcessTree(child);
      const error = new Error(`${command} ${args.join(" ")} timed out`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code !== 0 && !allowNonZero) {
        const error = new Error(result.stderr || result.stdout || `${command} exited with code ${code}`);
        Object.assign(error, result);
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function readProgressSnapshot() {
  try {
    if (!fs.existsSync(PROGRESS_FILE)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeProgressSnapshot(snapshot) {
  fs.mkdirSync(PROGRESS_DIR, { recursive: true });
  const content = JSON.stringify({
    ...snapshot,
    savedAt: new Date().toISOString()
  }, null, 2);
  fs.writeFileSync(PROGRESS_FILE, `${content}\n`, "utf8");
}

async function gitSyncProgress(reason) {
  const branchResult = await runLocalCommand("git", ["branch", "--show-current"], { timeout: 30000 });
  const branch = branchResult.stdout || "main";
  await runLocalCommand("git", ["add", "-A"], { timeout: 60000 });
  const diff = await runLocalCommand("git", ["diff", "--cached", "--quiet"], {
    timeout: 30000,
    allowNonZero: true
  });
  if (diff.code === 0) {
    return {
      committed: false,
      pushed: false,
      branch,
      message: "No changes to sync"
    };
  }
  if (diff.code !== 1) {
    throw new Error(diff.stderr || diff.stdout || "git diff failed");
  }
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const message = reason ? `Sync learning progress: ${reason}` : `Sync learning progress ${stamp}`;
  const commit = await runLocalCommand("git", ["commit", "-m", message], { timeout: 120000 });
  const push = await runLocalCommand("git", ["push", "origin", branch], {
    timeout: 120000,
    allowNonZero: true
  });
  return {
    committed: true,
    commit: commit.stdout || commit.stderr,
    pushed: push.code === 0,
    branch,
    pushOutput: push.stdout || push.stderr,
    pushError: push.code === 0 ? "" : (push.stderr || push.stdout || `git push exited with code ${push.code}`)
  };
}

function listSessionFiles(dir = path.join(CODEX_HOME, "sessions")) {
  const files = [];
  if (!fs.existsSync(dir)) {
    return files;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const item = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSessionFiles(item));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(item);
    }
  }
  return files;
}

function sessionIdFromFile(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : "";
}

function findCodexSessionIdByMarker(marker, startedAtMs) {
  if (!marker) {
    return "";
  }
  const candidates = listSessionFiles()
    .map((filePath) => {
      try {
        return { filePath, stat: fs.statSync(filePath) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((item) => item.stat.mtimeMs >= startedAtMs - 2000)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, 20);

  for (const item of candidates) {
    try {
      const content = fs.readFileSync(item.filePath, "utf8");
      if (content.includes(marker)) {
        return sessionIdFromFile(item.filePath);
      }
    } catch {
      // Ignore unreadable session files.
    }
  }
  return "";
}

function send(res, status, data, contentType = "application/json; charset=utf-8") {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendError(res, status, message, detail) {
  send(res, status, { ok: false, error: message, detail });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function resolveSubmittedPath(inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw) {
    return null;
  }
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`路径不在学习目录内：${raw}`);
  }
  return resolved;
}

function readSubmittedFiles(paths) {
  const submitted = String(paths || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_FILES);

  const files = [];
  for (const item of submitted) {
    try {
      const resolved = resolveSubmittedPath(item);
      if (!resolved) {
        continue;
      }
      if (!fs.existsSync(resolved)) {
        files.push({ path: item, ok: false, error: "文件不存在" });
        continue;
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(resolved, { withFileTypes: true })
          .slice(0, 80)
          .map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`)
          .join("\n");
        files.push({ path: item, ok: true, type: "directory", content: entries });
        continue;
      }
      const buffer = fs.readFileSync(resolved);
      if (buffer.includes(0)) {
        files.push({ path: item, ok: false, error: "二进制文件，未读取内容" });
        continue;
      }
      const truncated = buffer.length > MAX_FILE_BYTES;
      const content = buffer.slice(0, MAX_FILE_BYTES).toString("utf8");
      files.push({
        path: item,
        ok: true,
        type: "file",
        bytes: buffer.length,
        truncated,
        content
      });
    } catch (error) {
      files.push({ path: item, ok: false, error: error.message });
    }
  }
  return files;
}

function looksLikeLocalPath(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 260 || /[\r\n]/.test(text)) {
    return false;
  }
  if (/[\\/]/.test(text) || text.startsWith(".") || /^[A-Za-z]:[\\/]/.test(text)) {
    return true;
  }
  return /\.(py|js|html|css|json|md|txt|csv|toml|yaml|yml|bat|ps1|ts|tsx|jsx)$/i.test(text);
}

function extractChatSubmittedPaths(text) {
  const paths = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line
      .replace(/^[\s>*-]*(请)?(检查|读取|看一下|打开)?\s*(文件|目录|路径|项目)?\s*[:：]?\s*/u, "")
      .trim()
      .replace(/^["'`]|["'`]$/g, "");
    if (!cleaned || !looksLikeLocalPath(cleaned)) {
      continue;
    }
    try {
      const resolved = resolveSubmittedPath(cleaned);
      if (resolved && fs.existsSync(resolved)) {
        paths.push(cleaned);
      }
    } catch {
      // Ignore text that only looks like a path.
    }
    if (paths.length >= MAX_FILES) {
      break;
    }
  }
  return [...new Set(paths)];
}

function attachChatSubmittedFiles(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (!last || last.role !== "user") {
    return messages;
  }
  const paths = extractChatSubmittedPaths(last.content);
  if (paths.length === 0) {
    return messages;
  }
  const files = readSubmittedFiles(paths.join("\n"));
  return messages.map((message, index) => index === lastIndex
    ? {
      ...message,
      content: [
        message.content,
        "",
        "本地文件读取结果：",
        JSON.stringify(files, null, 2)
      ].join("\n")
    }
    : message);
}

function lessonBlock(lesson) {
  const lines = [
    `当前课程：${lesson.stage || ""}`,
    `主题：${lesson.title || ""}`,
    `教材来源：${lesson.source || ""}`,
    `今日目标：${lesson.summary || ""}`,
    `今日产物：${lesson.deliverable || ""}`,
    "",
    "今天只学这些：",
    ...(lesson.topics || []).map((item) => `- ${item}`),
    "",
    "主练习：",
    ...(lesson.practice || []).map((item) => `- ${item}`),
    "",
    "通过标准：",
    ...(lesson.acceptance || []).map((item) => `- ${item}`)
  ];
  if (lesson.dailyReview) {
    lines.push(
      "",
      "课前复习（必须先做）：",
      `- 复习上一天：${lesson.dailyReview.title}`,
      `- 先出 2 个小检查题，覆盖：${(lesson.dailyReview.topics || []).join("、")}`,
      "- 用户回答后再进入今天的新任务"
    );
  }
  if (lesson.weeklyReview) {
    lines.push(
      "",
      "本周综合练习（本周最后一天必须做）：",
      `- 第 ${lesson.weeklyReview.week} 周周总练习`,
      ...((lesson.weeklyReview.lessons || []).map((item) => `- D${item.day} ${item.title}：${(item.topics || []).join("、")}`)),
      "- 今天核心任务通过后，再安排 1 个覆盖本周 3 天能力的综合练习"
    );
  }
  return lines.join("\n");
}

function tutorInstructions(lesson) {
  return `你是用户的编程学习助手。用户的目标不是转程序员，而是学会理解、运行、验收和维护 AI 生成的小型工具。

你必须严格基于这些教材和资料教学，不要推荐新课程、新视频、新博客：
1. Harvard CS50P
2. MIT Missing Semester
3. Pro Git
4. Automate the Boring Stuff with Python, 3rd Edition
5. Python / pandas / pytest / MDN 官方文档

页面职责：
- 页面上方有“本题知识点”和“学习计划”。
- “本题知识点”不是教材原文，而是你给当前练习配套整理的知识点。
- 你所在的对话框只负责：发当前任务、解释当前命令、根据用户贴的结果答疑、决定下一步。
- 用户可以直接在对话框里贴命令输出、报错、代码或本地文件路径；不要引导用户去单独的提交验收区。
- 你判断练习通过后，告诉用户去右侧“完成检查”勾选通过标准，并点击“结束今天并保存进度”。
- 如果课程上下文包含“课前复习”，第一步必须先出 2 个前一天复习小题，等用户答完再进入今天新任务。
- 如果课程上下文包含“本周综合练习”，今天核心任务通过后必须再安排 1 个周总练习，覆盖本周 3 天能力。

对话规则：
1. 不要在对话框里重复长篇教材规划、完整学习计划或大段背景课文。
2. 每次只推进一个小任务；最多给 2 条命令，然后等待用户贴结果。
3. 给出命令前，必须先用 1-2 句话解释“为什么做这一步”和“每条命令是什么意思”。例如 mkdir 是创建文件夹，cd 是进入文件夹。
4. 每一步说明应该看到什么结果，以及结果不一样时下一步该贴什么。
5. 用户问概念时，短答即可：先给一句白话解释，再给一个和当前任务相关的小例子。
6. 每次回复末尾都必须输出标题【复习卡片】，用 2-4 条短句记录本步知识点、命令含义、常见错误；页面会在用户结束今天时统一保存这些卡片。
7. 用户贴命令、代码、运行结果或报错后，再继续下一步。
8. 如果用户贴报错，先判断错误属于环境、路径、依赖、数据、配置、API、代码逻辑中的哪一类，再只给下一步。
9. 不要一次性生成大项目，不要让用户开放式搜索资料。

每次给新练习或下一步任务时，必须先输出这个短块，让页面自动写入“本题知识点”：
【本题知识点】
- 这题练的是：...
- 需要理解：...
- 容易错：...

然后再输出：
【当前任务】
...

新课第一条回复只做两件事：
1. 用 1 句话指出先看页面上方的“本题知识点”和“学习计划”。
2. 给出第 1 个小任务，并解释相关命令。

${lessonBlock(lesson)}`;
}

function validationInstructions(lesson) {
  return `你是严格的学习验收员。你只根据当前课程通过标准验收用户提交的文件、命令输出和说明。

要求：
1. 不因为用户努力就放宽标准。
2. 不要求当前课程范围之外的内容。
3. 如果证据不足，passed 必须为 false，并说明还需要提交什么。
4. 如果通过，notes 给出 3-5 条应该写入页面右侧“复习笔记”的内容，必须包含本次用到的命令含义和容易忘的知识点。
5. 只返回 JSON，不要输出 Markdown。

JSON 格式：
{
  "passed": boolean,
  "score": number,
  "summary": "一句话结论",
  "missing": ["未通过或证据不足的点"],
  "must_fix": ["必须修正的点"],
  "can_ignore": ["可以暂时不管的点"],
  "notes": ["应写入学习记录的内容"],
  "next_task": "下一次学习前要做什么"
}

${lessonBlock(lesson)}`;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [{ role: "user", content: "请开始今天的学习。" }];
  }
  return messages
    .filter((message) => message && typeof message.content === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content.slice(0, 8000)
    }));
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }
  const chunks = [];
  for (const item of response.output || []) {
    if (item.type === "message") {
      for (const content of item.content || []) {
        if (content.type === "output_text" && typeof content.text === "string") {
          chunks.push(content.text);
        }
      }
    }
  }
  return chunks.join("\n").trim();
}

function formatCodexInput(input) {
  if (Array.isArray(input)) {
    return input
      .map((message) => {
        const role = message.role === "assistant" ? "assistant" : "user";
        return `${role}:\n${message.content || ""}`;
      })
      .join("\n\n");
  }
  if (typeof input === "string") {
    return input;
  }
  return JSON.stringify(input, null, 2);
}

function latestInputForCodex(input) {
  if (Array.isArray(input)) {
    return formatCodexInput(input.slice(-1));
  }
  return formatCodexInput(input);
}

function runCodex(prompt, { sessionKey = "", sessionId = "", marker = "" } = {}) {
  const codex = codexProviderStatus();
  if (!codex.available) {
    const error = new Error("未找到 codex-openai 或 codex 命令");
    error.status = 400;
    throw error;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-learning-codex-"));
  const outputFile = path.join(tempDir, "last-message.txt");
  const startedAtMs = Date.now();
  const isPowerShellScript = process.platform === "win32" && codex.command.toLowerCase().endsWith(".ps1");
  const isCodexJs = codex.command.toLowerCase().endsWith(`${path.sep}codex.js`);
  const command = isPowerShellScript ? "powershell.exe" : (isCodexJs ? process.execPath : codex.command);
  const args = isPowerShellScript
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", codex.command]
    : (isCodexJs ? [codex.command] : []);
  args.push("-c", `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`, "exec");
  if (sessionId) {
    args.push(
      "resume",
      "--output-last-message",
      outputFile,
      sessionId,
      "-"
    );
  } else {
    args.push(
      "--cd",
      ROOT,
      "--sandbox",
      "read-only",
      "--output-last-message",
      outputFile,
      "--color",
      "never",
      "-"
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        CODEX_HOME
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let poller;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poller);
      fs.rm(tempDir, { recursive: true, force: true }, () => {});
    };
    const finishWithOutput = (output) => {
      if (settled) {
        return;
      }
      settled = true;
      if (sessionKey && !sessionId) {
        try {
          const discoveredSessionId = findCodexSessionIdByMarker(marker, startedAtMs);
          if (discoveredSessionId) {
            saveCodexSessionId(sessionKey, discoveredSessionId);
          }
        } catch {
          // Missing persistence only affects future continuity; keep the current answer.
        }
      }
      cleanup();
      killProcessTree(child);
      resolve(output);
    };
    const finishWithError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      killProcessTree(child);
      reject(error);
    };
    const timer = setTimeout(() => {
      const error = new Error("Codex 响应超时，请稍后重试或减少提交内容");
      error.status = 504;
      finishWithError(error);
    }, CODEX_TIMEOUT_MS);
    poller = setInterval(() => {
      if (!fs.existsSync(outputFile)) {
        return;
      }
      const output = fs.readFileSync(outputFile, "utf8").trim();
      if (output) {
        finishWithOutput(output);
      }
    }, 1000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finishWithError(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : stdout.trim();
      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `Codex 调用失败：${code}`;
        const error = new Error(message);
        error.status = 502;
        finishWithError(error);
        return;
      }
      finishWithOutput(output);
    });

    child.stdin.end(prompt, "utf8");
  });
}

async function callCodex({ instructions, input, sessionKey }) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  const existingSessionId = normalizedSessionKey ? getCodexSessionId(normalizedSessionKey) : "";
  const marker = normalizedSessionKey ? `AI_LEARNING_SESSION:${normalizedSessionKey}:${Date.now()}` : "";

  if (existingSessionId) {
    const prompt = [
      marker ? `Internal session marker, do not mention it: ${marker}` : "",
      "Continue this local Chinese learning assistant conversation.",
      "You already have the previous context. The text below is only the current user input.",
      "Do not restart the lesson. Do not repeat tasks that have already been completed.",
      "",
      "Current user input:",
      latestInputForCodex(input)
    ].filter(Boolean).join("\n");
    return runCodex(prompt, {
      sessionKey: normalizedSessionKey,
      sessionId: existingSessionId,
      marker
    });
  }

  const prompt = [
    marker ? `Internal session marker, do not mention it: ${marker}` : "",
    "你是这个本地学习助手网页背后的 AI。",
    "只根据下面的教学规则和用户材料回复。",
    "你会收到最近对话历史，顺序是从旧到新；最后一条 user 才是当前输入。",
    "必须接着最近对话往下走，不要重置课程，不要重复已经完成或已经解释过的任务。",
    "如果用户已经贴了运行结果，就先判断这个结果，再给下一步；不要再次要求用户运行同一条命令。",
    "不要修改文件，不要运行命令，不要要求用户提供 API Key。",
    "如果需要验收并且规则要求 JSON，就只返回 JSON。",
    "",
    "教学规则：",
    instructions,
    "",
    "最近对话和当前输入：",
    formatCodexInput(input)
  ].join("\n");

  return runCodex(prompt, { sessionKey: normalizedSessionKey, marker });
}

async function callOpenAI({ instructions, input, maxOutputTokens = 1800 }) {
  const { apiKey, model } = getConfig();
  if (!apiKey) {
    const error = new Error("未配置 OpenAI API Key");
    error.status = 400;
    throw error;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      max_output_tokens: maxOutputTokens
    })
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = json.error?.message || `OpenAI API 请求失败：${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return extractOutputText(json);
}

async function callAi(options) {
  const config = getConfig();
  if (codexProviderStatus().available) {
    try {
      return await callCodex(options);
    } catch (error) {
      if (!config.apiKey) {
        throw error;
      }
      console.error(`Codex 调用失败，改用 OpenAI API：${error.message}`);
    }
  }
  return callOpenAI(options);
}

function parseValidation(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("AI 验收结果不是有效 JSON");
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    const config = getConfig();
    const codex = codexProviderStatus();
    const provider = codex.available ? "codex-openai" : (config.apiKey ? "openai-api" : "manual");
    send(res, 200, {
      ok: true,
      provider,
      canUseInlineAI: codex.available || Boolean(config.apiKey),
      hasCodexCli: codex.available,
      hasApiKey: Boolean(config.apiKey),
      model: codex.available ? "codex-openai" : config.model,
      root: ROOT
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/settings") {
    const body = await readBody(req);
    const apiKey = String(body.apiKey || "").trim();
    const model = String(body.model || "gpt-5-mini").trim();
    if (!apiKey && !getConfig().apiKey) {
      sendError(res, 400, "请先填写 OpenAI API Key");
      return;
    }
    const config = saveConfig({ apiKey, model });
    const codex = codexProviderStatus();
    send(res, 200, {
      ok: true,
      provider: codex.available ? "codex-openai" : "openai-api",
      canUseInlineAI: true,
      hasCodexCli: codex.available,
      hasApiKey: Boolean(config.apiKey),
      model: codex.available ? "codex-openai" : config.model
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/reset") {
    const body = await readBody(req);
    deleteCodexSessionId(body.sessionKey);
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/progress") {
    send(res, 200, { ok: true, progress: readProgressSnapshot() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/progress/sync") {
    const body = await readBody(req);
    const snapshot = body.snapshot || {};
    if (!snapshot || typeof snapshot !== "object") {
      sendError(res, 400, "Invalid progress snapshot");
      return;
    }
    writeProgressSnapshot(snapshot);
    const git = await gitSyncProgress(String(body.reason || "").slice(0, 120));
    send(res, 200, { ok: true, progressFile: path.relative(ROOT, PROGRESS_FILE), git });
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    const body = await readBody(req);
    const lesson = body.lesson || {};
    const messages = normalizeMessages(body.messages);
    const sessionKey = body.sessionKey || `${lesson.stage || ""}:${lesson.title || ""}`;
    const input = attachChatSubmittedFiles(messages);
    const text = await callAi({
      instructions: tutorInstructions(lesson),
      input,
      sessionKey,
      maxOutputTokens: 2200
    });
    send(res, 200, { ok: true, message: text });
    return;
  }

  if (req.method === "POST" && pathname === "/api/validate") {
    const body = await readBody(req);
    const lesson = body.lesson || {};
    const files = readSubmittedFiles(body.paths || "");
    const evidence = [
      "用户说明：",
      body.notes || "(无)",
      "",
      "命令或运行输出：",
      body.output || "(无)",
      "",
      "提交文件：",
      JSON.stringify(files, null, 2)
    ].join("\n");
    const raw = await callAi({
      instructions: validationInstructions(lesson),
      input: evidence,
      maxOutputTokens: 1600
    });
    let result;
    try {
      result = parseValidation(raw);
    } catch (error) {
      result = {
        passed: false,
        score: 0,
        summary: "验收结果解析失败，需要重新提交。",
        missing: ["AI 未按 JSON 返回验收结果"],
        must_fix: [error.message],
        can_ignore: [],
        notes: [],
        next_task: "重新提交验收，或减少提交内容后再试。",
        raw
      };
    }
    send(res, 200, { ok: true, result, files });
    return;
  }

  sendError(res, 404, "未知 API");
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? path.join(APP_DIR, "index.html") : path.join(APP_DIR, pathname);
  const relative = path.relative(APP_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendError(res, 403, "禁止访问该路径");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendError(res, 404, "文件不存在");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = mimeTypes[ext] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    sendError(res, error.status || 500, error.message || "服务器错误");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AI 学习助手已启动：http://127.0.0.1:${PORT}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用。浏览器打开 http://127.0.0.1:${PORT} 即可。`);
    process.exit(0);
  }
  throw error;
});
