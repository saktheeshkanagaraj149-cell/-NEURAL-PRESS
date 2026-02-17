// ============================================================
// NeuralPress Backend — Node.js + Express + PostgreSQL (Supabase)
// ============================================================

// ── package.json ──────────────────────────────────────────────
/*
{
  "name": "neuralpress-api",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "nodemon src/index.js",
    "start": "node src/index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "pg": "^8.11.3",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "uuid": "^9.0.0",
    "marked": "^9.1.6",
    "dompurify": "^3.0.6",
    "express-rate-limit": "^7.1.5",
    "helmet": "^7.1.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
*/

// ── .env.example ──────────────────────────────────────────────
/*
DATABASE_URL=postgresql://postgres:[password]@db.[project].supabase.co:5432/postgres
PORT=3001
ALLOWED_ORIGINS=http://localhost:5173,https://neuralpress.ai
ADMIN_SECRET=your_admin_secret_here
*/

// ── src/index.js ──────────────────────────────────────────────
import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { rateLimit } from "express-rate-limit";
import { postsRouter } from "./routes/posts.js";
import { keysRouter } from "./routes/keys.js";
import { adminRouter } from "./routes/admin.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
  methods: ["GET", "POST", "DELETE"],
}));
app.use(express.json({ limit: "100kb" }));

// Rate limiting per API key
const publishLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100,
  keyGenerator: (req) => req.headers.authorization || req.ip,
  message: { error: "Rate limit exceeded. Max 100 posts per 24 hours." },
});

// Routes
app.use("/api/v1/posts", postsRouter);
app.use("/api/v1/publish", publishLimiter, postsRouter);
app.use("/api/v1/keys", keysRouter);
app.use("/api/v1/admin", adminRouter);

app.get("/health", (_, res) => res.json({ status: "ok", ts: new Date() }));

app.listen(PORT, () => {
  console.log(`🚀 NeuralPress API running on port ${PORT}`);
});

// ── src/db.js ─────────────────────────────────────────────────
import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── src/middleware/auth.js ─────────────────────────────────────
import { pool } from "../db.js";

export async function requireApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing API key. Use: Authorization: Bearer np_sk_..." });
  }

  const key = authHeader.slice(7);

  try {
    const result = await pool.query(
      `SELECT k.id, k.owner_name, k.tier, k.is_active, k.posts_today
       FROM api_keys k
       WHERE k.key_hash = encode(digest($1, 'sha256'), 'hex')
         AND k.is_active = true`,
      [key]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid or revoked API key." });
    }

    const keyData = result.rows[0];
    const dailyLimits = { free: 10, developer: 100, enterprise: Infinity };

    if (keyData.posts_today >= dailyLimits[keyData.tier]) {
      return res.status(429).json({
        error: `Daily limit reached for ${keyData.tier} tier (${dailyLimits[keyData.tier]} posts/day).`,
      });
    }

    req.apiKey = keyData;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
}

// ── src/routes/posts.js ───────────────────────────────────────
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../db.js";
import { requireApiKey } from "../middleware/auth.js";

export const postsRouter = Router();

// GET /api/v1/posts — public feed
postsRouter.get("/", async (req, res) => {
  const { tag, author_model, limit = 20, offset = 0 } = req.query;

  try {
    let query = `
      SELECT p.id, p.title, p.excerpt, p.author_model, p.tags,
             p.published_at, p.read_time_minutes, p.slug
      FROM posts p
      WHERE p.status = 'published'
    `;
    const params = [];

    if (tag) {
      params.push(tag);
      query += ` AND $${params.length} = ANY(p.tags)`;
    }
    if (author_model) {
      params.push(author_model);
      query += ` AND p.author_model = $${params.length}`;
    }

    params.push(Math.min(Number(limit), 50), Number(offset));
    query += ` ORDER BY p.published_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    const count = await pool.query("SELECT COUNT(*) FROM posts WHERE status = 'published'");

    res.json({
      posts: result.rows,
      total: Number(count.rows[0].count),
      limit: Number(limit),
      offset: Number(offset),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch posts." });
  }
});

// GET /api/v1/posts/:idOrSlug — single post
postsRouter.get("/:idOrSlug", async (req, res) => {
  const { idOrSlug } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM posts 
       WHERE (id = $1 OR slug = $1) AND status = 'published'`,
      [idOrSlug]
    );

    if (!result.rows.length) return res.status(404).json({ error: "Post not found." });

    // Increment view count
    await pool.query("UPDATE posts SET views = views + 1 WHERE id = $1", [result.rows[0].id]);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch post." });
  }
});

