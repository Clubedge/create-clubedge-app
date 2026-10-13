// The showcase walkthroughs. Each one creates a project with the published CLI and alternates
// terminal scenes (typed and run for real) with browser scenes (the running app, driven by
// Playwright). See director.mjs for terminal(), browser() and sh().
import { join } from "node:path";

const create = (flags) => `pnpm dlx @clubedge/create-clubedge-app my-app ${flags} --yes`.replace(/\s+/g, " ");
const password = "correct horse battery";

// Real Stripe test mode when the repository has the test secrets, else the Starter's Stripe API
// stand-in (e2e/stripe-fake.ts). Values go into the env file off camera and are never printed.
const stripeReal = Boolean(process.env.STRIPE_TEST_SECRET_KEY && process.env.STRIPE_TEST_PRICE_PRO);
const stripeEnv = stripeReal
  ? `f=$(envfile)
setenv "$f" STRIPE_SECRET_KEY "$STRIPE_TEST_SECRET_KEY"
setenv "$f" STRIPE_PRICE_PRO "\${STRIPE_PRICE_RESOLVED:-$STRIPE_TEST_PRICE_PRO}"
setenv "$f" STRIPE_WEBHOOK_SECRET "$STRIPE_LISTEN_SECRET"`
  : `f=$(envfile)
setenv "$f" STRIPE_SECRET_KEY sk_test_ci
setenv "$f" STRIPE_PRICE_PRO price_ci_pro
setenv "$f" STRIPE_WEBHOOK_SECRET whsec_ci_only
setenv "$f" STRIPE_API_BASE http://127.0.0.1:12111`;
const stripeNote = stripeReal
  ? `note "Stripe test-mode keys set in $(envfile); webhooks forwarded by the Stripe CLI"`
  : `note "Stripe set to the Starter's Stripe API stand-in in $(envfile) (no test keys here)"`;

const secretEnv = `setenv "$(envfile)" BETTER_AUTH_SECRET "$BETTER_AUTH_SECRET"`;

// After the dev server stops, commit anything it rewrote (such as next-env.d.ts), on camera, so
// the CLI sees a clean tree, as it requires.
const commitDevFiles = `[ -z "$(git status --porcelain)" ] || run "git add -A && git commit -qm 'Files written by the dev server'"`;

async function signUp(a, email) {
  await a.goto("/login?mode=signup", 1200);
  await a.type(a.page.getByLabel("Email"), email);
  await a.type(a.page.getByLabel("Password", { exact: true }), password);
  await a.click(a.page.getByRole("button", { name: "Create account" }), 1500);
}

/** Loads the dashboard until `text` appears in `selector` (the page shows data as rendered). */
async function waitForText(a, selector, text, timeout = 60_000) {
  const until = Date.now() + timeout;
  for (;;) {
    await a.page.goto("/dashboard");
    await a.page.waitForLoadState("networkidle").catch(() => {});
    if ((await a.page.locator(selector).textContent())?.includes(text)) return;
    if (Date.now() > until) throw new Error(`"${text}" did not appear in ${selector}`);
    await a.page.waitForTimeout(1500);
  }
}

