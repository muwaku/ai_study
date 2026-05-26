const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const APP_DIR = __dirname;
const PORT = Number(process.env.LEARNING_ASSISTANT_PORT || 43117);
const LOCAL_ENV = path.join(APP_DIR, ".env.local");
const MAX_BODY = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 80 * 1024;
const MAX_FILES = 8;

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

function lessonBlock(lesson) {
  return [
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
  ].join("\n");
}

function tutorInstructions(lesson) {
  return `你是用户的编程学习助手。用户的目标不是转程序员，而是学会理解、运行、验收和维护 AI 生成的小型工具。

你必须严格基于这些教材和资料教学，不要推荐新课程、新视频、新博客：
1. Harvard CS50P
2. MIT Missing Semester
3. Pro Git
4. Automate the Boring Stuff with Python, 3rd Edition
5. Python / pandas / pytest / MDN 官方文档

教学规则：
1. 每次只推进 30-45 分钟内容。
2. 用非科班、面向实际项目的方式解释必要概念。
3. 给出明确操作步骤，每一步说明应该看到什么结果。
4. 用户贴命令、代码、运行结果或报错后，再继续下一步。
5. 如果用户贴报错，先判断错误属于环境、路径、依赖、数据、配置、API、代码逻辑中的哪一类，再只给下一步。
6. 给一个主练习和一个 5 分钟变体练习。
7. 结束时总结今日笔记、掌握情况、下次任务。
8. 不要一次性生成大项目，不要让用户开放式搜索资料。

${lessonBlock(lesson)}`;
}

function validationInstructions(lesson) {
  return `你是严格的学习验收员。你只根据当前课程通过标准验收用户提交的文件、命令输出和说明。

要求：
1. 不因为用户努力就放宽标准。
2. 不要求当前课程范围之外的内容。
3. 如果证据不足，passed 必须为 false，并说明还需要提交什么。
4. 如果通过，notes 给出 3-5 条应该写入学习记录的内容。
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
    .slice(-16)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content.slice(0, 12000)
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
    send(res, 200, {
      ok: true,
      hasApiKey: Boolean(config.apiKey),
      model: config.model,
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
    send(res, 200, { ok: true, hasApiKey: Boolean(config.apiKey), model: config.model });
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    const body = await readBody(req);
    const lesson = body.lesson || {};
    const messages = normalizeMessages(body.messages);
    const text = await callOpenAI({
      instructions: tutorInstructions(lesson),
      input: messages,
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
    const raw = await callOpenAI({
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
