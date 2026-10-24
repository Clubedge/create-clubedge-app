import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import {
  buildArgumentKeys,
  caddyfileSource,
  clientAddresses,
  clientAddressVariables,
  databasesFor,
  dockerComposeSource,
  fullstackService,
  ghcrImagePrefix,
  publicService,
  releaseImagesWorkflowSource,
  externalDatabaseUrls,
  isLocalUrl,
  deploymentStatus,
  meetsMinimumCli,
  exampleKeys,
  flyAppUrl,
  flySecretNames,
  flySecretsInput,
  flyTomlValue,
  parseDeploymentId,
  parseEnvFile,
  parseRedisUrl,
  parseRailwayDomain,
  parseVariables,
  planServicePair,
  planVariables,
  railwayCliVersion,
  railwayIacSource,
  serviceName,
  serviceNames,
  ignoresEnvFiles,
  minimumVercelCli,
  parseVercelDeploymentUrl,
  parseVercelEnv,
  parseVercelProject,
  vercelEnvBody,
  netlifyEnvFile,
  netlifySiteName,
  parseNetlifyAccounts,
  parseNetlifyDeploy,
  parseNetlifySite,
  parseRenderEnv,
  parseRenderOwners,
  parseRenderService,
  renderRepoUrl,
  renderServiceBody,
  vercelIgnoreSource,
  vercelProductionUrl,
} from "../src/core/deploy.js";
import type { ProjectService } from "../src/core/manifest.js";

