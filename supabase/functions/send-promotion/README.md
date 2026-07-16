# send-promotion — email promotion blasts to savers

When a business pushes a promotion from the dashboard with the audience set to
**Everyone** or **Savers**, the portal calls this Edge Function. It resolves the
email addresses of everyone who saved one of that business's cards (server-side,
using the service-role key) and sends them the promotion via [Resend](https://resend.com).

The **Scanners** audience does *not* email anyone — scans are anonymous, so there
are no addresses to reach. That path only refreshes the on-card promo (handled in
the client), which is what a scanner sees when they open a card.

## One-time setup

1. **Create a Resend account** and verify a sending domain
   (Resend → Domains → Add Domain, then add the DNS records). You can only send
   from an address on a verified domain.

2. **Install the Supabase CLI** and link the project (ref `qnlaaieyipeglfuepmor`):
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref qnlaaieyipeglfuepmor
   ```

3. **Set the secrets** (the Supabase URL + service-role + anon keys are injected
   automatically; you only add the two Resend values):
   ```bash
   supabase secrets set \
     RESEND_API_KEY="re_xxxxxxxxxxxxxxxxxxxx" \
     RESEND_FROM="Duyên <promos@yourverifieddomain.com>"
   ```

4. **Deploy:**
   ```bash
   supabase functions deploy send-promotion
   ```

That's it. The dashboard's **Push Promotion** button lights up email delivery
automatically once the function is deployed — until then it degrades gracefully
(the promo still saves to the cards, and the UI says email isn't set up yet).

## What it does

1. Verifies the caller's JWT → identifies the business user.
2. Loads that business's cards (`qr_codes.business_user_id = caller`).
3. Finds distinct savers (`tapestry.user_id` for those `qr_code_id`s), excluding
   the business owner.
4. Resolves saver emails via the auth admin API (service role).
5. Sends the promotion through Resend's batch endpoint (≤100 per call).
6. Returns `{ sent, skipped, recipients, failed }`.

## Notes / before scaling up

- **Unsubscribe.** The email footer currently asks recipients to reply
  "unsubscribe". For larger/marketing sends you should add a real one-click
  unsubscribe (a `List-Unsubscribe` header + an opt-out table checked here before
  sending). Left as a follow-up so this ships.
- **Rate limits.** Resend's free tier caps daily volume; batches of 100 keep calls
  minimal. For big audiences consider a queue.
- **Only savers are reachable.** Growing the reachable audience means capturing
  identities at scan time (e.g. logging signed-in scanners) — not done here.
