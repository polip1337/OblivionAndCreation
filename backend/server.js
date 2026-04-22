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
  ALLOWED_ORIGINS = "",
  ALLOW_NULL_ORIGIN = "false",
  SERVER_AUTH_TOKEN,
  TRUST_PROXY_HOPS = "1",
  SESSION_TTL_SECONDS = "600",
  SESSION_ISSUER = "dao-forge"
} = process.env;

if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");
if (!OPENROUTER_API_KEY) throw new Error("Missing OPENROUTER_API_KEY");
if (!SERVER_AUTH_TOKEN) throw new Error("Missing SERVER_AUTH_TOKEN");
function normalizeOriginValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

const parsedAllowedOrigins = Array.from(new Set(
  [
    ...String(ALLOWED_ORIGINS || "").split(",").map((x) => normalizeOriginValue(x)).filter(Boolean),
    ...(ALLOWED_ORIGIN ? [normalizeOriginValue(ALLOWED_ORIGIN)] : [])
  ].filter(Boolean)
));
if (!parsedAllowedOrigins.length) {
  throw new Error("Missing allowed origin configuration. Set ALLOWED_ORIGIN or ALLOWED_ORIGINS.");
}

// ---------------------------------------------------------------------------
// Tier 1 seed Daos — concrete natural elements only.
// Abstract concepts (Void, Time, Chaos, Order, Dream, etc.) belong at T4+.
// ---------------------------------------------------------------------------
const TIER1_SEEDS = [
  ["Fire",    "Yang",    "Heaven"],
  ["Water",   "Yin",     "Heaven"],
  ["Stone",   "Neutral", "Earth"],
  ["Wind",    "Yang",    "Heaven"],
  ["Mist",    "Yin",     "Earth"],
  ["Thunder", "Yang",    "Heaven"],
  ["Mud",     "Neutral", "Earth"],
  ["Ash",     "Yin",     "Earth"],
  ["Ice",     "Yin",     "Heaven"],
  ["Bloom",   "Yang",    "Earth"],
  ["Thorn",   "Neutral", "Earth"],
  ["Rain",    "Yin",     "Heaven"],
  ["Ember",   "Yang",    "Heaven"],
  ["Sand",    "Neutral", "Earth"],
  ["Root",    "Yin",     "Earth"],
  ["Smoke",   "Neutral", "Heaven"],
  ["Tide",    "Yin",     "Heaven"],
  ["Spark",   "Yang",    "Heaven"],
  ["Blood",   "Yang",    "Human"],
  ["Bone",    "Neutral", "Human"]
];

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
const trustProxyHops = Number(TRUST_PROXY_HOPS);
app.set("trust proxy", Number.isFinite(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

const corsOptions = {
  origin(origin, cb) {
    const normalizedIncomingOrigin = normalizeOriginValue(origin);
    if (!origin) return cb(null, true);
    if (origin === "null" && ALLOW_NULL_ORIGIN === "true") return cb(null, true);
    if (parsedAllowedOrigins.includes(normalizedIncomingOrigin)) return cb(null, true);
    console.warn("[cors] blocked origin", { origin, normalizedIncomingOrigin, allowNullOrigin: ALLOW_NULL_ORIGIN === "true", allowedOrigins: parsedAllowedOrigins });
    // Return false instead of throwing to avoid 500 on preflight.
    return cb(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "16kb" }));

// ---------------------------------------------------------------------------
// DB + AI clients
// ---------------------------------------------------------------------------
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
    "HTTP-Referer": parsedAllowedOrigins[0],
    "X-Title": "Dao Synthesis Backend"
  }
});

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const forgeInputSchema = z.object({
  daoA: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 \-]+$/),
  daoB: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 \-]+$/),
  tier: z.number().int().min(1).max(9),
  // Optional parent affinities passed by the client for prompt biasing.
  affinityA: z.enum(["Yin", "Yang", "Neutral", "Paradox"]).optional(),
  affinityB: z.enum(["Yin", "Yang", "Neutral", "Paradox"]).optional()
});

