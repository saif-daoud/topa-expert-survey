export type Env = {
  DB: D1Database; // <-- D1 binding name in wrangler.toml
  TOKEN_SECRET: string;
  ALLOWED_ORIGINS: string; // comma-separated origins like https://USER.github.io
};

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
  };
}

function originAllowed(env: Env, origin: string) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return origin && allowed.includes(origin);
}

function base64UrlEncode(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeString(str: string) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

async function sha256Hex(s: string) {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- simple HMAC token (for survey session) ----
async function hmacSign(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

function b64Json(obj: any) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function fromB64Json(s: string) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function makeToken(env: Env, payload: any) {
  const body = b64Json(payload);
  const sig = await hmacSign(env.TOKEN_SECRET, body);
  return `${body}.${sig}`;
}

async function verifyToken(env: Env, token: string) {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("Bad token format");
  const expected = await hmacSign(env.TOKEN_SECRET, body);
  if (expected !== sig) throw new Error("Bad token signature");
  const payload = fromB64Json(body);
  if (payload.exp && Date.now() > payload.exp) throw new Error("Token expired");
  return payload;
}

// ---- D1 helpers ----
type AccessCodeRow = {
  code_hash: string;
  active: number; // 0/1
  uses_remaining: number | null;
  expires_at: string | null;
};

async function dbGetAccessCode(env: Env, codeHash: string): Promise<AccessCodeRow | null> {
  const row = await env.DB
    .prepare("SELECT code_hash, active, uses_remaining, expires_at FROM access_codes WHERE code_hash = ?")
    .bind(codeHash)
    .first<AccessCodeRow>();

  return row ?? null;
}

async function dbDecrementUsesRemaining(env: Env, codeHash: string): Promise<void> {
  // Only decrement if uses_remaining is not NULL and > 0
  await env.DB
    .prepare(
      "UPDATE access_codes SET uses_remaining = uses_remaining - 1 WHERE code_hash = ? AND uses_remaining IS NOT NULL AND uses_remaining > 0"
    )
    .bind(codeHash)
    .run();
}

type VoteRow = {
  id: string;
  participant_id: string;
  component: string;
  trial_id: number;
  left_method_id: string;
  right_method_id: string;
  preferred: string; // we will store normalized "left" | "right"
  timestamp_utc: string;
  user_agent?: string;
  page_url?: string;
  received_at: string;
};

function normalizePreferred(p: string): "left" | "right" {
  const v = (p || "").toLowerCase().trim();
  // accept older naming too
  if (v === "left" || v === "top") return "left";
  if (v === "right" || v === "bottom") return "right";
  // fallback: keep it strict to avoid DB CHECK failures
  throw new Error("preferred must be one of: left/right (or top/bottom)");
}

async function dbUpsertVote(env: Env, row: VoteRow): Promise<void> {
  // Upsert using SQLite ON CONFLICT
  await env.DB
    .prepare(`
      INSERT INTO votes (
        id, participant_id, component, trial_id,
        left_method_id, right_method_id, preferred, timestamp_utc,
        user_agent, page_url, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        participant_id=excluded.participant_id,
        component=excluded.component,
        trial_id=excluded.trial_id,
        left_method_id=excluded.left_method_id,
        right_method_id=excluded.right_method_id,
        preferred=excluded.preferred,
        timestamp_utc=excluded.timestamp_utc,
        user_agent=excluded.user_agent,
        page_url=excluded.page_url,
        received_at=excluded.received_at
    `)
    .bind(
      row.id,
      row.participant_id,
      row.component,
      row.trial_id,
      row.left_method_id,
      row.right_method_id,
      row.preferred,
      row.timestamp_utc,
      row.user_agent ?? "",
      row.page_url ?? "",
      row.received_at
    )
    .run();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("Origin") || "";

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: originAllowed(env, origin) ? cors(origin) : {},
      });
    }

    if (!originAllowed(env, origin)) {
      return new Response(JSON.stringify({ error: "Origin not allowed" }), {
        status: 403,
        headers: cors(origin),
      });
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: cors(origin),
      });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    // POST /api/start
    if (path.endsWith("/api/start")) {
      const body = await req.json().catch(() => ({}));
      const code = String(body.code || "").trim();
      if (!code) {
        return new Response(JSON.stringify({ error: "Missing code" }), { status: 400, headers: cors(origin) });
      }

      const codeHash = await sha256Hex(code);

      const doc = await dbGetAccessCode(env, codeHash);
      if (!doc) {
        return new Response(JSON.stringify({ error: "Invalid code" }), { status: 403, headers: cors(origin) });
      }

      const active = doc.active === 1;
      if (!active) {
        return new Response(JSON.stringify({ error: "Code inactive" }), { status: 403, headers: cors(origin) });
      }

      if (doc.uses_remaining !== null && doc.uses_remaining <= 0) {
        return new Response(JSON.stringify({ error: "Code has no remaining uses" }), {
          status: 403,
          headers: cors(origin),
        });
      }

      if (doc.expires_at) {
        const expMs = Date.parse(doc.expires_at);
        if (!Number.isFinite(expMs)) {
          return new Response(JSON.stringify({ error: "Bad expires_at format in DB" }), {
            status: 500,
            headers: cors(origin),
          });
        }
        if (Date.now() > expMs) {
          return new Response(JSON.stringify({ error: "Code expired" }), { status: 403, headers: cors(origin) });
        }
      }

      // decrement uses_remaining if present
      if (doc.uses_remaining !== null) {
        await dbDecrementUsesRemaining(env, codeHash);
      }

      const token = await makeToken(env, { codeHash, exp: Date.now() + 12 * 60 * 60 * 1000 });
      return new Response(JSON.stringify({ ok: true, token }), { status: 200, headers: cors(origin) });
    }

    // POST /api/vote
    if (path.endsWith("/api/vote")) {
      const body = await req.json().catch(() => ({}));
      const token = String(body.token || "");
      const vote = body.vote;

      if (!token || !vote) {
        return new Response(JSON.stringify({ error: "Missing token or vote" }), { status: 400, headers: cors(origin) });
      }

      try {
        await verifyToken(env, token);
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message || "Invalid token" }), { status: 403, headers: cors(origin) });
      }

      const required = ["participant_id", "component", "trial_id", "left_method_id", "right_method_id", "preferred", "timestamp_utc"];
      for (const k of required) {
        if (vote[k] === undefined || vote[k] === null || vote[k] === "") {
          return new Response(JSON.stringify({ error: `Missing field: ${k}` }), { status: 400, headers: cors(origin) });
        }
      }

      let preferred: "left" | "right";
      try {
        preferred = normalizePreferred(String(vote.preferred));
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: cors(origin) });
      }

      const participant = String(vote.participant_id);
      const component = String(vote.component);
      const trial = Number(vote.trial_id);

      const docId = `${participant}__${component}__${trial}`; // safe primary key

      const row: VoteRow = {
        id: docId,
        participant_id: participant,
        component,
        trial_id: trial,
        left_method_id: String(vote.left_method_id),
        right_method_id: String(vote.right_method_id),
        preferred,
        timestamp_utc: String(vote.timestamp_utc),
        user_agent: String(vote.user_agent || ""),
        page_url: String(vote.page_url || ""),
        received_at: new Date().toISOString(),
      };

      await dbUpsertVote(env, row);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors(origin) });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors(origin) });
  },
};
