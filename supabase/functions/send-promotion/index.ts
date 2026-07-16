// Supabase Edge Function: send-promotion
// ---------------------------------------
// Emails the people who saved a business's cards when the business pushes a
// promotion from the dashboard. Called by dashPushPromotion() in index.html via
// db.functions.invoke('send-promotion', { body: { audience, promo } }).
//
// Why this runs server-side: resolving a saver's email address requires the
// Supabase service-role key (auth admin). That key must NEVER live in the
// browser, so audience resolution + sending happens here.
//
// Audience:
//   - 'all' | 'savers' : email every distinct user who saved one of the
//                        caller's cards (to their tapestry).
//   - 'scanned'        : no-op here (scanners are anonymous; the client already
//                        refreshed the on-card promo). Returns { sent: 0 }.
//
// Deploy + secrets: see ./README.md
//
// Required secrets (supabase secrets set ...):
//   RESEND_API_KEY   – your Resend API key
//   RESEND_FROM      – verified sender, e.g. "Duyên <promos@yourdomain.com>"
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Escape untrusted text before dropping it into the HTML email body.
function esc(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const RESEND_FROM = Deno.env.get("RESEND_FROM");

  if (!RESEND_API_KEY || !RESEND_FROM) {
    return json(
      { error: "Email not configured. Set RESEND_API_KEY and RESEND_FROM secrets." },
      501,
    );
  }

  // ---- Identify the calling business from their JWT ----
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "Missing Authorization bearer token" }, 401);
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Not authenticated" }, 401);
  }
  const businessUserId = userData.user.id;

  // ---- Parse input ----
  let payload: { audience?: string; promo?: { text?: string; photos?: string[] } };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const audience = payload.audience || "all";
  const promo = payload.promo || {};
  const promoText = (promo.text || "").toString();
  const promoPhotos = Array.isArray(promo.photos) ? promo.photos.slice(0, 5) : [];

  if (audience === "scanned") {
    // Scanners are anonymous — nothing to email. The client handles the on-card promo.
    return json({ sent: 0, skipped: 0, note: "Scanners are anonymous; no email sent." });
  }
  if (!promoText.trim() && promoPhotos.length === 0) {
    return json({ error: "Promotion is empty" }, 400);
  }

  // ---- Admin client (service role) for audience resolution ----
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1) This business's cards
  const { data: codes, error: codesErr } = await admin
    .from("qr_codes")
    .select("id, business_data")
    .eq("business_user_id", businessUserId);
  if (codesErr) return json({ error: "Failed to load cards: " + codesErr.message }, 500);
  const cardIds = (codes || []).map((c: { id: string }) => c.id);
  if (cardIds.length === 0) return json({ sent: 0, skipped: 0, note: "No cards." });

  // Business display name (for the email subject/from label)
  let businessName = "";
  for (const c of codes || []) {
    let bd = (c as { business_data?: unknown }).business_data;
    if (typeof bd === "string") { try { bd = JSON.parse(bd); } catch { bd = null; } }
    if (bd && typeof bd === "object" && (bd as { name?: string }).name) {
      businessName = (bd as { name: string }).name;
      break;
    }
  }

  // 2) Distinct savers of those cards (exclude the business owner themselves)
  const { data: taps, error: tapErr } = await admin
    .from("tapestry")
    .select("user_id")
    .in("qr_code_id", cardIds);
  if (tapErr) return json({ error: "Failed to load savers: " + tapErr.message }, 500);
  const saverIds = Array.from(
    new Set(
      (taps || [])
        .map((t: { user_id: string }) => t.user_id)
        .filter((id: string) => id && id !== businessUserId),
    ),
  );
  if (saverIds.length === 0) return json({ sent: 0, skipped: 0, note: "No savers yet." });

  // 3) Resolve emails (service role). getUserById in bounded-concurrency chunks.
  const emails: string[] = [];
  for (const group of chunk(saverIds, 20)) {
    const results = await Promise.all(
      group.map((id) => admin.auth.admin.getUserById(id).catch(() => null)),
    );
    for (const r of results) {
      const em = r?.data?.user?.email;
      if (em) emails.push(em);
    }
  }
  const recipients = Array.from(new Set(emails));
  if (recipients.length === 0) return json({ sent: 0, skipped: saverIds.length });

  // ---- Compose email ----
  const fromLabel = businessName
    ? `${businessName} via Duyên <${RESEND_FROM.replace(/^.*<|>.*$/g, "")}>`
    : RESEND_FROM;
  const subject = businessName ? `${businessName} has a new promotion` : "A new promotion for you";
  const photoHtml = promoPhotos
    .map(
      (u) =>
        `<img src="${esc(u)}" alt="" style="max-width:100%;border-radius:10px;margin-top:12px;display:block;">`,
    )
    .join("");
  const html = `
    <div style="font-family:Georgia,'Times New Roman',serif;max-width:520px;margin:0 auto;color:#2E2A28;">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8B3A7F;margin-bottom:10px;">
        ${businessName ? esc(businessName) : "A card you saved"}
      </div>
      <div style="font-size:17px;line-height:1.6;white-space:pre-wrap;">${esc(promoText)}</div>
      ${photoHtml}
      <hr style="border:none;border-top:1px solid #eee;margin:22px 0;">
      <div style="font-size:11px;color:#9A8478;line-height:1.5;">
        You’re receiving this because you saved this business’s card to your tapestry on Duyên.
        To stop these emails, reply with “unsubscribe”.
      </div>
    </div>`;

  // ---- Send via Resend (batch endpoint, ≤100 per call) ----
  let sent = 0;
  const failed: string[] = [];
  for (const batch of chunk(recipients, 100)) {
    const body = batch.map((to) => ({
      from: fromLabel,
      to,
      subject,
      html,
    }));
    const resp = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (resp.ok) {
      sent += batch.length;
    } else {
      const errText = await resp.text().catch(() => "");
      console.error("Resend batch failed:", resp.status, errText);
      for (const to of batch) failed.push(to);
    }
  }

  return json({
    sent,
    skipped: recipients.length - sent,
    recipients: recipients.length,
    failed: failed.length,
  });
});