const hintInputSchema = z.object({
  knownDaos: z.array(
    z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 \-]+$/)
  ).max(80)
});
const supportiveSelectSchema = z.object({
  draftId: z.string().trim().min(1).max(120),
  selectedOptionIndex: z.number().int().min(0).max(9)
});
const daoVoteSchema = z.object({
  daoName: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 \-]+$/),
  tier: z.number().int().min(2).max(9),
  vote: z.enum(["up", "down"]),
  pairKey: z.string().trim().max(180).optional(),
  sourceMode: z.enum(["simple", "supportive"]).optional()
});
const mastersProgressSchema = z.object({
  totalDiscoveries: z.number().int().min(0).max(100000),
  totalCpEarned: z.number().int().min(0).max(100000000),
  maxTier: z.number().int().min(1).max(9),
  activeDaos: z.number().int().min(0).max(3),
  masteredDaos: z.number().int().min(0).max(10000)
});

const MASTER_QUESTS = [
  {
    id: "first_steps",
    title: "Master Yun: First Steps",
    description: "Discover 5 Daos to prove your foundation is stable.",
    metric: "totalDiscoveries",
    target: 5,
    rewardLabel: "+30 CP (client-side reward hook placeholder)"
  },
  {
    id: "echo_keeper",
    title: "Master Yin: Echo Keeper",
    description: "Activate all 3 active Dao slots at once.",
    metric: "activeDaos",
    target: 3,
    rewardLabel: "Echo attunement seal"
  },
  {
    id: "tier_climber",
    title: "Master Jian: Tier Climber",
    description: "Reach Tier 5 in your discovered Daos.",
    metric: "maxTier",
    target: 5,
    rewardLabel: "Tier path guidance"
  },
  {
    id: "insight_collector",
    title: "Master Hua: Insight Collector",
    description: "Accumulate 300 total CP earned.",
    metric: "totalCpEarned",
    target: 300,
    rewardLabel: "Meditation transcript"
  },
  {
    id: "discipline_scholar",
    title: "Master Rui: Discipline Scholar",
    description: "Reach mastery in 3 different Daos (100+ each).",
    metric: "masteredDaos",
    target: 3,
    rewardLabel: "Master's annotation"
  }
];

