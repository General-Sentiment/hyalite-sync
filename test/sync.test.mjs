import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  slugify,
  findCandidates,
  buildSlugMap,
  normalizeWikiLinks,
  syncMedia,
  syncFile,
  sync,
  loadConfig,
} from "../src/index.mjs";

// ── slugify ──────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  it("strips non-word characters", () => {
    assert.equal(slugify("What's up?"), "whats-up");
  });

  it("collapses multiple hyphens", () => {
    assert.equal(slugify("a -- b --- c"), "a-b-c");
  });

  it("trims leading and trailing hyphens", () => {
    assert.equal(slugify("--hello--"), "hello");
  });

  it("handles underscores", () => {
    assert.equal(slugify("snake_case"), "snake_case");
  });

  it("returns empty string for empty input", () => {
    assert.equal(slugify(""), "");
  });
});

// ── normalizeWikiLinks ───────────────────────────────────────

describe("normalizeWikiLinks", () => {
  const slugMap = new Map([
    ["some note", "some-note"],
    ["another page", "another-page"],
  ]);

  it("converts basic wiki-link", () => {
    const result = normalizeWikiLinks("See [[Some Note]] for details", slugMap);
    assert.equal(result, "See [Some Note](/some-note) for details");
  });

  it("converts wiki-link with display text", () => {
    const result = normalizeWikiLinks("See [[Another Page|click here]]", slugMap);
    assert.equal(result, "See [click here](/another-page)");
  });

  it("falls back to slugified target when not in map", () => {
    const result = normalizeWikiLinks("See [[Unknown Page]]", slugMap);
    assert.equal(result, "See [Unknown Page](/unknown-page)");
  });

  it("handles multiple wiki-links in one line", () => {
    const result = normalizeWikiLinks("[[Some Note]] and [[Another Page]]", slugMap);
    assert.equal(result, "[Some Note](/some-note) and [Another Page](/another-page)");
  });
});

// ── findCandidates ───────────────────────────────────────────

describe("findCandidates", () => {
  let vaultDir;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(
      join(vaultDir, "public-note.md"),
      "---\ntitle: Public\npublic: true\n---\nHello"
    );
    writeFileSync(
      join(vaultDir, "private-note.md"),
      "---\ntitle: Private\npublic: false\n---\nSecret"
    );
    writeFileSync(
      join(vaultDir, "no-frontmatter.md"),
      "Just some text"
    );
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true });
  });

  it("finds files with public: true", () => {
    const results = findCandidates(vaultDir, { public: true });
    assert.equal(results.length, 1);
    assert.ok(results[0].includes("public-note.md"));
  });

  it("returns empty array when no matches", () => {
    const results = findCandidates(vaultDir, { project: "nonexistent" });
    assert.equal(results.length, 0);
  });
});

// ── buildSlugMap ─────────────────────────────────────────────

describe("buildSlugMap", () => {
  let vaultDir;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), "vault-"));
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true });
  });

  it("maps filename and title to slug", () => {
    const filePath = join(vaultDir, "My Note.md");
    writeFileSync(filePath, "---\ntitle: My Great Note\n---\nContent");

    const map = buildSlugMap([filePath]);
    assert.equal(map.get("my note"), "my-great-note");
    assert.equal(map.get("my great note"), "my-great-note");
  });

  it("prefers slug field over title", () => {
    const filePath = join(vaultDir, "note.md");
    writeFileSync(filePath, "---\ntitle: My Title\nslug: custom-slug\n---\nContent");

    const map = buildSlugMap([filePath]);
    assert.equal(map.get("note"), "custom-slug");
  });

  it("falls back to filename when no title", () => {
    const filePath = join(vaultDir, "some-file.md");
    writeFileSync(filePath, "---\npublic: true\n---\nContent");

    const map = buildSlugMap([filePath]);
    assert.equal(map.get("some-file"), "some-file");
  });
});

// ── syncFile ─────────────────────────────────────────────────

