// 本地静态预览：只绑 127.0.0.1，只服务 docs/ 目录，按物理路径判界。
// 前台运行（Ctrl+C 结束），不常驻、不自启、不写文件。
//   node scripts/preview.mjs [port]   默认 4173
// 仅用于本机查看 GitHub Pages 用的 docs/index.html。
//
// 边界（三条都不可放宽）：
//   1. 只接受 GET / HEAD，其余方法 405。
//   2. 用 realpath 判物理路径：docs 之外的软链接 / Windows junction 一律 403。
//   3. 只服务白名单静态资产类型，隐藏文件（.env 等）、备份、未知扩展名一律 404。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOCS_ROOT = path.resolve(HERE, "..", "docs");
export const PREVIEW_HOST = "127.0.0.1";
export const ALLOWED_METHODS = Object.freeze(["GET", "HEAD"]);

// 白名单：只有这些扩展名会被服务，其余（.env / .bak / .sqlite / 无扩展名）默认 404。
const ASSET_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
});

function baseHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

function fail(status, reason) {
  return { ok: false, status, reason };
}

// 纯函数：原始请求路径 → { ok:true, status:200, filePath, contentType } 或拒绝原因。
export function resolveDocRequest(rawUrl, docsRoot = DOCS_ROOT) {
  const raw = String(rawUrl ?? "/");
  const cut = raw.split("?")[0].split("#")[0];
  if (cut.includes("\0")) return fail(400, "null byte");
  let decoded;
  try {
    decoded = decodeURIComponent(cut);
  } catch {
    return fail(400, "bad encoding");
  }
  if (decoded.includes("\0")) return fail(400, "null byte");
  if (/[\\]/.test(decoded)) return fail(403, "backslash");

  const segments = decoded.split("/").filter((part) => part.length > 0);
  if (segments.some((part) => part === ".." || part === ".")) return fail(403, "traversal");
  // 隐藏文件（.env / .env.production / .git …）不对外，即使被临时拷进 docs/。
  if (segments.some((part) => part.startsWith("."))) return fail(404, "hidden path");

  const relative = segments.join("/") || "index.html";
  const root = path.resolve(docsRoot);
  const target = path.resolve(root, relative);
  // 第一道：字面路径必须在 docs 内。
  if (target !== root && !target.startsWith(root + path.sep)) return fail(403, "outside docs");

  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return fail(500, "docs root missing");
  }
  // 第二道：物理路径也必须在 docs 内。软链接 / junction 指出去就拒绝。
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    return fail(404, "not found");
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return fail(403, "outside docs");
  }

  let stat;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    return fail(404, "not found");
  }
  if (stat.isDirectory()) {
    return resolveDocRequest(`${relative.replace(/\/+$/, "")}/index.html`, root);
  }
  if (!stat.isFile()) return fail(404, "not a file");

  // 第三道：只服务白名单类型。按请求名判断，不按链接目标名。
  const contentType = ASSET_TYPES[path.extname(target).toLowerCase()];
  if (!contentType) return fail(404, "not an allowed asset type");

  return { ok: true, status: 200, filePath: realTarget, contentType };
}

export function createPreviewServer(docsRoot = DOCS_ROOT) {
  const server = http.createServer((req, res) => {
    try {
      const method = String(req.method ?? "GET").toUpperCase();
      if (!ALLOWED_METHODS.includes(method)) {
        res.writeHead(405, baseHeaders({
          "content-type": "text/plain; charset=utf-8",
          allow: "GET, HEAD",
        }));
        res.end("405 method not allowed\n");
        return;
      }

      const result = resolveDocRequest(req.url, docsRoot);
      if (!result.ok) {
        res.writeHead(result.status, baseHeaders({ "content-type": "text/plain; charset=utf-8" }));
        res.end(method === "HEAD" ? undefined : `${result.status} ${result.reason}\n`);
        return;
      }

      const body = fs.readFileSync(result.filePath);
      res.writeHead(200, baseHeaders({
        "content-type": result.contentType,
        "content-length": String(body.length),
      }));
      res.end(method === "HEAD" ? undefined : body);
    } catch {
      // 任何意外都回 500，不让单个请求把进程带崩。
      try {
        if (!res.headersSent) {
          res.writeHead(500, baseHeaders({ "content-type": "text/plain; charset=utf-8" }));
        }
        res.end("500 internal error\n");
      } catch {
        res.destroy();
      }
    }
  });
  server.on("clientError", (_error, socket) => {
    try {
      socket.destroy();
    } catch {
      // socket 已断，忽略
    }
  });
  return server;
}

// 端口只收严格十进制：拒绝 "4173abc"、"0x10"、"1e3"、" 4173"、"+4173"、""。
export function parsePort(raw) {
  const text = typeof raw === "number" ? String(raw) : String(raw ?? "");
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = parsePort(process.argv[2] ?? "4173");
  if (port === null) {
    console.error("端口不合法（只接受 1-65535 的十进制数字），用法：node scripts/preview.mjs [port]");
    process.exitCode = 2;
  } else {
    const server = createPreviewServer();
    server.on("error", (error) => {
      console.error(`预览服务启动失败：${error.code ?? error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, PREVIEW_HOST, () => {
      console.log(`本地预览：http://${PREVIEW_HOST}:${port}/  （仅 docs/ 目录，按 Ctrl+C 结束）`);
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        server.close(() => process.exit(0));
      });
    }
  }
}