const allowedAffinities = new Set(["Yin", "Yang", "Neutral", "Paradox"]);
const allowedHarmony = new Set(["Heaven", "Earth", "Human"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
  normalized = normalized.replace(/^::ffff:/i, "");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "";
}

function seededUnitInterval(seed) {
  const hex = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const intVal = Number.parseInt(hex, 16);
  return Number.isFinite(intVal) ? intVal / 0xffffffff : 0.5;
}

function getQuestProgressValue(quest, metrics) {
  const raw = Number(metrics?.[quest.metric] || 0);
  const safe = Number.isFinite(raw) ? raw : 0;
  return Math.max(0, Math.min(quest.target, safe));
}

// ---------------------------------------------------------------------------
// Affinity convergence — tiers 6-8 push toward Yin/Yang poles.
// T9 is handled separately in normalizeForgeResult.
// ---------------------------------------------------------------------------
function convergeHighTierAffinity(rawAffinity, daoA, daoB, tier) {
  if (tier < 6 || tier > 8) return rawAffinity;
  const a = normalizeName(daoA);
  const b = normalizeName(daoB);
  const sorted = [a, b].sort((x, y) => x.localeCompare(y));
  const baseSeed = `${sorted[0]}|${sorted[1]}|${tier}`;
  const uBucket = seededUnitInterval(`${baseSeed}|bucket`);
  const uPolarity = seededUnitInterval(`${baseSeed}|polarity`);

  const polarAffinity = (rawAffinity === "Yin" || rawAffinity === "Yang")
    ? rawAffinity
    : (uPolarity < 0.5 ? "Yang" : "Yin");

  // T6: 75% polar, 17% neutral, 8% paradox
  // T7: 88% polar, 8% neutral, 4% paradox
  // T8: 98% polar, 1% neutral, 1% paradox
  const profileByTier = {
    6: { paradox: 0.08, neutral: 0.17 },
    7: { paradox: 0.04, neutral: 0.08 },
    8: { paradox: 0.01, neutral: 0.01 }
  };
  const profile = profileByTier[tier];
  if (!profile) return rawAffinity;
  if (uBucket < profile.paradox) return "Paradox";
  if (uBucket < profile.paradox + profile.neutral) return "Neutral";
  return polarAffinity;
}

function normalizeForgeResult(raw, daoA, daoB, tier) {
  const out = {};
  out.tier = tier;
  out.description = String(raw?.description || "Two paths cross, and a tempered doctrine remains.").slice(0, 160);
  const normalizedAffinity = allowedAffinities.has(raw?.affinity) ? raw.affinity : "Neutral";
  out.affinity = convergeHighTierAffinity(normalizedAffinity, daoA, daoB, tier);
  out.harmonyClass = allowedHarmony.has(raw?.harmonyClass) ? raw.harmonyClass : "Human";

  let name = String(raw?.name || "").trim();
  if (!name) name = `${normalizeName(daoA)}-${normalizeName(daoB)}`;

  if (tier === 9) {
    // T9: resolve to one of three terminal endpoints.
    // Neutral gets its own endpoint; Paradox is forced to a pole via seeded
    // randomness so the same pair always produces the same result.
    if (!["Creation", "Oblivion", "Equilibrium"].includes(name)) {
      if (out.affinity === "Neutral") {
        name = "Equilibrium";
      } else {
        let resolvedAffinity = out.affinity;
        if (resolvedAffinity === "Paradox") {
          const a = normalizeName(daoA);
          const b = normalizeName(daoB);
          const sorted = [a, b].sort((x, y) => x.localeCompare(y));
          const seed = `${sorted[0]}|${sorted[1]}|9|resolution`;
          resolvedAffinity = seededUnitInterval(seed) < 0.5 ? "Yin" : "Yang";
        }
        name = resolvedAffinity === "Yin" ? "Oblivion" : "Creation";
      }
    }
    // T9 endpoints are always terminal — never unstable.
    out.isUnstable = false;
    out.decayRate = 0;
  } else {
    // Strip common model artifacts from generated names.
    name = name.replace(/\s+Dao\s*$/i, "").trim();
    name = name.replace(/^Dao\s+of\s+/i, "").trim();
    name = name.replace(/\bDao\s+of\s+/ig, "").trim();
    // Force-strip numeric tokens/suffixes from generated names.
    name = name.replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();
    const parts = name.split(/\s+(?:and|&)\s+/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) name = parts[parts.length - 1];
    name = name.replace(/^[\s\-]+|[\s\-]+$/g, "").trim() || name;

    out.isUnstable = out.affinity === "Paradox";
    const decayRate = Number(raw?.decayRate) || 0;
    out.decayRate = out.isUnstable ? Math.min(180000, Math.max(30000, decayRate || 90000)) : 0;
  }

  out.name = name.slice(0, 60);
  return out;
}

function unifyDaoIdentityFromExisting(firstResult, generatedResult) {
  if (!firstResult || !generatedResult) return generatedResult;
  // Keep the newly generated pair-key entry, but align identity/bonuses
  // to the first existing Dao with the same name+tier.
  return {
    ...generatedResult,
    description: firstResult.description ?? generatedResult.description,
    affinity: firstResult.affinity ?? generatedResult.affinity,
    harmonyClass: firstResult.harmonyClass ?? generatedResult.harmonyClass,
    isUnstable: typeof firstResult.isUnstable === "boolean" ? firstResult.isUnstable : generatedResult.isUnstable,
    decayRate: Number.isFinite(firstResult.decayRate) ? firstResult.decayRate : generatedResult.decayRate
  };
}

// ---------------------------------------------------------------------------
// Prompt building — tier-aware thematic register + affinity inheritance.
// ---------------------------------------------------------------------------

/**
 * Returns a thematic description for the target tier so the model understands
 * where in the concrete→abstract arc it is generating.
 */
function getTierTheme(tier) {
  return {
    1: "concrete natural elements: fire, water, stone, wind, mist",
    2: "simple natural forces and phenomena: tide, storm, drought, bloom",
    3: "elemental interactions and early tensions: erosion, ignition, stillness",
    4: "abstract natural principles: cycle, entropy, equilibrium, pressure",
    5: "philosophical tensions and dualities: impermanence, resonance, void-echo",
    6: "deep metaphysical concepts: dissolution, emergence, boundlessness",
    7: "near-absolute principles: negation, totality, the formless",
    8: "threshold concepts, one step from the absolute: the Unnamed, the Unborn, Pure Potential",
    9: "the absolute poles of existence: Creation or Oblivion only"
  }[tier] ?? "abstract philosophical concepts";
}

/**
 * Few-shot vocabulary anchors for high tiers where the model is most likely
 * to reach for generic fantasy words rather than the threshold-concept register.
 */
function getHighTierExamples(tier) {
  if (tier < 7) return "";
  return `
Examples of good names at this tier:
- T7: "The Formless", "Negation", "Stillpoint", "Unbecoming", "The Hollow"
- T8: "Pure Absence", "The Threshold", "Unnamed Potential", "The Unborn"
- T9: "Creation" (Yang/Heaven) or "Oblivion" (Yin/Earth) — no other names are valid at T9

Bad examples (too concrete or too generic-fantasy): "Shadow Flame", "Void Dragon", "Eternal Storm", "Dark Force"
`;
}

function buildForgePrompt(daoA, daoB, tier, affinityA, affinityB, proposalCount = 1) {
  const theme = getTierTheme(tier);
  const highTierExamples = getHighTierExamples(tier);
  const multiProposal = Number(proposalCount) > 1;
  const outputShape = multiProposal
    ? `Return strict JSON only with this shape:
{
  "proposals": [
    { "name": "...", "tier": ${tier}, "description": "...", "affinity": "...", "harmonyClass": "...", "isUnstable": false, "decayRate": 0 }
  ]
}
Return exactly ${proposalCount} proposals.`
    : "Return strict JSON only with keys: name, tier, description, affinity, harmonyClass, isUnstable, decayRate";

  const affinityContext = (affinityA && affinityB)
    ? `\n- Parent affinities: ${affinityA} and ${affinityB}. Bias the output affinity toward the dominant parent affinity. If both parents share the same affinity, inherit it directly.`
    : "";

  return `You are generating a Dao name for a cultivation game where Daos evolve from the concrete to the absolute.
${outputShape}

The naming arc across tiers moves from concrete elements toward absolute concepts:
- Low tiers (1-3): concrete elements and natural forces (Fire, Stone, Tide)
- Mid tiers (4-6): abstract principles and metaphysical tensions (Entropy, Dissolution)
- High tiers (7-8): near-absolute, nameless, threshold concepts (The Formless, Pure Absence)
- Tier 9: only "Creation" (Yang) or "Oblivion" (Yin) — the two absolute poles${highTierExamples}
Input:
- daoA: ${daoA}
- daoB: ${daoB}
- target tier: ${tier}
- thematic register for tier ${tier}: ${theme}${affinityContext}

Rules:
- tier must equal ${tier}
- name must feel like a natural conceptual evolution *beyond* both parents, fitting the thematic register above
- name is ideally 1-2 words, max 60 chars — do not include the word "Dao"
- description narrates HOW the two parent concepts dissolved into this new one (max 160 chars)
- affinity: Yin, Yang, Neutral, or Paradox${affinityContext ? " — bias toward dominant parent" : ""}
- harmonyClass: Heaven, Earth, or Human
- isUnstable: true only when affinity is Paradox
- decayRate: 0 unless unstable; unstable range 30000–180000
${multiProposal ? `- Each proposal must be meaningfully different in wording and conceptual angle.
- Avoid near-duplicates; do not return the same name twice.` : ""}`;
}

function parseModelJson(content) {
  let str = String(content || "").trim();
  str = str.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(str);
  } catch {
    const firstBrace = str.indexOf("{");
    const lastBrace = str.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(str.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Could not parse model JSON");
  }
}

async function callForgeModel(daoA, daoB, tier, affinityA, affinityB) {
  const completion = await openai.chat.completions.create({
    model: OPENROUTER_MODEL,
    temperature: 0.3,
    max_tokens: 220,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: buildForgePrompt(daoA, daoB, tier, affinityA, affinityB) }]
  });
  const content = completion?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty model response");
  const parsed = parseModelJson(content);

  return normalizeForgeResult(parsed, daoA, daoB, tier);
}

