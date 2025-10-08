// server.js
// Simple image-search proxy using Wikimedia Commons as the source.
// npm deps: express node-fetch dotenv helmet cors express-rate-limit
// Usage: set PORT and ALLOWED_ORIGINS in .env if desired. No API key required.

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmet());
app.use(express.json());

// CORS config (allow list or all)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  }
};
app.use(cors(corsOptions));

// Basic rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || "30"),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Simple keyword blacklist for "Strict" safe mode (you can expand)
const BLACKLIST = [
  "porn", "nsfw", "nude", "sex", "erotic", "explicit", "scantily", "topless", "bdsm"
];

// Helper: checks title or description against blacklist (case-insensitive)
function passesSafeFilter(item, mode = "Strict") {
  if (!item) return false;
  if (mode !== "Strict") return true; // Strict only filters; Moderate/Off allow through
  const text = (item.title || "") + " " + (item.description || "");
  const lower = text.toLowerCase();
  for (const bad of BLACKLIST) {
    if (lower.includes(bad)) return false;
  }
  return true;
}

// Query Wikimedia Commons for images using MediaWiki API
// We'll use generator=search to find pages and then prop=imageinfo to get urls.
async function searchWikimedia(query, page = 1, per_page = 24) {
  const sroffset = Math.max(0, (page - 1) * per_page);
  // Use generator=search to get pages matching query within commons
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: query,
    gsrlimit: String(per_page),
    gsroffset: String(sroffset),
    prop: "imageinfo|pageimages|info",
    iiprop: "url|mime|size|extmetadata",
    piprop: "thumbnail",
    pithumbsize: "640",
    inprop: "url",
    origin: "*" // CORS
  });

  const url = `https://commons.wikimedia.org/w/api.php?${params.toString()}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" }});
  if (!res.ok) throw new Error(`Wikimedia API error ${res.status}`);
  const json = await res.json();
  // pages come back keyed by pageid
  const pages = json.query?.pages || {};
  const results = Object.values(pages).map(p => {
    // imageinfo may be present if page is an image file page
    const ii = Array.isArray(p.imageinfo) ? p.imageinfo[0] : null;
    const thumbnail = p.thumbnail?.source || (ii ? ii.thumburl : null) || null;
    const contentUrl = ii?.url || null;
    const desc = ii?.extmetadata?.ImageDescription?.value || p.extract || "";
    return {
      id: p.pageid,
      title: p.title,
      thumbnail,
      contentUrl,
      hostPage: p.fullurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      width: ii?.width || null,
      height: ii?.height || null,
      description: typeof desc === "string" ? desc.replace(/<[^>]+>/g,'').trim() : ""
    };
  });

  // Wikimedia doesn't return totalEstimatedMatches easily; approximate with length
  return {
    query,
    results
  };
}

// API endpoint: /api/search?q=...&safe=Strict|Moderate|Off&page=1&per_page=24
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q parameter" });

    const safe = (req.query.safe || "Strict");
    const page = Math.max(1, parseInt(req.query.page || "1"));
    const per_page = Math.min(48, Math.max(8, parseInt(req.query.per_page || "24")));

    // search
    const data = await searchWikimedia(q, page, per_page);

    // apply safe filter if Strict
    const filtered = data.results.filter(item => {
      if (!item.thumbnail && !item.contentUrl) return false; // skip non-image results
      return passesSafeFilter(item, safe);
    });

    res.json({
      query: data.query,
      page,
      per_page,
      count: filtered.length,
      results: filtered
    });
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public/index.html")));

const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, () => console.log(`Wikimedia proxy server running on port ${PORT}`));
