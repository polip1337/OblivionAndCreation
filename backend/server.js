import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import { Pool } from "pg";
import { z } from "zod";
import jwt from "jsonwebtoken";

const {
  PORT = "3000",
  DATABASE_URL,
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = "anthropic/claude-sonnet-4",
  ALLOWED_ORIGIN,
  ALLOW_NULL_ORIGIN = "false",
  SERVER_AUTH_TOKEN,
  TRUST_PROXY_HOPS = "1",
  SESSION_TTL_SECONDS = "600",
  SESSION_ISSUER = "dao-forge"
} = process.env;

if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}
if (!OPENROUTER_API_KEY) {
  throw new Error("Missing OPENROUTER_API_KEY");
}
if (!ALLOWED_ORIGIN) {
  throw new Error("Missing ALLOWED_ORIGIN");
}
if (!SERVER_AUTH_TOKEN) {
  throw new Error("Missing SERVER_AUTH_TOKEN");
}

const app = express();
app.disable("x-powered-by");
const trustProxyHops = Number(TRUST_PROXY_HOPS);
app.set("trust proxy", Number.isFinite(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({
  origin(origin, cb) {
    // Allow same-origin non-browser requests (curl/health checks) without Origin header.
    if (!origin) return cb(null, true);
    if (origin === "null" && ALLOW_NULL_ORIGIN === "true") return cb(null, true);
    if (origin === ALLOWED_ORIGIN) return cb(null, true);
    return cb(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600
}));
app.use(express.json({ limit: "16kb" }));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000
});

const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  timeout: 10000,
  defaultHeaders: {
    "HTTP-Referer": ALLOWED_ORIGIN,
    "X-Title": "Dao Synthesis Backend"
  }
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const sessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const forgeInputSchema = z.object({
  daoA: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 \-]+$/),
  daoB: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 \-]+$/),
  tier: z.number().int().min(1).max(9)
});

const hintInputSchema = z.object({
  knownDaos: z.array(
    z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 \-]+$/)
  ).max(80)
});

const allowedAffinities = new Set(["Yin", "Yang", "Neutral", "Paradox"]);
const allowedHarmony = new Set(["Heaven", "Earth", "Human"]);

function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

function pairKey(daoA, daoB, tier) {
  const a = normalizeName(daoA);
  const b = normalizeName(daoB);
  const [left, right] = [a, b].sort((x, y) => x.localeCompare(y));
  return `${left}|${right}|${tier}`;
}

function hashIp(ip) {
  let normalized = String(ip || "").trim();
  // Normalize IPv4-mapped IPv6 addresses to a consistent string.
  // Example: ::ffff:1.2.3.4 -> 1.2.3.4
  normalized = normalized.replace(/^::ffff:/i, "");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    // Use left-most (original client) when multiple proxies append.
    return xff.split(",")[0].trim();
  }
  // Fallback to Express' parsed ip (depends on trust proxy).
  return req.ip || req.socket?.remoteAddress || "";
}

function normalizeForgeResult(raw, daoA, daoB, tier) {
  const out = {};
  out.tier = tier;
  out.description = String(raw?.description || "Two paths cross, and a tempered doctrine remains.").slice(0, 160);
  out.affinity = allowedAffinities.has(raw?.affinity) ? raw.affinity : "Neutral";
  out.harmonyClass = allowedHarmony.has(raw?.harmonyClass) ? raw.harmonyClass : "Human";

  let name = String(raw?.name || "").trim();
  if (!name) name = `${normalizeName(daoA)}-${normalizeName(daoB)}`;
  if (tier === 9) {
    if (!["Creation", "Oblivion"].includes(name)) {
      name = out.affinity === "Yin" ? "Oblivion" : "Creation";
    }
  }
  if (tier !== 9) {
    // Examples:
    // - "Dao of Steam and Mist Dao" -> "Mist"
    // - "Mist Dao" -> "Mist"
    name = name.replace(/\s+Dao\s*$/i, "").trim();
    name = name.replace(/^Dao\s+of\s+/i, "").trim();
    name = name.replace(/\bDao\s+of\s+/ig, "").trim();
    const parts = name.split(/\s+(?:and|&)\s+/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) name = parts[parts.length - 1];
    name = name.replace(/^[\s\-]+|[\s\-]+$/g, "").trim() || name;
  }
  out.name = name.slice(0, 60);

  out.isUnstable = out.affinity === "Paradox";
  const decayRate = Number(raw?.decayRate) || 0;
  out.decayRate = out.isUnstable ? Math.min(180000, Math.max(30000, decayRate || 90000)) : 0;
  return out;
}

function buildForgePrompt(daoA, daoB, tier) {
  return `You are generating a Dao for a cultivation game.
Return strict JSON only with keys:
name,tier,description,affinity,harmonyClass,isUnstable,decayRate

Input:
- daoA: ${daoA}
- daoB: ${daoB}
- target tier: ${tier}

Rules:
- tier must equal ${tier}
- affinity: Yin, Yang, Neutral, or Paradox
- harmonyClass: Heaven, Earth, or Human
- isUnstable true only for Paradox
- decayRate 0 unless unstable; unstable range 30000-180000
- name max 60 chars
- description max 160 chars`;
}