describe("syncFile", () => {
  let vaultDir, contentDir, mediaDir;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), "vault-"));
    contentDir = mkdtempSync(join(tmpdir(), "content-"));
    mediaDir = mkdtempSync(join(tmpdir(), "media-"));
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true });
    rmSync(contentDir, { recursive: true });
    rmSync(mediaDir, { recursive: true });
  });

  it("syncs a public file and returns slug", () => {
    const filePath = join(vaultDir, "note.md");
    writeFileSync(filePath, "---\ntitle: Test Note\npublic: true\n---\nHello world");

    const slug = syncFile(filePath, vaultDir, new Map(), {
      contentDir,
      mediaDir,
    });

    assert.equal(slug, "test-note");
    assert.ok(existsSync(join(contentDir, "test-note.md")));
  });

  it("returns null for non-public files", () => {
    const filePath = join(vaultDir, "note.md");
    writeFileSync(filePath, "---\ntitle: Private\npublic: false\n---\nSecret");

    const slug = syncFile(filePath, vaultDir, new Map(), {
      contentDir,
      mediaDir,
    });

    assert.equal(slug, null);
  });

  it("strips configured fields from output frontmatter", () => {
    const filePath = join(vaultDir, "note.md");
    writeFileSync(
      filePath,
      "---\ntitle: Note\npublic: true\ndraft: true\n---\nContent"
    );

    syncFile(filePath, vaultDir, new Map(), {
      contentDir,
      mediaDir,
      stripFields: ["draft"],
    });

    const output = readFileSync(join(contentDir, "note.md"), "utf-8");
    assert.ok(!output.includes("draft:"));
    assert.ok(!output.includes("public:"));
    assert.ok(output.includes("title:"));
  });

  it("resolves wiki-links in content", () => {
    const filePath = join(vaultDir, "note.md");
    writeFileSync(filePath, "---\ntitle: Note\npublic: true\n---\nSee [[Other]]");

    const slugMap = new Map([["other", "other-page"]]);
    syncFile(filePath, vaultDir, slugMap, { contentDir, mediaDir });

    const output = readFileSync(join(contentDir, "note.md"), "utf-8");
    assert.ok(output.includes("[Other](/other-page)"));
  });
});

// ── sync (full pipeline) ────────────────────────────────────

describe("sync", () => {
  let vaultDir, contentDir, mediaDir;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), "vault-"));
    contentDir = mkdtempSync(join(tmpdir(), "content-"));
    mediaDir = mkdtempSync(join(tmpdir(), "media-"));
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true });
    rmSync(contentDir, { recursive: true });
    rmSync(mediaDir, { recursive: true });
  });

  it("syncs all public files from vault", () => {
    writeFileSync(
      join(vaultDir, "a.md"),
      "---\ntitle: Alpha\npublic: true\n---\nFirst"
    );
    writeFileSync(
      join(vaultDir, "b.md"),
      "---\ntitle: Beta\npublic: true\n---\nSecond"
    );
    writeFileSync(
      join(vaultDir, "c.md"),
      "---\ntitle: Gamma\npublic: false\n---\nThird"
    );

    sync({ vaultPath: vaultDir, contentDir, mediaDir });

    assert.ok(existsSync(join(contentDir, "alpha.md")));
    assert.ok(existsSync(join(contentDir, "beta.md")));
    assert.ok(!existsSync(join(contentDir, "gamma.md")));
  });
});

// ── loadConfig ───────────────────────────────────────────────

describe("loadConfig", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("loads config from a JSON file", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ vaultPath: "/tmp/vault", contentDir: "./out" })
    );

    const config = loadConfig(configPath);
    assert.equal(config.vaultPath, "/tmp/vault");
    assert.ok(config.contentDir.endsWith("out"));
  });

  it("throws when no vault path is provided", () => {
    const origEnv = process.env.OBSIDIAN_VAULT;
    delete process.env.OBSIDIAN_VAULT;

    assert.throws(() => loadConfig(null, {}), /Vault path required/);

    if (origEnv) process.env.OBSIDIAN_VAULT = origEnv;
  });

  it("merges overrides with file config", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ vaultPath: "/tmp/vault", contentDir: "./original" })
    );

    const config = loadConfig(configPath, { contentDir: "./override" });
    assert.ok(config.contentDir.endsWith("override"));
  });
});
