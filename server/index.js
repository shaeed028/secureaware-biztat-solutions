import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PostgresSync } from "./db/postgres-sync.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
// On Vercel, fail closed if the durable database is not configured. Local SQLite
// remains available for development and the existing isolated test suite.
const usePostgres = Boolean(process.env.DATABASE_URL) && !process.env.SECUREAWARE_DB;
if (process.env.VERCEL && !usePostgres) throw new Error("DATABASE_URL must be configured on Vercel");
const inMemoryDatabase = !usePostgres && process.env.SECUREAWARE_IN_MEMORY === "on";
const dbPath = process.env.SECUREAWARE_DB || (inMemoryDatabase ? ":memory:" : path.join(dataDir, "secureaware.sqlite"));
const port = Number(process.env.PORT || 4000);
const sessionIdleMs = Number(process.env.SESSION_IDLE_MINUTES || 30) * 60 * 1000;
const bodyLimitBytes = 1_000_000;
const demoAccountsEnabled = process.env.NODE_ENV !== "production" || process.env.SECUREAWARE_DEMO_DATA === "on";
const demoPasswords = new Map([
  ["employee.demo", "EmployeePass!2026"],
  ["dev.demo", "DeveloperPass!2026"],
  ["consultant.demo", "ConsultantPass!2026"],
  ["manager.demo", "ManagerPass!2026"],
  ["manager.consulting", "ConsultManagerPass!2026"],
  ["security.admin", "AdminPass!2026"],
  ["system.admin", "SystemPass!2026"]
]);

if (!usePostgres && dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = usePostgres ? new PostgresSync() : new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('Employee','Department Manager','Security/HR Admin','System Admin')),
  department TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  ip_address TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