describe("deploy plan", () => {
  it("names the service after the package", () => {
    expect(serviceName("@acme/My App")).toBe("my-app");
    expect(serviceName("---")).toBe("web");
  });

  it("adds Redis only with the redis cache", () => {
    expect(databasesFor({ cache: "redis" })).toEqual(["postgres", "redis"]);
    expect(databasesFor({ cache: "memory" })).toEqual(["postgres"]);
  });

  it("skips the databases whose URL comes from elsewhere", () => {
    expect(databasesFor({ cache: "redis" }, ["DATABASE_URL"])).toEqual(["redis"]);
    expect(databasesFor({ cache: "redis" }, ["DATABASE_URL", "REDIS_URL"])).toEqual([]);
  });

  it("tells local URLs from hosted ones", () => {
    expect(isLocalUrl("postgresql://postgres:postgres@localhost:5432/app")).toBe(true);
    expect(isLocalUrl("redis://127.0.0.1:6379")).toBe(true);
    expect(isLocalUrl("postgres://u:p@[::1]/app")).toBe(true);
    expect(isLocalUrl("postgres://u:p@host.docker.internal/app")).toBe(true);
    expect(isLocalUrl("postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres")).toBe(false);
    expect(isLocalUrl("rediss://default:pw@eu1-x.upstash.io:6379")).toBe(false);
  });

  it("takes hosted database URLs from the env file, for the databases the project uses", () => {
    const envFile = { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres", REDIS_URL: "rediss://default:pw@x.upstash.io:6379" };
    expect(externalDatabaseUrls({ cache: "redis" }, envFile)).toEqual(envFile);
    expect(externalDatabaseUrls({ cache: "memory" }, envFile)).toEqual({ DATABASE_URL: envFile.DATABASE_URL });
    expect(externalDatabaseUrls({ cache: "redis" }, { DATABASE_URL: "postgresql://localhost/dev", REDIS_URL: "" })).toEqual({});
  });

  it("reads the example's variable names once each", () => {
    expect(exampleKeys("# comment\r\nDATABASE_URL=x\nDATABASE_URL=y\nSMTP_URL=\n  REDIS_URL=\nlower=1\n")).toEqual([
      "DATABASE_URL",
      "SMTP_URL",
      "REDIS_URL",
    ]);
  });

  it("reads env files with quotes, export, and comments", () => {
    expect(parseEnvFile('export A=1\nB="two words"\nC=three # note\n# D=4\nE=\'x#y\'\n')).toEqual({
      A: "1",
      B: "two words",
      C: "three",
      E: "x#y",
    });
  });

  it("drops a comment after a quoted value, and keeps # inside the quotes", () => {
    expect(parseEnvFile('STRIPE_SECRET_KEY="sk_live_abc" # production key\nSMTP_URL=\'smtps://u:p#1@mail\'  # mail\n')).toEqual({
      STRIPE_SECRET_KEY: "sk_live_abc",
      SMTP_URL: "smtps://u:p#1@mail",
    });
  });

  const base = {
    modules: { auth: "better-auth", cache: "redis" },
    keys: ["NODE_ENV", "NEXT_PUBLIC_APP_URL", "DATABASE_URL", "BETTER_AUTH_SECRET", "REDIS_URL", "SMTP_URL", "STRIPE_SECRET_KEY"],
    url: "https://my-app.up.railway.app",
    existing: {},
    envFile: {},
    secret: () => "s3cret",
  };

  it("provides database references, the URL, the port, and a Better Auth secret", () => {
    const plan = planVariables(base);
    expect(plan.set).toMatchObject({
      NODE_ENV: "production",
      PORT: "3000",
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      REDIS_URL: "${{Redis.REDIS_URL}}",
      APP_URL: "https://my-app.up.railway.app",
      NEXT_PUBLIC_APP_URL: "https://my-app.up.railway.app",
      BETTER_AUTH_SECRET: "s3cret",
    });
    expect(plan.unset).toEqual(["SMTP_URL", "STRIPE_SECRET_KEY"]);
  });

  it("keeps an existing secret, and counts the service's own values as set", () => {
    const plan = planVariables({ ...base, existing: { BETTER_AUTH_SECRET: "kept", SMTP_URL: "smtp://x" } });
    expect(plan.set.BETTER_AUTH_SECRET).toBeUndefined();
    expect(plan.unset).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("takes --env-file values, but not a local database URL", () => {
    const plan = planVariables({
      ...base,
      envFile: { STRIPE_SECRET_KEY: "sk_live_x", DATABASE_URL: "postgresql://localhost/dev", SMTP_URL: "" },
    });
    expect(plan.set.STRIPE_SECRET_KEY).toBe("sk_live_x");
    expect(plan.set.DATABASE_URL).toBe("${{Postgres.DATABASE_URL}}");
    expect(plan.unset).toEqual(["SMTP_URL"]);
  });

  it("uses hosted database URLs from --env-file instead of Railway's databases", () => {
    const plan = planVariables({
      ...base,
      envFile: { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres", REDIS_URL: "rediss://default:pw@x.upstash.io:6379" },
    });
    expect(plan.set).toMatchObject({ DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres", REDIS_URL: "rediss://default:pw@x.upstash.io:6379" });
    const mixed = planVariables({ ...base, envFile: { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres" } });
    expect(mixed.set).toMatchObject({ DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres", REDIS_URL: "${{Redis.REDIS_URL}}" });
  });

  it("leaves a database URL the service keeps out of the plan", () => {
    const plan = planVariables({ ...base, existing: { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres" }, databases: { REDIS_URL: "${{Redis.REDIS_URL}}" } });
    expect(plan.set).not.toHaveProperty("DATABASE_URL");
    expect(plan.unset).not.toContain("DATABASE_URL");
  });

  it("needs no secret without Better Auth", () => {
    expect(planVariables({ ...base, modules: { auth: "none", cache: "memory" } }).set).not.toHaveProperty("BETTER_AUTH_SECRET");
  });
});

const pairServices: Record<string, ProjectService> = {
  framework: { id: "web", role: "frontend", app: "apps/web", dockerfile: "Dockerfile", port: 3000, healthPath: "/", platforms: ["docker", "railway"] },
  api: { id: "api", role: "api", app: "apps/api", dockerfile: "apps/api/Dockerfile", port: 3001, healthPath: "/api/health", platforms: ["docker", "railway"] },
};
const betterAuthFrontendKeys = [
  "API_URL",
  "VITE_API_URL",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION",
];

const fullstack = { framework: fullstackService };
const caddy = [
  "  caddy:",
  "    image: caddy:2",
  "    restart: unless-stopped",
  "    ports:",
  '      - "80:80"',
  '      - "443:443"',
  '      - "443:443/udp"',
  "    environment:",
  '      DOMAIN: "${DOMAIN:?Set DOMAIN in .env.production to the domain that points at this server}"',
  "    volumes:",
  "      - ./Caddyfile:/etc/caddy/Caddyfile:ro",
  "      - caddy-data:/data",
  "      - caddy-config:/config",
  "    depends_on:",
  "      - web",
  "",
  "volumes:",
  "  caddy-data:",
  "  caddy-config:",
  "",
].join("\n");

describe("Docker Compose for a frontend and an API", () => {
  it("pulls each app's image or builds it, behind Caddy, which alone publishes ports", () => {
    const source = dockerComposeSource("edge-notes", pairServices);
    expect(source).toContain("  web:\n    image: ${IMAGE_PREFIX:-edge-notes}-web:${TAG:-latest}\n    build:\n      context: .\n      dockerfile: Dockerfile\n");
    expect(source).toContain("  api:\n    image: ${IMAGE_PREFIX:-edge-notes}-api:${TAG:-latest}\n    build:\n      context: .\n      dockerfile: apps/api/Dockerfile\n");
    expect(source).toContain('    expose:\n      - "3000"\n    depends_on:\n      - api\n    restart: unless-stopped\n');
    expect(source).toContain('    expose:\n      - "3001"\n    restart: unless-stopped\n');
    expect(source.match(/^ {4}ports:/gm)).toHaveLength(1);
    expect(source.endsWith(caddy)).toBe(true);
  });

  it("builds the frontend with the VITE_* values its example lists", () => {
    const firebase = dockerComposeSource("edge-notes", pairServices, ["API_URL", "VITE_API_URL", "VITE_FIREBASE_API_KEY", "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_AUTH_DOMAIN"]);
    expect(firebase).toContain(
      "      args:\n        VITE_API_URL: ${VITE_API_URL:-}\n        VITE_FIREBASE_API_KEY: ${VITE_FIREBASE_API_KEY:-}\n        VITE_FIREBASE_PROJECT_ID: ${VITE_FIREBASE_PROJECT_ID:-}\n        VITE_FIREBASE_AUTH_DOMAIN: ${VITE_FIREBASE_AUTH_DOMAIN:-}\n",
    );
    expect(firebase).not.toContain("VITE_SUPABASE_URL");
    expect(firebase).not.toContain("BETTER_AUTH_URL");

    const appwrite = dockerComposeSource("edge-notes", pairServices, ["API_URL", "VITE_APPWRITE_ENDPOINT", "VITE_APPWRITE_PROJECT_ID"]);
    expect(appwrite).toContain("        VITE_APPWRITE_ENDPOINT: ${VITE_APPWRITE_ENDPOINT:-}\n        VITE_APPWRITE_PROJECT_ID: ${VITE_APPWRITE_PROJECT_ID:-}");
    expect(dockerComposeSource("edge-notes", pairServices)).not.toContain("args:");
  });

  it("gives the frontend's server Better Auth's runtime variables, at the domain Caddy serves, and the API its address", () => {
    const source = dockerComposeSource("edge-notes", pairServices, betterAuthFrontendKeys);
    expect(source).toContain("      args:\n        VITE_API_URL: ${VITE_API_URL:-}\n    environment:");
    expect(source).toContain(
      [
        "    environment:",
        "      API_URL: http://api:3001",
        "      # Caddy, the one proxy in front, sets X-Forwarded-For to the client's address.",
        "      CLIENT_IP_HEADER: ${CLIENT_IP_HEADER:-}",
        "      TRUSTED_PROXY_HOPS: ${TRUSTED_PROXY_HOPS:-1}",
        "      DATABASE_URL: ${DATABASE_URL:-}",
        "      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:-}",
        "      BETTER_AUTH_URL: ${BETTER_AUTH_URL:-https://${DOMAIN}}",
        "      RESEND_API_KEY: ${RESEND_API_KEY:-}",
        "      EMAIL_FROM: ${EMAIL_FROM:-}",
        "      BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION: ${BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION:-}",
        "    expose:",
      ].join("\n"),
    );
    // The API reads .env.production, is reached only through the frontend, and asks the frontend's
    // server for the session over the Compose network.
    expect(source).toContain(
      [
        "    env_file:",
        "      - path: .env.production",
        "        required: false",
        "    environment:",
        "      HOST: 0.0.0.0",
        "      # Reached only through web, which passes on the client's address as the one X-Forwarded-For entry.",
        '      CLIENT_IP_HEADER: ""',
        '      TRUSTED_PROXY_HOPS: "1"',
        "      BETTER_AUTH_URL: http://web:3000",
        "    expose:",
      ].join("\n"),
    );
  });

  it("sets each client-address setting once, even when the frontend's example lists it", () => {
    const source = dockerComposeSource("edge-notes", pairServices, ["API_URL", "CLIENT_IP_HEADER", "TRUSTED_PROXY_HOPS", "PORT"]);
    expect(source.match(/^ {6}CLIENT_IP_HEADER: /gm)).toHaveLength(2);
    expect(source.match(/^ {6}TRUSTED_PROXY_HOPS: /gm)).toHaveLength(2);
    expect(source).not.toContain("PORT:");
  });
});

describe("Docker Compose for a full-stack app", () => {
  const nextKeys = ["NODE_ENV", "NEXT_PUBLIC_APP_URL", "DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "BETTER_AUTH_SECRET"];

  it("runs the root Dockerfile's image behind Caddy, with the env file and the public URL at the domain", () => {
    const source = dockerComposeSource("my-app", fullstack, nextKeys);
    expect(source).toContain(
      [
        "services:",
        "  web:",
        "    image: ${IMAGE_PREFIX:-my-app}-web:${TAG:-latest}",
        "    build:",
        "      context: .",
        "      dockerfile: Dockerfile",
        "      args:",
        "        NEXT_PUBLIC_APP_URL: ${NEXT_PUBLIC_APP_URL:-https://${DOMAIN}}",
        "    env_file:",
        "      - path: .env.production",
        "        required: false",
        "    environment:",
        "      APP_URL: ${APP_URL:-https://${DOMAIN}}",
        "      NEXT_PUBLIC_APP_URL: ${NEXT_PUBLIC_APP_URL:-https://${DOMAIN}}",
        "      # Caddy, the one proxy in front, sets X-Forwarded-For to the client's address.",
        "      TRUSTED_PROXY_HOPS: ${TRUSTED_PROXY_HOPS:-1}",
        "    expose:",
        '      - "3000"',
        "    restart: unless-stopped",
        caddy,
      ].join("\n"),
    );
    // The env file's own CLIENT_IP_HEADER reaches the app through env_file.
    expect(source).not.toContain("CLIENT_IP_HEADER");
  });

  it("passes no build arguments to an image that compiles nothing in (TanStack Start)", () => {
    expect(dockerComposeSource("my-app", fullstack, ["APP_URL", "DATABASE_URL"])).not.toContain("args:");
    expect(buildArgumentKeys(fullstackService, nextKeys)).toEqual(["NEXT_PUBLIC_APP_URL"]);
    expect(buildArgumentKeys(pairServices.api!, ["VITE_API_URL"])).toEqual([]);
  });

  it("serves the public app at DOMAIN in the Caddyfile", () => {
    const expected = "{$DOMAIN} {\n\treverse_proxy web:3000\n}\n";
    expect(caddyfileSource(fullstack).endsWith(expected)).toBe(true);
    expect(caddyfileSource(pairServices).endsWith(expected)).toBe(true);
    expect(caddyfileSource({ api: pairServices.api!, framework: { ...pairServices.framework!, id: "site", port: 8080 } })).toContain("\treverse_proxy site:8080\n");
    expect(publicService(pairServices).role).toBe("frontend");
  });
});

describe("the workflow that publishes the images", () => {
  const workflow = releaseImagesWorkflowSource(pairServices, ["API_URL", "VITE_API_URL", "VITE_SUPABASE_URL"]);

  it("runs for published releases and by hand, never for tag pushes", () => {
    expect(workflow).toContain("\non:\n  release:\n    types: [published]\n  workflow_dispatch:\n\npermissions:\n  contents: read\n  packages: write\n\njobs:\n");
  });

  it("builds one image per app, with the values it compiles in from repository variables", () => {
    expect(workflow).toContain(
      [
        "        include:",
        "          - service: web",
        "            dockerfile: Dockerfile",
        "            context: .",
        "            # The image compiles these in: set them as repository variables.",
        "            build-args: |",
        "              VITE_API_URL=${{ vars.VITE_API_URL }}",
        "              VITE_SUPABASE_URL=${{ vars.VITE_SUPABASE_URL }}",
        "          - service: api",
        "            dockerfile: apps/api/Dockerfile",
        "            context: .",
        "    steps:",
      ].join("\n"),
    );
    const next = releaseImagesWorkflowSource(fullstack, ["NEXT_PUBLIC_APP_URL", "DATABASE_URL"]);
    expect(next).toContain("          - service: web\n            dockerfile: Dockerfile\n            context: .\n            # The image");
    expect(next).toContain("              NEXT_PUBLIC_APP_URL=${{ vars.NEXT_PUBLIC_APP_URL }}\n    steps:");
    expect(releaseImagesWorkflowSource(fullstack, ["APP_URL"])).not.toContain("build-args: |");
  });

  it("pushes multi-platform images to GHCR, tagged by version, latest, and edge", () => {
    for (const action of [
      "actions/checkout@v7",
      "docker/setup-qemu-action@v4",
      "docker/setup-buildx-action@v4",
      "docker/login-action@v4",
      "docker/metadata-action@v6",
      "docker/build-push-action@v7",
    ]) {
      expect(workflow).toContain(`uses: ${action}\n`);
    }
    expect(workflow).toContain("          registry: ghcr.io\n          username: ${{ github.actor }}\n          password: ${{ secrets.GITHUB_TOKEN }}\n");
    expect(workflow).toContain("          images: ghcr.io/${{ github.repository }}-${{ matrix.service }}\n          flavor: latest=false\n");
    expect(workflow).toContain(
      [
        "            type=semver,pattern={{version}}",
        "            type=semver,pattern={{major}}.{{minor}}",
        "            type=raw,value=latest,enable=${{ github.event_name == 'release' && !github.event.release.prerelease }}",
        "            type=edge",
      ].join("\n"),
    );
    expect(workflow).toContain("          platforms: linux/amd64,linux/arm64\n          push: true\n");
    expect(workflow).toContain("          file: ${{ matrix.dockerfile }}\n");
    expect(workflow).toContain("          cache-from: type=gha,scope=${{ matrix.service }}\n          cache-to: type=gha,mode=max,scope=${{ matrix.service }}\n");
  });

  it("names the registry the images go to, from a GitHub remote", () => {
    expect(ghcrImagePrefix("git@github.com:Clubedge/Edge-Notes.git")).toBe("ghcr.io/clubedge/edge-notes");
    expect(ghcrImagePrefix("https://github.com/me/my-app\n")).toBe("ghcr.io/me/my-app");
    expect(ghcrImagePrefix("https://gitlab.com/me/my-app.git")).toBeNull();
    expect(ghcrImagePrefix("")).toBeNull();
  });
});

describe("Railway variables for a frontend and an API", () => {
  const apiKeys = ["HOST", "PORT", "FRONTEND_URL", "DATABASE_URL", "DATABASE_URL_DIRECT", "BETTER_AUTH_URL"];
  const pair = {
    modules: { auth: "better-auth", cache: "memory" },
    frontendKeys: betterAuthFrontendKeys,
    apiKeys,
    url: "https://notes-web.up.railway.app",
    existing: { frontend: {}, api: {} },
    envFile: {},
    secret: () => "s3cret",
    databases: { DATABASE_URL: "${{Postgres.DATABASE_URL}}" },
    ports: { frontend: 3000, api: 3001 },
    clientAddress: clientAddresses.railway,
  };

  it("runs Better Auth in the frontend's server, with the API's database and the public URL", () => {
    const plan = planServicePair({ ...pair, envFile: { RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.co", BETTER_AUTH_URL: "http://localhost:3000" } });
    expect(plan.frontend.set).toEqual({
      PORT: "3000",
      CLIENT_IP_HEADER: "x-real-ip",
      RESEND_API_KEY: "re_x",
      EMAIL_FROM: "a@b.co",
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      BETTER_AUTH_URL: "https://notes-web.up.railway.app",
      BETTER_AUTH_SECRET: "s3cret",
    });
    expect(plan.frontend.unset).toEqual(["BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION"]);
    expect(plan.api.set).toMatchObject({
      PORT: "3001",
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      FRONTEND_URL: "https://notes-web.up.railway.app",
      BETTER_AUTH_URL: "https://notes-web.up.railway.app",
    });
    // The secret is the frontend's; the API only asks it for the session.
    expect(plan.api.set).not.toHaveProperty("BETTER_AUTH_SECRET");
    // The API's own example decides what it reports; HOST comes from its image.
    expect(plan.api.unset).toEqual([]);
  });

  it("keeps the frontend's secret, and a public Better Auth URL from the env file", () => {
    const plan = planServicePair({
      ...pair,
      existing: { frontend: { BETTER_AUTH_SECRET: "kept" }, api: {} },
      envFile: { BETTER_AUTH_URL: "https://app.example.com" },
    });
    expect(plan.frontend.set).not.toHaveProperty("BETTER_AUTH_SECRET");
    expect(plan.frontend.set.BETTER_AUTH_URL).toBe("https://app.example.com");
    expect(plan.api.set.BETTER_AUTH_URL).toBe("https://app.example.com");
  });

  it("gives the frontend the database the API keeps, or the hosted one from the env file", () => {
    const kept = planServicePair({ ...pair, databases: {}, existing: { frontend: {}, api: { DATABASE_URL: "postgresql://u:p@db.neon.tech/app" } } });
    expect(kept.frontend.set.DATABASE_URL).toBe("postgresql://u:p@db.neon.tech/app");
    const hosted = planServicePair({ ...pair, envFile: { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres" } });
    expect(hosted.frontend.set.DATABASE_URL).toBe("postgresql://u:p@db.supabase.co/postgres");
    expect(hosted.api.set.DATABASE_URL).toBe("postgresql://u:p@db.supabase.co/postgres");
  });

  it("sends VITE_* values to the frontend only, and reports each service's unset variables from its own example", () => {
    const plan = planServicePair({
      ...pair,
      modules: { auth: "supabase", cache: "memory" },
      frontendKeys: ["API_URL", "VITE_API_URL", "VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"],
      apiKeys: ["HOST", "PORT", "FRONTEND_URL", "DATABASE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"],
      envFile: { VITE_SUPABASE_URL: "https://x.supabase.co", SUPABASE_URL: "https://x.supabase.co", API_URL: "http://127.0.0.1:3001" },
    });
    expect(plan.frontend.set).toEqual({ PORT: "3000", CLIENT_IP_HEADER: "x-real-ip", VITE_SUPABASE_URL: "https://x.supabase.co" });
    expect(plan.frontend.unset).toEqual(["VITE_SUPABASE_PUBLISHABLE_KEY"]);
    expect(plan.api.set).not.toHaveProperty("VITE_SUPABASE_URL");
    expect(plan.api.set).toMatchObject({ SUPABASE_URL: "https://x.supabase.co" });
    expect(plan.api.set).not.toHaveProperty("BETTER_AUTH_URL");
    expect(plan.api.unset).toEqual(["SUPABASE_PUBLISHABLE_KEY"]);
  });
});

describe("client addresses", () => {
  const single = {
    modules: { auth: "none", cache: "memory" },
    keys: ["DATABASE_URL", "CLIENT_IP_HEADER", "TRUSTED_PROXY_HOPS"],
    url: "https://my-app.example.com",
    existing: {},
    envFile: {},
    secret: () => "s",
    databases: {},
  };

  it("sets the header each platform's edge puts the client's address in", () => {
    expect(planVariables({ ...single, clientAddress: clientAddresses.railway }).set.CLIENT_IP_HEADER).toBe("x-real-ip");
    expect(planVariables({ ...single, clientAddress: clientAddresses.render }).set.CLIENT_IP_HEADER).toBe("true-client-ip");
    expect(planVariables({ ...single, clientAddress: clientAddresses.fly }).set.CLIENT_IP_HEADER).toBe("fly-client-ip");
    expect(planVariables({ ...single, clientAddress: clientAddresses.vercel }).set.CLIENT_IP_HEADER).toBe("x-real-ip");
    expect(planVariables({ ...single, clientAddress: clientAddresses.netlify }).set.CLIENT_IP_HEADER).toBe("x-nf-client-connection-ip");
    expect(clientAddresses.docker).toEqual({ TRUSTED_PROXY_HOPS: "1" });
  });

  it("never reports the settings as unset, since they have safe defaults", () => {
    const plan = planVariables({ ...single, clientAddress: clientAddresses.fly });
    expect(plan.set).not.toHaveProperty("TRUSTED_PROXY_HOPS");
    expect(plan.unset).toEqual(["DATABASE_URL"]);
    expect(planVariables(single).unset).toEqual(["DATABASE_URL"]);
  });

  it("takes the env file's settings instead, either one replacing both defaults", () => {
    const header = planVariables({ ...single, envFile: { CLIENT_IP_HEADER: "cf-connecting-ip" }, clientAddress: clientAddresses.render });
    expect(header.set.CLIENT_IP_HEADER).toBe("cf-connecting-ip");
    const hops = planVariables({ ...single, envFile: { TRUSTED_PROXY_HOPS: "2", CLIENT_IP_HEADER: "" }, clientAddress: clientAddresses.railway });
    expect(hops.set.TRUSTED_PROXY_HOPS).toBe("2");
    expect(hops.set).not.toHaveProperty("CLIENT_IP_HEADER");
    expect(clientAddressVariables(clientAddresses.vercel, { CLIENT_IP_HEADER: "" })).toEqual({ CLIENT_IP_HEADER: "x-real-ip" });
  });

  it("gives a frontend the platform's header, and its API the frontend as its one proxy", () => {
    const pair = {
      modules: { auth: "none", cache: "memory" },
      frontendKeys: ["API_URL", "VITE_API_URL", "CLIENT_IP_HEADER", "TRUSTED_PROXY_HOPS"],
      apiKeys: ["HOST", "PORT", "DATABASE_URL", "CLIENT_IP_HEADER", "TRUSTED_PROXY_HOPS"],
      url: "https://notes-web.up.railway.app",
      existing: { frontend: {}, api: {} },
      envFile: {},
      secret: () => "s",
      databases: { DATABASE_URL: "${{Postgres.DATABASE_URL}}" },
      ports: { frontend: 3000, api: 3001 },
      clientAddress: clientAddresses.railway,
    };
    const plan = planServicePair(pair);
    expect(plan.frontend.set).toMatchObject({ CLIENT_IP_HEADER: "x-real-ip" });
    expect(plan.frontend.set).not.toHaveProperty("TRUSTED_PROXY_HOPS");
    expect(plan.api.set).toMatchObject({ TRUSTED_PROXY_HOPS: "1" });
    expect(plan.api.set).not.toHaveProperty("CLIENT_IP_HEADER");
    expect([...plan.frontend.unset, ...plan.api.unset]).toEqual([]);

    // The env file's settings describe the public service; the API stays behind the frontend.
    const own = planServicePair({ ...pair, envFile: { CLIENT_IP_HEADER: "cf-connecting-ip", TRUSTED_PROXY_HOPS: "3" } });
    expect(own.frontend.set).toMatchObject({ CLIENT_IP_HEADER: "cf-connecting-ip", TRUSTED_PROXY_HOPS: "3" });
    expect(own.api.set).toMatchObject({ TRUSTED_PROXY_HOPS: "1" });
    expect(own.api.set).not.toHaveProperty("CLIENT_IP_HEADER");
  });
});

describe("Railway CLI output", () => {
  it("finds the domain in JSON or text", () => {
    expect(parseRailwayDomain('{"domain":"My-App-production.up.railway.app"}')).toBe("my-app-production.up.railway.app");
    expect(parseRailwayDomain("Service Domain: https://web-1a2b.up.railway.app\n")).toBe("web-1a2b.up.railway.app");
    expect(parseRailwayDomain("No domains")).toBeNull();
  });

  it("finds service names wherever status puts them", () => {
    const status = {
      name: "my-app",
      services: { edges: [{ node: { name: "Postgres" } }, { node: { name: "my-app" } }] },
      environments: [{ name: "production" }],
    };
    expect(serviceNames(status).sort()).toEqual(["Postgres", "my-app"]);
    expect(serviceNames({ name: "project only" })).toEqual([]);
  });

  it("finds the deployment railway up started", () => {
    const output =
      "Indexing...\nUploading...\n  Deployment: https://railway.com/project/54fc3711-029a-4c04-96ff-90cee90497ab/service/5f49d436-3a6b-4c5b-a456-8c0ffb2461e6?id=8a3c507c-d1a0-4bd9-9cab-5b66f1e2b568\n";
    expect(parseDeploymentId(output)).toBe("8a3c507c-d1a0-4bd9-9cab-5b66f1e2b568");
    expect(parseDeploymentId("Uploading...")).toBeNull();
  });

  it("reads a deployment's status by id, or the newest since the upload", () => {
    // The shape `railway deployment list --json` returned in a live run, newest first.
    const list = JSON.stringify([
      { id: "0118e860-8f28-4e31-b31c-3f9bdf5f1580", status: "BUILDING", createdAt: "2026-10-13T17:39:10.396Z", meta: {} },
      { id: "8a3c507c-d1a0-4bd9-9cab-5b66f1e2b568", status: "FAILED", createdAt: "2026-10-13T17:27:34.000Z" },
    ]);
    expect(deploymentStatus(list, "8a3c507c-d1a0-4bd9-9cab-5b66f1e2b568", new Date())).toEqual({
      id: "8a3c507c-d1a0-4bd9-9cab-5b66f1e2b568",
      status: "FAILED",
    });
    expect(deploymentStatus(list, null, new Date("2026-10-13T17:39:08Z"))?.status).toBe("BUILDING");
    // Not listed yet, or not JSON: no status, so the caller keeps waiting.
    expect(deploymentStatus(list, null, new Date("2026-10-13T18:00:00Z"))).toBeNull();
    expect(deploymentStatus("Recent Deployments", null, new Date())).toBeNull();
  });

  it("reads variables as an object or a list", () => {
    expect(parseVariables('{"A":"1","B":2}')).toEqual({ A: "1", B: "2" });
    expect(parseVariables('[{"name":"A","value":"1"}]')).toEqual({ A: "1" });
    expect(parseVariables("not json")).toEqual({});
  });
});

describe("Railway configuration as code", () => {
  it("reads the CLI version and checks the 5.42.1 minimum", () => {
    expect(railwayCliVersion("railway 5.67.1\n")).toEqual([5, 67, 1]);
    expect(railwayCliVersion("timeout (GNU coreutils) 8.32")).toBeNull();
    expect(meetsMinimumCli([5, 67, 1])).toBe(true);
    expect(meetsMinimumCli([5, 42, 1])).toBe(true);
    expect(meetsMinimumCli([5, 42, 0])).toBe(false);
    expect(meetsMinimumCli([4, 99, 9])).toBe(false);
    expect(meetsMinimumCli([6, 0, 0])).toBe(true);
  });

  it("writes the settings railway.json had, for the project's own service", () => {
    const source = railwayIacSource("edge-notes");
    expect(source).toContain('import { defineRailway, project, service } from "railway/iac";');
    expect(source).toContain('export const partial = "edge-notes";');
    expect(source).toContain('service("edge-notes", {');
    expect(source).toContain('preDeploy: "node /app/migrate.mjs"');
    expect(source).toContain('healthcheck: "/api/health"');
    expect(source).toContain("healthcheckTimeout: 60");
    // Variables stay with deploy and the dashboard; no region, so Railway's default applies.
    expect(source).toContain("variables: { managed: false }");
    expect(source).not.toContain("replicas");
  });

  it("connects the frontend to the API by stack role, not by its slot name", () => {
    const source = railwayIacSource("edge-notes", {
      framework: {
        id: "vite",
        role: "frontend",
        app: "apps/web",
        dockerfile: "apps/web/Dockerfile",
        port: 3000,
        healthPath: "/",
        platforms: ["railway"],
      },
      backend: {
        id: "fastapi",
        role: "api",
        app: "apps/api",
        dockerfile: "apps/api/Dockerfile",
        port: 3001,
        healthPath: "/api/health",
        platforms: ["railway"],
      },
    });

    expect(source).toContain("const backend = service(");
    expect(source).toContain("API_URL: `http://${backend.env.RAILWAY_PRIVATE_DOMAIN}:3001`");
    expect(source).toContain("resources: [framework, backend]");
  });
});

describe("Fly.io", () => {
  it("reads the app and region fly launch writes, only above the first table", () => {
    const toml = 'app = "my-app-3f2a"\nprimary_region = "cdg"\n\n[build]\n  app = "not-this"\n';
    expect(flyTomlValue(toml, "app")).toBe("my-app-3f2a");
    expect(flyTomlValue(toml, "primary_region")).toBe("cdg");
    expect(flyTomlValue("[build]\n  dockerfile = \"Dockerfile\"\n", "app")).toBeNull();
    expect(flyAppUrl("my-app-3f2a")).toBe("https://my-app-3f2a.fly.dev");
  });

  it("finds the Redis URL and the secret names", () => {
    expect(parseRedisUrl("Your database is ready.\nRedis URL: redis://default:pw@fly-x.upstash.io:6379\n")).toBe(
      "redis://default:pw@fly-x.upstash.io:6379",
    );
    expect(parseRedisUrl("nothing here")).toBeNull();
    expect(flySecretNames('[{"Name":"DATABASE_URL","Digest":"x"},{"name":"APP_URL"}]')).toEqual(["DATABASE_URL", "APP_URL"]);
    expect(flySecretNames("not json")).toEqual([]);
  });

  it("imports secrets as NAME=VALUE lines, and refuses a value with a line break", () => {
    expect(flySecretsInput({ A: "1", B: "two words" })).toBe("A=1\nB=two words");
    expect(() => flySecretsInput({ KEY: "line\nbreak" })).toThrow(/line break/);
  });

  it("plans the secrets with DATABASE_URL attached by Fly and Redis from Upstash", () => {
    const plan = planVariables({
      modules: { auth: "better-auth", cache: "redis" },
      keys: ["DATABASE_URL", "REDIS_URL", "BETTER_AUTH_SECRET", "SMTP_URL"],
      url: "https://my-app.fly.dev",
      existing: {},
      envFile: { DATABASE_URL: "postgresql://localhost/dev" },
      secret: () => "s3cret",
      databases: { REDIS_URL: "redis://upstash" },
      attached: ["DATABASE_URL"],
    });
    expect(plan.set).not.toHaveProperty("DATABASE_URL");
    expect(plan.set).toMatchObject({ REDIS_URL: "redis://upstash", NEXT_PUBLIC_APP_URL: "https://my-app.fly.dev", BETTER_AUTH_SECRET: "s3cret" });
    expect(plan.unset).toEqual(["SMTP_URL"]);
  });

  it("plans the secrets with a hosted DATABASE_URL from the env file, and nothing attached", () => {
    const plan = planVariables({
      modules: { auth: "better-auth", cache: "redis" },
      keys: ["DATABASE_URL", "REDIS_URL", "BETTER_AUTH_SECRET"],
      url: "https://my-app.fly.dev",
      existing: {},
      envFile: { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres" },
      secret: () => "s3cret",
      databases: { REDIS_URL: "redis://upstash" },
    });
    expect(plan.set).toMatchObject({ DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres", REDIS_URL: "redis://upstash" });
    expect(plan.unset).toEqual([]);
  });
});

describe("Vercel", () => {
  it("needs a CLI with vercel api", () => {
    expect(meetsMinimumCli([64, 0, 2], minimumVercelCli)).toBe(true);
    expect(meetsMinimumCli([50, 5, 1], minimumVercelCli)).toBe(true);
    expect(meetsMinimumCli([50, 4, 9], minimumVercelCli)).toBe(false);
    expect(railwayCliVersion("Vercel CLI 64.0.2")).toEqual([64, 0, 2]);
  });

  it("reads the project and its production variables", () => {
    expect(parseVercelProject('{"id":"prj_1","name":"my-app","rootDirectory":"apps/web"}')).toEqual({
      id: "prj_1",
      name: "my-app",
      rootDirectory: "apps/web",
    });
    expect(parseVercelProject('{"id":"prj_1","name":"my-app","rootDirectory":null}')?.rootDirectory).toBeNull();
    expect(parseVercelProject('{"error":{"code":"not_found"}}')).toBeNull();
    const envs = JSON.stringify({
      envs: [
        { key: "NEXT_PUBLIC_APP_URL", value: "https://my-app.vercel.app", type: "plain", target: ["production"] },
        { key: "BETTER_AUTH_SECRET", value: "eyJ...", type: "encrypted", target: ["production", "preview"] },
        { key: "PREVIEW_ONLY", value: "x", type: "plain", target: ["preview"] },
      ],
    });
    expect(parseVercelEnv(envs)).toEqual({ NEXT_PUBLIC_APP_URL: "https://my-app.vercel.app", BETTER_AUTH_SECRET: "(set)" });
    expect(parseVercelEnv("not json")).toEqual({});
  });

  it("sets production variables, encrypted except the public URL", () => {
    expect(vercelEnvBody({ APP_URL: "https://a.vercel.app", DATABASE_URL: "postgres://x" })).toEqual([
      { key: "APP_URL", value: "https://a.vercel.app", type: "plain", target: ["production"] },
      { key: "DATABASE_URL", value: "postgres://x", type: "encrypted", target: ["production"] },
    ]);
  });

  it("finds the deployment URL and the production alias Vercel assigned", () => {
    expect(parseVercelDeploymentUrl("Inspect: https://vercel.com/x\nhttps://my-app-abc123-me.vercel.app\n")).toBe(
      "https://my-app-abc123-me.vercel.app",
    );
    const deployment = JSON.stringify({
      alias: ["my-app-me.vercel.app", "my-app-git-main-me.vercel.app", "my-app-five.vercel.app", "my-app-abc123-me.vercel.app"],
    });
    expect(vercelProductionUrl(deployment, "https://my-app-abc123-me.vercel.app")).toBe("https://my-app-me.vercel.app");
    expect(vercelProductionUrl('{"alias":[]}', "https://x.vercel.app")).toBeNull();
  });

  it("writes a .vercelignore that keeps .env files out of the upload", () => {
    const ignore = vercelIgnoreSource("node_modules/\n.env*\n!.env.example\n");
    expect(ignore).toContain("node_modules/");
    expect(ignore.match(/^\.env\*$/gm)).toHaveLength(1);
    expect(ignoresEnvFiles(ignore)).toBe(true);
    expect(vercelIgnoreSource("node_modules/\n")).toContain(".env*\n!.env.example\n");
    expect(ignoresEnvFiles("node_modules\n")).toBe(false);
    expect(ignoresEnvFiles("/.env.*\n")).toBe(true);
  });

  it("never takes a localhost public URL from the env file", () => {
    const plan = planVariables({
      modules: { auth: "none", cache: "memory" },
      keys: [],
      url: "https://my-app.vercel.app",
      existing: {},
      envFile: { NEXT_PUBLIC_APP_URL: "http://localhost:3000", APP_URL: "https://app.example.com" },
      secret: () => "s",
      databases: {},
    });
    expect(plan.set.NEXT_PUBLIC_APP_URL).toBe("https://my-app.vercel.app");
    expect(plan.set.APP_URL).toBe("https://app.example.com");
  });
});

describe("Netlify", () => {
  it("names the site from the package", () => {
    expect(netlifySiteName("my_App")).toBe("my-app");
    expect(netlifySiteName("x".repeat(70))).toHaveLength(63);
    expect(netlifySiteName("---")).toBe("web");
  });

  it("reads the site, its URL and base directory, and the teams", () => {
    expect(parseNetlifySite('{"id":"s1","name":"my-app","ssl_url":"https://my-app.netlify.app/","build_settings":{"base":"apps/web"}}')).toEqual({
      id: "s1",
      name: "my-app",
      url: "https://my-app.netlify.app",
      base: "apps/web",
    });
    expect(parseNetlifySite('{"id":"s1","name":"my-app"}')).toMatchObject({ url: "https://my-app.netlify.app", base: null });
    expect(parseNetlifySite('{"code":404,"message":"Not Found"}')).toBeNull();
    expect(parseNetlifyAccounts('[{"slug":"me"},{"slug":"team"}]')).toEqual(["me", "team"]);
    expect(parseNetlifyAccounts("Not logged in")).toEqual([]);
  });

  it("writes an env file Netlify imports as it is", () => {
    expect(netlifyEnvFile({ DATABASE_URL: "postgresql://u:p@h/db?sslmode=require&x=1", EMAIL_FROM: "It's me <a@b.c>" })).toBe(
      "DATABASE_URL='postgresql://u:p@h/db?sslmode=require&x=1'\nEMAIL_FROM=\"It's me <a@b.c>\"\n",
    );
    expect(() => netlifyEnvFile({ KEY: "a\nb" })).toThrow(/line break/);
  });

  it("finds the URL in netlify deploy --json output after the build log", () => {
    const output = 'Building {site}\n{\n  "site_id": "s1",\n  "deploy_url": "https://abc--my-app.netlify.app",\n  "url": "https://my-app.netlify.app"\n}\n';
    expect(parseNetlifyDeploy(output)).toBe("https://my-app.netlify.app");
    expect(parseNetlifyDeploy("no json")).toBeNull();
  });
});

describe("Render", () => {
  it("builds from GitHub, GitLab, or Bitbucket remotes", () => {
    expect(renderRepoUrl("git@github.com:me/my-app.git")).toBe("https://github.com/me/my-app");
    expect(renderRepoUrl("https://github.com/me/my-app.git\n")).toBe("https://github.com/me/my-app");
    expect(renderRepoUrl("https://token@gitlab.com/group/sub/app")).toBe("https://gitlab.com/group/sub/app");
    expect(renderRepoUrl("ssh://git@bitbucket.org/me/app.git")).toBe("https://bitbucket.org/me/app");
    expect(renderRepoUrl("https://example.com/me/app.git")).toBeNull();
    expect(renderRepoUrl("")).toBeNull();
  });

  it("creates a Docker web service that migrates before each release", () => {
    const body = renderServiceBody({ name: "my-app", ownerId: "tea_1", repo: "https://github.com/me/my-app", branch: "main", values: { DATABASE_URL: "postgres://x" } });
    expect(body).toMatchObject({
      type: "web_service",
      name: "my-app",
      ownerId: "tea_1",
      repo: "https://github.com/me/my-app",
      branch: "main",
      serviceDetails: { runtime: "docker", plan: "starter", healthCheckPath: "/api/health", preDeployCommand: "node /app/migrate.mjs" },
      envVars: [{ key: "DATABASE_URL", value: "postgres://x" }],
    });
  });

  it("reads services, workspaces, and variables from Render's API", () => {
    const list = [
      { service: { id: "srv-2", name: "my-app-old", serviceDetails: { url: "https://my-app-old.onrender.com" } } },
      { service: { id: "srv-1", name: "my-app", serviceDetails: { url: "https://my-app-x1.onrender.com/" } } },
    ];
    expect(parseRenderService(list, "my-app")).toEqual({ id: "srv-1", name: "my-app", url: "https://my-app-x1.onrender.com" });
    expect(parseRenderService([], "my-app")).toBeNull();
    expect(parseRenderService({ service: { id: "srv-3", name: "new", serviceDetails: {} } })).toEqual({ id: "srv-3", name: "new", url: null });
    expect(parseRenderOwners([{ owner: { id: "tea_1", name: "Me" } }, { cursor: "x" }])).toEqual([{ id: "tea_1", name: "Me" }]);
    expect(parseRenderEnv([{ envVar: { key: "BETTER_AUTH_SECRET", value: "s" } }, { envVar: { key: "X" } }])).toEqual({ BETTER_AUTH_SECRET: "s", X: "(set)" });
    expect(parseRenderEnv(null)).toEqual({});
  });
});

describe("parseCliArgs deploy", () => {
  it("takes --env-file, for deploy only", () => {
    expect(parseCliArgs(["deploy", "--env-file", ".env.production"])).toMatchObject({
      command: { name: "deploy" },
      envFile: ".env.production",
    });
    expect(() => parseCliArgs(["my-app", "--env-file", "x"])).toThrow(/only apply to deploy/);
    expect(() => parseCliArgs(["deploy", "web"])).toThrow(/Usage: deploy/);
  });
});