async function mailpitMessage(to) {
  for (let i = 0; i < 30; i++) {
    const search = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)
      .then((r) => r.json())
      .catch(() => null);
    const message = search?.messages?.[0];
    if (message) {
      const full = await fetch(`http://localhost:8025/api/v1/message/${message.ID}`).then((r) => r.json());
      const link = /https?:\/\/[^\s"<>]+/.exec(full.Text ?? "")?.[0] ?? /href="([^"]+)"/.exec(full.HTML ?? "")?.[1];
      return { id: message.ID, link: link?.replaceAll("&amp;", "&") };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No email to ${to} arrived in Mailpit.`);
}

/** Pays on the hosted Stripe Checkout page with the test card. */
async function payOnStripeCheckout(a) {
  const { page } = a;
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await a.pause(1500);
  const visible = async (locator) => (await locator.count()) > 0 && (await locator.first().isVisible());
  const email = page.locator("#email");
  if (await visible(email)) await a.type(email, "ada@example.com");
  // Some accounts list several payment methods: pick the card.
  const cardTab = page.locator('[data-testid="card-accordion-item-button"]');
  if (await visible(cardTab)) await a.click(cardTab, 600);
  await a.type(page.locator("#cardNumber"), "4242424242424242");
  await a.type(page.locator("#cardExpiry"), "1234");
  await a.type(page.locator("#cardCvc"), "123");
  const name = page.locator("#billingName");
  if (await visible(name)) await a.type(name, "Ada Lovelace");
  const postal = page.locator("#billingPostalCode");
  if (await visible(postal)) await a.type(postal, "10001");
  await a.click(page.locator('[data-testid="hosted-payment-submit-button"]'), 0);
  await page.waitForURL(/localhost:3000\/dashboard/, { timeout: 90_000 });
}

export const scenarios = {
  // The default modules, with Supabase running locally so sign-in works on the runner.
  async default({ terminal, browser, sh }) {
    await terminal("Create the project", `run "${create("--infra supabase --storage supabase")}"\nrun "cd my-app"`);
    // Pull Supabase's images off camera, so the recording shows an ordinary start.
    sh("for i in 1 2 3 4; do pnpm infra:up && break; sleep 45; done && pnpm infra:down");
    await terminal(
      "Start Supabase, migrate, run the app",
      `run "pnpm infra:up"
eval "$(npx --yes supabase@2 status -o env 2> /dev/null)"
f=$(envfile)
setenv "$f" NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY "\${PUBLISHABLE_KEY:-$ANON_KEY}"
setenv "$f" SUPABASE_SECRET_KEY "\${SECRET_KEY:-$SERVICE_ROLE_KEY}"
note "Local Supabase keys copied into $f"
run "pnpm db:migrate"
serve "pnpm dev" "http://localhost:3000/" dev`,
    );
    await browser("Sign up and look around", async (a) => {
      await a.goto("/", 2500);
      await signUp(a, "ada@example.com");
      await a.pause(2000);
      await a.click(a.page.getByRole("complementary").getByRole("link", { name: "Settings" }), 1200);
      await a.type(a.page.getByLabel("Display name"), "Ada Lovelace");
      await a.click(a.page.getByRole("button", { name: "Save profile" }), 1800);
      await a.goto("/dashboard", 2500);
    });
    return { flags: "--infra supabase --storage supabase", stripe: null };
  },

  // A subscription SaaS: Better Auth with email confirmation, Stripe, background jobs, and the
  // Docker services (Postgres, Redis, S3 mock, and Mailpit, which catches every email).
  async saas({ terminal, browser, sh, app }) {
    const flags = "--auth better-auth --payments stripe --jobs pg-boss";
    await terminal("Create the project", `run "${create(flags)}"\nrun "cd my-app"`);
    sh("for i in 1 2 3 4; do docker compose -f docker-compose.dev.yml pull --quiet && break; sleep 45; done");
    await terminal(
      "Start the services, migrate, run the app",
      `run "pnpm infra:up"
${secretEnv}
setenv "$(envfile)" BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION true
${stripeEnv}
note "BETTER_AUTH_SECRET set and email confirmation required in $(envfile)"
${stripeNote}
run "pnpm db:migrate"
serve "pnpm dev" "http://localhost:3000/" dev`,
    );

    const email = "ada@example.com";
    await browser("Sign up, then confirm the email in Mailpit", async (a) => {
      await a.goto("/", 1500);
      await signUp(a, email);
      await a.pause(2000);
      const { id, link } = await mailpitMessage(email);
      await a.goto(`http://localhost:8025/view/${id}`, 3500);
      await a.goto(link, 2500);
    });

    let fake;
    if (!stripeReal) {
      process.env.STRIPE_API_BASE = "http://127.0.0.1:12111";
      fake = await import(join(app, "e2e/stripe-fake.ts"));
    }
    await browser(stripeReal ? "Upgrade to Pro on Stripe Checkout" : "Upgrade to Pro (Stripe API stand-in)", async (a) => {
      const stripe = fake && (await fake.startFakeStripe());
      try {
        await a.goto("/dashboard", 1500);
        await a.scrollTo(a.page.locator("#billing"));
        await a.click(a.page.getByRole("button", { name: "Upgrade to Pro" }), 0);
        if (stripeReal) {
          await payOnStripeCheckout(a);
        } else {
          await a.page.waitForURL(/billing=success/, { timeout: 30_000 });
          // Stripe would send this webhook; the stand-in's is signed the same way.
          const event = { id: `evt_${Date.now()}`, type: "customer.subscription.created", data: { object: { id: "sub_e2e" } } };
          const { headers, data } = fake.signedWebhook(event, "whsec_ci_only");
          await fetch("http://localhost:3000/api/webhooks/payments", { method: "POST", headers, body: data });
        }
        await a.pause(1500);
        await waitForText(a, "#billing", "Pro");
        await a.scrollTo(a.page.locator("#billing"), 2500);
        if (stripeReal) {
          await a.click(a.page.locator("#billing").getByRole("button", { name: "Manage billing" }), 0);
          await a.page.waitForURL(/billing\.stripe\.com/, { timeout: 60_000 });
          await a.page.waitForLoadState("networkidle").catch(() => {});
          await a.pause(3500);
        }
      } finally {
        await stripe?.stop();
      }
    });

    await browser("Run a background job", async (a) => {
      await a.goto("/dashboard", 1200);
      await a.scrollTo(a.page.locator("#jobs"));
      await a.click(a.page.locator("#jobs").getByRole("button", { name: "Run a sample job" }), 2000);
      await waitForText(a, "#jobs", "completed");
      await a.scrollTo(a.page.locator("#jobs"), 3000);
    });
    return { flags, stripe: stripeReal ? "test-mode" : "stand-in" };
  },

  // TanStack Start with no Docker at all: PGlite as the local Postgres.
  async "start-local"({ terminal, browser }) {
    const flags = "--framework tanstack-start --infra local --auth better-auth";
    await terminal("Create the project", `run "${create(flags)}"\nrun "cd my-app"`);
    await terminal(
      "Start the local database, migrate, run the app",
      `serve "pnpm infra:up" "Local database ready" db
${secretEnv}
note "BETTER_AUTH_SECRET set in $(envfile)"
run "pnpm db:migrate"
serve "pnpm dev" "http://localhost:3000/" dev`,
    );
    await browser("Sign up and look around", async (a) => {
      await a.goto("/", 2500);
      await signUp(a, "ada@example.com");
      await a.pause(2500);
      await a.click(a.page.getByRole("complementary").getByRole("link", { name: "Settings" }), 1200);
      await a.type(a.page.getByLabel("Display name"), "Ada Lovelace");
      await a.click(a.page.getByRole("button", { name: "Save profile" }), 1800);
      await a.goto("/dashboard", 2500);
    });
    return { flags, stripe: null };
  },

  // Only what is needed: no auth, storage, email, or local services; memory cache.
  async minimal({ terminal, browser }) {
    const flags = "--auth none --storage none --cache memory --infra none --email none";
    await terminal("Create the project", `run "${create(flags)}"\nrun "cd my-app"\nrun "ls packages"`);
    await terminal("Run the app", `serve "pnpm dev" "http://localhost:3000/" dev`);
    await browser("The app, with nothing to configure", async (a) => {
      await a.goto("/", 3000);
      await a.goto("/dashboard", 3000);
    });
    return { flags, stripe: null };
  },

  // One project over time: generated from an older Starter, edited, upgraded, then changed with
  // add and remove, with the running app after each step.
  async evolution({ terminal, browser, sh }) {
    const from = "v0.14.0";
    await terminal(
      `Create a project on Starter ${from}`,
      `run "${create(`--ref ${from} --auth better-auth`)}"
run "cd my-app"
run "git add -A && git commit -qm 'Generated from Starter ${from}'"`,
    );
    await terminal(
      "Make it your own",
      `note "Edited by hand: the product description, and a script of our own in package.json"
node -e '
  const fs = require("fs");
  const edit = (file, change) => {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    change(json);
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\\n");
  };
  edit("apps/web/src/config/site.json", (s) => (s.description = "Bookings and memberships for climbing gyms."));
  edit("package.json", (p) => (p.scripts["verify"] = "pnpm lint && pnpm typecheck && pnpm test"));
'
run "git diff"
run "git commit -qam 'Our description and verify script'"`,
    );
    sh("for i in 1 2 3 4; do docker compose -f docker-compose.dev.yml pull --quiet && break; sleep 45; done");
    await terminal(
      "Start it",
      `run "pnpm infra:up"
${secretEnv}
note "BETTER_AUTH_SECRET set in $(envfile)"
run "pnpm db:migrate"
serve "pnpm dev" "http://localhost:3000/" dev`,
    );
    await browser(`Starter ${from} in the browser`, async (a) => {
      await a.goto("/", 2000);
      await signUp(a, "ada@example.com");
      await a.pause(3000);
    });
    await terminal(
      "Upgrade to the latest Starter",
      `stop dev
${commitDevFiles}
run "pnpm clubedge upgrade --yes"
run "git diff --stat | tail -n 1"
note "package.json was merged: the Starter's changes came in, and our script stayed"
run "git diff package.json"
run "grep '\\"verify\\"' package.json"
run "git add -A && git commit -qm 'Upgrade the Starter'"
serve "pnpm dev" "http://localhost:3000/" dev`,
    );
    await browser("After the upgrade: the new dashboard", async (a) => {
      await a.goto("/dashboard", 3500);
      await a.goto("/", 2500);
    });
    await terminal(
      "Add Stripe payments",
      `stop dev
${commitDevFiles}
run "pnpm clubedge add payments stripe --yes"
${stripeEnv}
${stripeNote}
run "pnpm db:migrate"
run "git add -A && git commit -qm 'Add Stripe payments'"
serve "pnpm dev" "http://localhost:3000/" dev`,
    );
    await browser("Billing is now in the dashboard", async (a) => {
      await a.goto("/dashboard", 1500);
      await a.scrollTo(a.page.locator("#billing"), 3500);
    });
    await terminal(
      "Remove file storage, check the project",
      `stop dev
${commitDevFiles}
run "pnpm clubedge remove storage --yes"
run "git add -A && git commit -qm 'Remove file storage'"
run "pnpm clubedge status"
run "git log --oneline"`,
    );
    return { flags: `--ref ${from} --auth better-auth`, from, stripe: stripeReal ? "test-mode" : "stand-in" };
  },
};