`);

if (demoAccountsEnabled) {
  seedFoundation();
  seedDemoUsers();
}

const statements = {
  userByUsername: db.prepare("SELECT * FROM users WHERE username = ? AND active = 1"),
  userById: db.prepare("SELECT * FROM users WHERE id = ? AND active = 1"),
  sessionById: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  insertSession: db.prepare("INSERT INTO sessions (id,user_id,csrf_token,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?)"),
  refreshSession: db.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  audit: db.prepare("INSERT INTO audit_events (actor_user_id,action,target,ip_address,created_at) VALUES (?,?,?,?,?)")
};

// Feature modules live in server/modules/<name>/index.js and are discovered at startup,
// so each member branch adds its own folder without editing this file.
const foundation = { db, audit, hasRole, readJson, sendJson, sendCsv, toCsv, publicError, publicUser, notify, validatePasswordPolicy, hashPassword };
const modules = await loadModules();

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    if (!error.publicMessage) console.error(error);
    if (response.headersSent) return response.end();
    sendJson(response, error.status || 500, { message: error.publicMessage || "Server error" });
  });
});

async function loadModules() {
  const modulesDir = path.join(root, "server", "modules");
  if (!fs.existsSync(modulesDir)) return [];
  const loaded = [];
  for (const name of fs.readdirSync(modulesDir).sort()) {
    const entry = path.join(modulesDir, name, "index.js");
    if (!fs.existsSync(entry)) continue;
    const mod = await import(pathToFileURL(entry).href);
    await mod.init?.(foundation);
    loaded.push(mod);
  }
  return loaded;
}

function runModuleHook(hook, ...args) {
  for (const mod of modules) {
    try {
      mod[hook]?.(...args);
    } catch (error) {
      console.error(`Module hook ${hook} failed`, error);
    }
  }
}

export async function handleRequest(request, response) {
  applySecurityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/api/health") return sendJson(response, 200, { ok: true });
  if (request.method === "POST" && url.pathname === "/api/auth/login") return login(request, response);
  if (request.method === "POST" && url.pathname === "/api/auth/logout") return logout(request, response);
  if (url.pathname.startsWith("/api/")) return api(request, response, url);
  return serveStatic(response, url.pathname);
}

async function api(request, response, url) {
  const context = requireSession(request, response);
  if (!context) return sendJson(response, 401, { message: "Authentication required" });
  // The session cookie is shared by every tab in the browser. Telling the page whose session
  // answered lets a tab that still shows another user notice the switch instead of showing
  // (or changing) that other person's progress.
  response.setHeader("x-secureaware-user", String(context.user.id));
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers["x-csrf-token"] !== context.session.csrf_token) {
    audit(context.user.id, "CSRF_REJECTED", url.pathname, request);
    return sendJson(response, 403, { message: "Request verification failed" });
  }
  if (request.method === "GET" && url.pathname === "/api/me") {
    return sendJson(response, 200, { user: publicUser(context.user), csrfToken: context.session.csrf_token });
  }
  if (request.method === "GET" && url.pathname === "/api/foundation/audit") {
    if (!hasRole(context.user, ["Security/HR Admin", "System Admin"])) return sendJson(response, 403, { message: "Access denied" });
    return sendJson(response, 200, { auditEvents: auditRows() });
  }
  if (request.method === "GET" && url.pathname === "/api/foundation/audit.csv") {
    if (!hasRole(context.user, ["Security/HR Admin", "System Admin"])) return sendJson(response, 403, { message: "Access denied" });
    return sendCsv(response, auditRows(), ["id", "created_at", "username", "action", "target", "ip_address"], "audit.csv");
  }
  if (request.method === "POST" && url.pathname === "/api/auth/password") return changePassword(request, response, context);
  if (request.method === "GET" && url.pathname === "/api/notifications") {
    const rows = db.prepare("SELECT id,type,title,body,link,created_at,read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100").all(context.user.id);
    return sendJson(response, 200, { notifications: rows, unreadCount: rows.filter((row) => !row.read_at).length });
  }
  const readMatch = url.pathname.match(/^\/api\/notifications\/(\d{1,10})\/read$/);
  if (request.method === "POST" && readMatch) {
    const result = db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL").run(new Date().toISOString(), Number(readMatch[1]), context.user.id);
    return sendJson(response, result.changes ? 200 : 404, result.changes ? { ok: true } : { message: "Not found" });
  }
  for (const mod of modules) {
    if (mod.prefix && url.pathname.startsWith(mod.prefix)) return mod.handle(request, response, url, context);
  }
  return sendJson(response, 404, { message: "Not found" });
}

async function changePassword(request, response, context) {
  const body = await readJson(request, 4096);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!verifyPassword(currentPassword, context.user.password_salt, context.user.password_hash)) {
    audit(context.user.id, "PASSWORD_CHANGE_FAILED", context.user.username, request);
    return sendJson(response, 400, { message: "Current password is incorrect" });
  }
  const problem = validatePasswordPolicy(newPassword, context.user);
  if (problem) return sendJson(response, 400, { message: problem });
  const hashed = hashPassword(newPassword.normalize("NFKC"));
  db.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?").run(hashed.salt, hashed.hash, context.user.id);
  // End every other session so a stolen session cannot outlive the password change.
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").run(context.user.id, context.session.id);
  audit(context.user.id, "PASSWORD_CHANGED", context.user.username, request);
  return sendJson(response, 200, { ok: true });
}

// NIST SP 800-63B-4 (2025): at least 15 characters when the password is the only factor,
// no composition rules, no forced periodic change, and new passwords checked against a blocklist.
const passwordBlocklist = new Set([
  "password", "passw0rd", "password1", "password123", "123456789012345", "qwertyuiopasdfg", "iloveyou",
  "letmein", "welcome", "admin", "administrator", "changeme", "secureaware", "biztat", "biztatsolutions",
  "abc123", "111111111111111", "000000000000000", "aaaaaaaaaaaaaaa", "qwerty123456789", "trustno1"
]);

function validatePasswordPolicy(password, user = null) {
  if (typeof password !== "string") return "Password is required";
  const normalized = password.normalize("NFKC");
  const length = [...normalized].length;
  if (length < 15) return "Use at least 15 characters. A passphrase of several unrelated words works well.";
  if (length > 128) return "Use at most 128 characters";
  const compact = normalized.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (passwordBlocklist.has(normalized.toLowerCase()) || passwordBlocklist.has(compact)) return "This password is on the list of common or breached passwords";
  if (/^(.)\1+$/.test(normalized)) return "Do not use a single repeated character";
  const remainder = ["password", "secureaware", "biztat", "qwerty", "123456", "admin", "welcome"]
    .reduce((text, word) => text.replaceAll(word, ""), compact);
  if (remainder.length < 6) return "This password is too close to a common password";
  if (user && compact.includes(user.username.toLowerCase().replace(/[^a-z0-9]/g, ""))) return "Do not include your username";
  return null;
}

function notify(userId, type, title, body, link = null) {
  db.prepare("INSERT INTO notifications (user_id,type,title,body,link,created_at) VALUES (?,?,?,?,?,?)")
    .run(userId, String(type).slice(0, 40), String(title).slice(0, 160), String(body).slice(0, 1000), link ? String(link).slice(0, 240) : null, new Date().toISOString());
}

async function login(request, response) {
  const body = await readJson(request);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const user = statements.userByUsername.get(username);
  if (!user || isLocked(user) || isDefaultDemoUser(user) || !verifyPassword(password, user.password_salt, user.password_hash)) {
    if (user) registerFailedLogin(user);
    audit(user?.id ?? null, "LOGIN_FAILED", username || "unknown", request);
    return sendJson(response, 401, { message: "Invalid username or password" });
  }
  db.prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?").run(user.id);
  const now = new Date();
  const sessionId = token();
  const csrfToken = token();
  const expiresAt = new Date(now.getTime() + sessionIdleMs).toISOString();
  statements.insertSession.run(sessionId, user.id, csrfToken, expiresAt, now.toISOString(), now.toISOString());
  audit(user.id, "LOGIN_SUCCESS", user.username, request);
  runModuleHook("onLogin", user);
  response.setHeader("Set-Cookie", cookie("secureaware_session", sessionId, { httpOnly: true, sameSite: "Strict", maxAge: Math.floor(sessionIdleMs / 1000) }));
  return sendJson(response, 200, { user: publicUser(user), csrfToken });
}

function logout(request, response) {
  const sessionId = parseCookies(request).secureaware_session;
  const context = sessionId ? sessionContext(sessionId) : null;
  if (context && request.headers["x-csrf-token"] !== context.session.csrf_token) {
    audit(context.user.id, "CSRF_REJECTED", "/api/auth/logout", request);
    return sendJson(response, 403, { message: "Request verification failed" });
  }
  if (sessionId) statements.deleteSession.run(sessionId);
  if (context) audit(context.user.id, "LOGOUT", context.user.username, request);
  response.setHeader("Set-Cookie", cookie("secureaware_session", "", { httpOnly: true, sameSite: "Strict", maxAge: 0 }));
  return sendJson(response, 200, { ok: true });
}

function requireSession(request) {
  const sessionId = parseCookies(request).secureaware_session;
  if (!sessionId) return null;
  const context = sessionContext(sessionId);
  if (!context) return null;
  if (new Date(context.session.expires_at) <= new Date()) {
    statements.deleteSession.run(sessionId);
    return null;
  }
  const now = new Date();
  statements.refreshSession.run(new Date(now.getTime() + sessionIdleMs).toISOString(), now.toISOString(), sessionId);
  return context;
}

function sessionContext(sessionId) {
  const session = statements.sessionById.get(sessionId);
  if (!session) return null;
  const user = statements.userById.get(session.user_id);
  return user && !isDefaultDemoUser(user) ? { user, session } : null;
}

function isDefaultDemoUser(user) {
  const password = demoPasswords.get(user?.username);
  return !demoAccountsEnabled && Boolean(password && verifyPassword(password, user.password_salt, user.password_hash));
}

function registerFailedLogin(user) {
  const count = user.failed_login_count + 1;
  const lockedUntil = count >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
  db.prepare("UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?").run(count, lockedUntil, user.id);
}

function isLocked(user) {
  return user.locked_until && new Date(user.locked_until) > new Date();
}

function hasRole(user, roles) {
  return roles.includes(user.role);
}

function audit(userId, action, target, request = null) {
  statements.audit.run(userId, action, String(target).slice(0, 240), request?.socket?.remoteAddress || null, new Date().toISOString());
}

function auditRows() {
  return db.prepare(`SELECT ae.id, ae.action, ae.target, ae.ip_address, ae.created_at, u.username, u.display_name
    FROM audit_events ae LEFT JOIN users u ON u.id = ae.actor_user_id
    ORDER BY ae.id DESC LIMIT 200`).all();
}

function seedFoundation() {
  if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count) return;
  const now = new Date().toISOString();
  for (const user of [
    ["employee.demo", "Employee Demo", "Employee", "Finance", "EmployeePass!2026"],
    ["manager.demo", "Manager Demo", "Department Manager", "Finance", "ManagerPass!2026"],
    ["security.admin", "Security HR Admin", "Security/HR Admin", "Information Security", "AdminPass!2026"],
    ["system.admin", "System Admin", "System Admin", "IT", "SystemPass!2026"]
  ]) {
    const [username, name, role, department, password] = user;
    const hashed = hashPassword(password);
    db.prepare("INSERT INTO users (username,display_name,role,department,password_salt,password_hash,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(username, name, role, department, hashed.salt, hashed.hash, now);
  }
  db.prepare("INSERT INTO audit_events (action,target,created_at) VALUES (?,?,?)").run("SYSTEM_INITIALIZED", "SecureAware foundation seed", now);
}

// Extra fictional demo users so department scoping can be demonstrated. Safe to re-run.
function seedDemoUsers() {
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT OR IGNORE INTO users (username,display_name,role,department,password_salt,password_hash,created_at) VALUES (?,?,?,?,?,?,?)");
  for (const [username, name, role, department, password] of [
    ["dev.demo", "Developer Demo", "Employee", "Development", "DeveloperPass!2026"],
    ["consultant.demo", "Consultant Demo", "Employee", "Consulting", "ConsultantPass!2026"],
    ["manager.consulting", "Consulting Manager Demo", "Department Manager", "Consulting", "ConsultManagerPass!2026"]
  ]) {
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) continue;
    const hashed = hashPassword(password);
    insert.run(username, name, role, department, hashed.salt, hashed.hash, now);
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expectedHash, "hex"));
}

async function readJson(request, limit = bodyLimitBytes) {
  if (Number(request.headers["content-length"] || 0) > limit) throw publicError(413, "Request body is too large");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw publicError(413, "Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw publicError(400, "Malformed JSON");
  }
}

function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role, department: user.department };
}

function serveStatic(response, requestPath) {
  const resolved = path.normalize(path.join(publicDir, requestPath === "/" ? "index.html" : requestPath));
  const filePath = resolved.startsWith(publicDir + path.sep) &&fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : path.join(publicDir, "index.html");
  response.writeHead(200, { "content-type": contentType(filePath) });
  fs.createReadStream(filePath).pipe(response);
}

function contentType(filePath) {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

// Spreadsheet apps execute cells that start with = + - @ (and tab/CR), so prefix them with a quote.
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows, fields) {
  return [fields.map(csvCell).join(","), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(","))].join("\r\n");
}

function sendCsv(response, rows, fields, filename) {
  const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${safeName}"`, "cache-control": "no-store" });
  response.end(toCsv(rows, fields));
}

function applySecurityHeaders(response) {
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").filter(Boolean).map((pair) => {
    const index = pair.indexOf("=");
    return [decodeURIComponent(pair.slice(0, index).trim()), decodeURIComponent(pair.slice(index + 1).trim())];
  }));
}

function cookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, "Path=/"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function token() {
  return crypto.randomBytes(32).toString("base64url");
}

function publicError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  return error;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  server.listen(port, host, () => {
    console.log(`SecureAware listening on ${host}:${port}`);
  });
}

export default server;