async function callForgeModelProposals(daoA, daoB, tier, affinityA, affinityB, proposalCount = 3) {
  const completion = await openai.chat.completions.create({
    model: OPENROUTER_MODEL,
    temperature: 0.6,
    max_tokens: 600,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: buildForgePrompt(daoA, daoB, tier, affinityA, affinityB, proposalCount) }]
  });
  const content = completion?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty model response");
  const parsed = parseModelJson(content);
  const rawProposals = Array.isArray(parsed?.proposals) ? parsed.proposals : [];
  const limited = rawProposals.slice(0, proposalCount);
  const normalized = limited.map((raw) => normalizeForgeResult(raw, daoA, daoB, tier));
  if (!normalized.length) throw new Error("No proposals returned");
  while (normalized.length < proposalCount) {
    normalized.push(normalized[normalized.length - 1]);
  }
  return normalized;
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

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function getBearerToken(req) {
  const authHeader = String(req.get("authorization") || "");
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
}

function requireSessionScope(requiredScope) {
  return (req, res, next) => {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const payload = jwt.verify(token, SERVER_AUTH_TOKEN, { issuer: SESSION_ISSUER });
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post("/api/session", sessionLimiter, async (req, res) => {
  const ipHash = hashIp(getClientIp(req));
  const ttl = Number(SESSION_TTL_SECONDS);
  const token = jwt.sign(
    { ip_hash: ipHash, scopes: ["forge:generate", "forge:hint", "forge:vote", "masters:quests"] },
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

// Cache lookup (no auth required — public read).
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

// Generation endpoint (session auth required).
app.post("/api/forge/generate", generateLimiter, requireSessionScope("forge:generate"), async (req, res) => {
  const parsed = forgeInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid forge payload" });
  }

  const { daoA, daoB, tier, affinityA, affinityB } = parsed.data;
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
    // Pass parent affinities so the prompt can bias toward the dominant lineage.
    let generated = await callForgeModel(daoA, daoB, tier, affinityA, affinityB);
    const firstExistingByName = await pool.query(
      `SELECT result_json
         FROM forge_results
        WHERE tier = $1
          AND result_json->>'name' = $2
        ORDER BY pair_key ASC
        LIMIT 1`,
      [tier, generated.name]
    );
    if (firstExistingByName.rowCount > 0) {
      generated = unifyDaoIdentityFromExisting(firstExistingByName.rows[0].result_json, generated);
      console.log(`[forge] unified duplicate dao identity name="${generated.name}" tier=${tier} from first existing entry`);
    }
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

// Supportive mode: generate multiple candidate outcomes for one new pair.
app.post("/api/forge/supportive-options", generateLimiter, requireSessionScope("forge:generate"), async (req, res) => {
  const parsed = forgeInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid forge payload" });
  }
  const { daoA, daoB, tier, affinityA, affinityB } = parsed.data;
  const key = pairKey(daoA, daoB, tier);
  try {
    const cached = await pool.query(
      "SELECT result_json FROM forge_results WHERE pair_key = $1",
      [key]
    );
    if (cached.rowCount > 0) {
      return res.json({ source: "cache", result: cached.rows[0].result_json });
    }

    const optionsRaw = await callForgeModelProposals(daoA, daoB, tier, affinityA, affinityB, 3);
    const options = [];
    for (let i = 0; i < optionsRaw.length; i += 1) {
      let candidate = optionsRaw[i];
      const firstExistingByName = await pool.query(
        `SELECT result_json
           FROM forge_results
          WHERE tier = $1
            AND result_json->>'name' = $2
          ORDER BY pair_key ASC
          LIMIT 1`,
        [tier, candidate.name]
      );
      if (firstExistingByName.rowCount > 0) {
        candidate = unifyDaoIdentityFromExisting(firstExistingByName.rows[0].result_json, candidate);
      }
      options.push(candidate);
    }

    const draftId = crypto.randomUUID();
    const ipHash = hashIp(getClientIp(req));
    for (let i = 0; i < options.length; i += 1) {
      await pool.query(
        `INSERT INTO forge_alternative_results
          (draft_id, pair_key, dao_a, dao_b, tier, option_index, result_json, selected, generated_by_ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, false, $8)`,
        [draftId, key, normalizeName(daoA), normalizeName(daoB), tier, i, JSON.stringify(options[i]), ipHash]
      );
    }
    return res.json({ source: "generated", draftId, pairKey: key, options });
  } catch (err) {
    console.error("supportive option generation failed:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail
    });
    return res.status(502).json({ error: "Supportive option generation failed" });
  }
});

app.post("/api/forge/supportive-select", generateLimiter, requireSessionScope("forge:generate"), async (req, res) => {
  const parsed = supportiveSelectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid supportive selection payload" });
  }
  const { draftId, selectedOptionIndex } = parsed.data;
  try {
    const draftRows = await pool.query(
      `SELECT pair_key, dao_a, dao_b, tier, option_index, result_json
         FROM forge_alternative_results
        WHERE draft_id = $1
        ORDER BY option_index ASC`,
      [draftId]
    );
    if (draftRows.rowCount === 0) return res.status(404).json({ error: "DraftNotFound" });
    const picked = draftRows.rows.find((r) => Number(r.option_index) === selectedOptionIndex);
    if (!picked) return res.status(400).json({ error: "InvalidSelectionIndex" });

    const existing = await pool.query(
      "SELECT result_json FROM forge_results WHERE pair_key = $1",
      [picked.pair_key]
    );
    if (existing.rowCount === 0) {
      const ipHash = hashIp(getClientIp(req));
      await pool.query(
        `INSERT INTO forge_results
          (pair_key, dao_a, dao_b, tier, result_json, generated_by_ip_hash)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (pair_key) DO NOTHING`,
        [picked.pair_key, picked.dao_a, picked.dao_b, picked.tier, JSON.stringify(picked.result_json), ipHash]
      );
    }
    await pool.query(
      `UPDATE forge_alternative_results
          SET selected = (option_index = $2)
        WHERE draft_id = $1`,
      [draftId, selectedOptionIndex]
    );
    const inserted = await pool.query(
      "SELECT result_json FROM forge_results WHERE pair_key = $1",
      [picked.pair_key]
    );
    return res.json({ result: inserted.rows[0]?.result_json || picked.result_json });
  } catch (err) {
    console.error("supportive selection failed:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail
    });
    return res.status(502).json({ error: "Supportive selection failed" });
  }
});

app.post("/api/dao/vote", generateLimiter, requireSessionScope("forge:vote"), async (req, res) => {
  const parsed = daoVoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid vote payload" });
  }
  const { daoName, tier, vote, pairKey, sourceMode } = parsed.data;
  try {
    const ipHash = hashIp(getClientIp(req));
    await pool.query(
      `INSERT INTO forge_name_votes
        (dao_name, tier, vote_value, pair_key, source_mode, voted_by_ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [normalizeName(daoName), tier, vote === "up" ? 1 : -1, pairKey || null, sourceMode || null, ipHash]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("vote submission failed:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail
    });
    return res.status(502).json({ error: "Vote submission failed" });
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

app.post("/api/masters/sync", readLimiter, requireSessionScope("masters:quests"), async (req, res) => {
  const parsed = mastersProgressSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid masters progress payload" });
  }
  const ipHash = hashIp(getClientIp(req));
  const metrics = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const quest of MASTER_QUESTS) {
      const progress = Number.parseInt(String(getQuestProgressValue(quest, metrics)), 10) || 0;
      const target = Number.parseInt(String(quest.target), 10) || 0;
      await client.query(
        `INSERT INTO masters_quest_progress
          (ip_hash, quest_id, progress_value, completed_at, last_seen_at)
         VALUES ($1, $2, $3::int, NULL, NOW())
         ON CONFLICT (ip_hash, quest_id) DO UPDATE
           SET progress_value = GREATEST(masters_quest_progress.progress_value, EXCLUDED.progress_value),
               completed_at = CASE
                 WHEN masters_quest_progress.completed_at IS NOT NULL THEN masters_quest_progress.completed_at
                 WHEN GREATEST(masters_quest_progress.progress_value, EXCLUDED.progress_value) >= $4::int THEN NOW()
                 ELSE NULL
               END,
               last_seen_at = NOW()`,
        [ipHash, quest.id, progress, target]
      );
    }
    const rows = await client.query(
      `SELECT quest_id, progress_value, completed_at, claimed_at
         FROM masters_quest_progress
        WHERE ip_hash = $1`,
      [ipHash]
    );
    await client.query("COMMIT");
    const rowById = new Map(rows.rows.map((r) => [r.quest_id, r]));
    const quests = MASTER_QUESTS.map((quest) => {
      const row = rowById.get(quest.id);
      const progress = Number(row?.progress_value || 0);
      return {
        id: quest.id,
        title: quest.title,
        description: quest.description,
        rewardLabel: quest.rewardLabel,
        progress,
        target: quest.target,
        completed: progress >= quest.target,
        completedAt: row?.completed_at || null,
        claimedAt: row?.claimed_at || null
      };
    });
    return res.json({ quests, syncedAt: Date.now() });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("masters sync failed:", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail
    });
    return res.status(500).json({ error: "Masters sync failed" });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error("unhandled server error:", {
    message: err?.message,
    code: err?.code,
    stack: err?.stack
  });
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: "Internal server error" });
});

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_alternative_results (
      id BIGSERIAL PRIMARY KEY,
      draft_id TEXT NOT NULL,
      pair_key TEXT NOT NULL,
      dao_a TEXT NOT NULL,
      dao_b TEXT NOT NULL,
      tier INTEGER NOT NULL,
      option_index INTEGER NOT NULL,
      result_json JSONB NOT NULL,
      selected BOOLEAN NOT NULL DEFAULT false,
      generated_by_ip_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_forge_alternative_results_draft_id ON forge_alternative_results(draft_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_forge_alternative_results_pair_key ON forge_alternative_results(pair_key)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_name_votes (
      id BIGSERIAL PRIMARY KEY,
      dao_name TEXT NOT NULL,
      tier INTEGER NOT NULL,
      vote_value SMALLINT NOT NULL CHECK (vote_value IN (-1, 1)),
      pair_key TEXT,
      source_mode TEXT,
      voted_by_ip_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_forge_name_votes_dao_name_tier ON forge_name_votes(dao_name, tier)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_forge_name_votes_created_at ON forge_name_votes(created_at DESC)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS masters_quest_progress (
      ip_hash TEXT NOT NULL,
      quest_id TEXT NOT NULL,
      progress_value INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (ip_hash, quest_id)
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_masters_quest_progress_ip_hash ON masters_quest_progress(ip_hash)");
}

async function start() {
  console.log("[startup] configuration", {
    port: Number(PORT),
    model: OPENROUTER_MODEL,
    allowedOrigins: parsedAllowedOrigins,
    allowNullOrigin: ALLOW_NULL_ORIGIN === "true"
  });
  await ensureTables();
  app.listen(Number(PORT), () => {
    console.log(`Forge backend listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("backend start failed:", {
    message: err?.message,
    code: err?.code,
    detail: err?.detail
  });
  process.exit(1);
});