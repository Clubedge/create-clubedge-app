import { describe, expect, it } from "vitest";
import { updateEnvFile } from "../src/core/env.js";

const docker = [
  "APP_URL=http://localhost:3000",
  "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app",
  "REDIS_URL=redis://localhost:6379",
  "",
].join("\n");
const local = [
  "APP_URL=http://localhost:3000",
  "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres",
  "REDIS_URL=",
  "# Files go to this folder without S3.",
  "STORAGE_DIRECTORY=../../.data/storage",
  "",
].join("\n");

describe("updateEnvFile", () => {
  it("moves generated values to the target and appends new variables with their comments", () => {
    const result = updateEnvFile(`${docker}SECRET=mine\n`, docker, local);
    expect(result).toEqual({
      text: [
        "APP_URL=http://localhost:3000",
        "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres",
        "REDIS_URL=",
        "# Files go to this folder without S3.",
        "STORAGE_DIRECTORY=../../.data/storage",
        "SECRET=mine",
        "",
      ].join("\n"),
      added: ["STORAGE_DIRECTORY"],
      updated: ["DATABASE_URL", "REDIS_URL"],
      removed: [],
      customized: [],
      unused: [],
    });
  });

  it("moves the comment above an updated value along, unless the developer edited it", () => {
    const base = "# Docker database\nDATABASE_URL=postgres://docker\n";
    const target = "# PGlite database\nDATABASE_URL=postgres://pglite\n";
    expect(updateEnvFile(base, base, target).text).toBe(target);
    expect(updateEnvFile("# my note\nDATABASE_URL=postgres://docker\n", base, target).text).toBe(
      "# my note\nDATABASE_URL=postgres://pglite\n",
    );
  });

  it("adds a variable at the end when the one it follows is missing", () => {
    const result = updateEnvFile("OTHER=1\n", "A=1\n", "A=1\n# New\nB=2\n");
    expect(result.text).toBe("OTHER=1\n\n# New\nB=2\n");
  });

  it("keeps values the developer set and reports them", () => {
    const mine = docker.replace("redis://localhost:6379", "rediss://default:secret@upstash.io:6379");
    const result = updateEnvFile(mine, docker, local);
    expect(result.text).toContain("REDIS_URL=rediss://default:secret@upstash.io:6379");
    expect(result.updated).toEqual(["DATABASE_URL"]);
    expect(result.customized).toEqual(["REDIS_URL"]);
  });

  it("keeps CRLF line endings", () => {
    const result = updateEnvFile(docker.replaceAll("\n", "\r\n"), docker, local);
    expect(result.text).toContain("DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres\r\n");
    expect(result.text).not.toMatch(/[^\r]\n/);
  });

  it("never re-adds variables the developer removed", () => {
    const result = updateEnvFile("APP_URL=http://localhost:3000\n", local, docker);
    expect(result.added).toEqual([]);
    expect(result.text).toBe("APP_URL=http://localhost:3000\n");
  });

  it("removes unused variables at their generated values with their comments, and keeps the developer's", () => {
    const withServices = "DATABASE_URL=x\n\n# Redis cache\nREDIS_URL=\n\n# Storage\nSTORAGE_BUCKET=\n";
    const mine = "DATABASE_URL=x\n\n# Redis cache\nREDIS_URL=\n\n# Storage\nSTORAGE_BUCKET=mine\n";
    const result = updateEnvFile(mine, withServices, "DATABASE_URL=x\n");
    expect(result.removed).toEqual(["REDIS_URL"]);
    expect(result.unused).toEqual(["STORAGE_BUCKET"]);
    expect(result.text).toBe("DATABASE_URL=x\n\n# Storage\nSTORAGE_BUCKET=mine\n");
  });

  it("leaves no blank lines at the end after removing the last variables", () => {
    const result = updateEnvFile("A=1\n\n# Cache\nREDIS_URL=\n", "A=1\n\n# Cache\nREDIS_URL=\n", "A=1\n");
    expect(result.text).toBe("A=1\n");
  });
});