async function callForgeModel(daoA, daoB, tier) {
  const completion = await openai.chat.completions.create({
    model: OPENROUTER_MODEL,
    temperature: 0.3,
    max_tokens: 220,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: buildForgePrompt(daoA, daoB, tier) }]
  });
  const content = completion?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty model response");

  const parsed = (() => {
    let str = String(content).trim();

    // Some providers still wrap JSON in Markdown fences; strip them.
    // Examples:
    // ```json { ... } ```
    // ``` { ... } ```
    str = str.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

    try {
      return JSON.parse(str);
    } catch {
      // Fall back to extracting the first JSON object substring.
      const firstBrace = str.indexOf("{");
      const lastBrace = str.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const sub = str.slice(firstBrace, lastBrace + 1);
        return JSON.parse(sub);
      }
      throw new Error("Could not parse model JSON");
    }
  })();

  return normalizeForgeResult(parsed, daoA, daoB, tier);
}

async function callHintModel(knownDaos) {
  const trimmed = knownDaos.slice(0, 40).join(", ");
  const completion = await openai.chat.completions.create({
    model: OPENROUTER_MODEL,
    temperature: 0.6,
    max_tokens: 80,
    messages: [{
      role: "user",
      content: `Given these Dao names: ${trimmed}. Suggest one interesting pair not yet tried. Reply exactly as: A + B`
    }]
  });
  const content = String(completion?.choices?.[0]?.message?.content || "").trim();
  return content.slice(0, 100) || "No omen answered.";
}

function getBearerToken(req) {
  const authHeader = String(req.get("authorization") || "");
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
}

function requireSessionScope(requiredScope) {
  return (req, res, next) => {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const payload = jwt.verify(token, SERVER_AUTH_TOKEN, {
        issuer: SESSION_ISSUER
      });
      const expectedIpHash = hashIp(getClientIp(req));
      if (!payload || payload.ip_hash !== expectedIpHash) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
      if (!scopes.includes(requiredScope)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      return next();
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }
  };
}

app.post("/api/session", sessionLimiter, async (req, res) => {
  // Issue a short-lived JWT tied to the caller's IP.
  // This avoids putting long-lived secrets in the browser.
  const ipHash = hashIp(getClientIp(req));
  const ttl = Number(SESSION_TTL_SECONDS);
  const token = jwt.sign(
    { ip_hash: ipHash, scopes: ["forge:generate", "forge:hint"] },
    SERVER_AUTH_TOKEN,
    {
      issuer: SESSION_ISSUER,
      expiresIn: Number.isFinite(ttl) && ttl > 0 ? ttl : 600
    }
  );
  return res.json({ token, expiresIn: ttl || 600 });
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.post("/api/forge", readLimiter, async (req, res) => {
  const parsed = forgeInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid forge payload" });
  }

  const { daoA, daoB, tier } = parsed.data;
  const key = pairKey(daoA, daoB, tier);
  console.log(`[forge] lookup requested key="${key}"`);

  try {
    const cached = await pool.query(
      "SELECT result_json FROM forge_results WHERE pair_key = $1",
      [key]
    );
    if (cached.rowCount > 0) {
      console.log(`[forge] cache hit key="${key}" result="${cached.rows[0]?.result_json?.name || "unknown"}"`);
      return res.json({ source: "cache", result: cached.rows[0].result_json });
    }
    console.log(`[forge] cache miss key="${key}"`);
    return res.status(404).json({ error: "NotFound" });
  } catch (err) {
    console.error("forge cache query failed:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail
    });
    return res.status(500).json({ error: "Failed to query forge cache" });
  }
});

app.post("/api/forge/generate", generateLimiter, requireSessionScope("forge:generate"), async (req, res) => {
  const parsed = forgeInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid forge payload" });
  }

  const { daoA, daoB, tier } = parsed.data;
  const key = pairKey(daoA, daoB, tier);
  console.log(`[forge] generate requested key="${key}"`);

  try {
    const cached = await pool.query(
      "SELECT result_json FROM forge_results WHERE pair_key = $1",
      [key]
    );
    if (cached.rowCount > 0) {
      console.log(`[forge] generate reused cached key="${key}" result="${cached.rows[0]?.result_json?.name || "unknown"}"`);
      return res.json({ source: "cache", result: cached.rows[0].result_json });
    }

    console.log(`[forge] generating new key="${key}"`);
    const generated = await callForgeModel(daoA, daoB, tier);
    const ipHash = hashIp(req.ip);

    await pool.query(
      `INSERT INTO forge_results
      (pair_key, dao_a, dao_b, tier, result_json, generated_by_ip_hash)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (pair_key) DO NOTHING`,
      [key, normalizeName(daoA), normalizeName(daoB), tier, JSON.stringify(generated), ipHash]
    );

    const inserted = await pool.query(
      "SELECT result_json FROM forge_results WHERE pair_key = $1",
      [key]
    );
    console.log(`[forge] generated and stored key="${key}" result="${inserted.rows[0]?.result_json?.name || "unknown"}"`);
    return res.json({ source: "generated", result: inserted.rows[0].result_json });
  } catch (err) {
    console.error("forge generate failed:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail
    });
    return res.status(502).json({ error: "Forge generation failed" });
  }
});

app.post("/api/hint", generateLimiter, requireSessionScope("forge:hint"), async (req, res) => {
  const parsed = hintInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid hint payload" });
  }
  try {
    const hint = await callHintModel(parsed.data.knownDaos);
    return res.json({ hint });
  } catch (err) {
    console.error("hint generation failed:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail
    });
    return res.status(502).json({ error: "Hint generation failed" });
  }
});

app.use((err, req, res, next) => {
  console.error("unhandled server error:", {
    message: err?.message,
    code: err?.code,
    stack: err?.stack
  });
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: "Internal server error" });
});

app.listen(Number(PORT), () => {
  console.log(`Forge backend listening on port ${PORT}`);
});