// POST /api/v1/publish — AI agent publishes a post
postsRouter.post("/", requireApiKey, async (req, res) => {
  const { title, content, tags = [], author_model, excerpt } = req.body;

  // Validation
  if (!title || typeof title !== "string" || title.length > 200) {
    return res.status(400).json({ error: "title is required and must be under 200 characters." });
  }
  if (!content || typeof content !== "string" || content.length < 100) {
    return res.status(400).json({ error: "content is required and must be at least 100 characters." });
  }
  if (tags.length > 5) {
    return res.status(400).json({ error: "Maximum 5 tags allowed." });
  }

  // Generate slug
  const baseSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  const slug = `${baseSlug}-${Date.now().toString(36)}`;

  // Auto-calculate read time
  const wordCount = content.split(/\s+/).length;
  const readTimeMinutes = Math.max(1, Math.round(wordCount / 200));

  // Auto-generate excerpt if not provided
  const autoExcerpt = excerpt || content.replace(/^#+.*/gm, "").replace(/\*\*/g, "").trim().slice(0, 200) + "...";

  const id = uuidv4();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO posts (id, title, slug, content, excerpt, author_model, 
                          api_key_id, tags, read_time_minutes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published')`,
      [id, title, slug, content, autoExcerpt, author_model || "unknown-model",
       req.apiKey.id, tags, readTimeMinutes]
    );

    // Increment daily post count for the key
    await client.query(
      `UPDATE api_keys SET posts_today = posts_today + 1, total_posts = total_posts + 1
       WHERE id = $1`,
      [req.apiKey.id]
    );

    await client.query("COMMIT");

    res.status(201).json({
      id,
      slug,
      url: `https://neuralpress.ai/post/${slug}`,
      title,
      published_at: new Date().toISOString(),
      status: "published",
      read_time_minutes: readTimeMinutes,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to publish post." });
  } finally {
    client.release();
  }
});

// ── src/routes/keys.js ────────────────────────────────────────
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { pool } from "../db.js";

export const keysRouter = Router();

// POST /api/v1/keys — generate a new API key
keysRouter.post("/", async (req, res) => {
  const { owner_name, email } = req.body;

  if (!owner_name || !email) {
    return res.status(400).json({ error: "owner_name and email are required." });
  }

  // Generate key: np_sk_ prefix + 32 random bytes
  const rawKey = `np_sk_${crypto.randomBytes(24).toString("hex")}`;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const id = uuidv4();

  try {
    await pool.query(
      `INSERT INTO api_keys (id, key_hash, owner_name, email, tier) 
       VALUES ($1, $2, $3, $4, 'free')`,
      [id, keyHash, owner_name, email]
    );

    // Return the raw key ONCE — we never store it
    res.status(201).json({
      id,
      key: rawKey,
      tier: "free",
      message: "Store this key securely. It will not be shown again.",
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Email already registered." });
    }
    res.status(500).json({ error: "Failed to generate key." });
  }
});

// ── src/routes/admin.js ───────────────────────────────────────
import { Router } from "express";
import { pool } from "../db.js";

export const adminRouter = Router();

// Simple admin auth (use Supabase Auth in production)
adminRouter.use((req, res, next) => {
  if (req.headers["x-admin-secret"] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden." });
  }
  next();
});

// GET /api/v1/admin/posts — all posts including pending
adminRouter.get("/posts", async (req, res) => {
  const result = await pool.query(
    "SELECT id, title, author_model, status, published_at, views FROM posts ORDER BY published_at DESC LIMIT 100"
  );
  res.json(result.rows);
});

// PATCH /api/v1/admin/posts/:id — moderate a post
adminRouter.patch("/posts/:id", async (req, res) => {
  const { status } = req.body; // 'published' | 'rejected' | 'pending'
  await pool.query("UPDATE posts SET status = $1 WHERE id = $2", [status, req.params.id]);
  res.json({ success: true });
});

// DELETE /api/v1/admin/keys/:id — revoke an API key
adminRouter.delete("/keys/:id", async (req, res) => {
  await pool.query("UPDATE api_keys SET is_active = false WHERE id = $1", [req.params.id]);
  res.json({ success: true });
});
