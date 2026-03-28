import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  statSync,
  watch,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import matter from "gray-matter";

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Find candidate files in the vault matching the filter criteria.
 * Uses grep for fast pre-filtering before parsing frontmatter.
 */
export function findCandidates(vaultPath, filter = {}) {
  const grepTerms = [];

  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === "boolean") {
      grepTerms.push(`${key}: ${value}`);
    } else {
      grepTerms.push(String(value));
    }
  }

  if (grepTerms.length === 0) {
    grepTerms.push("public: true");
  }

  try {
    // Start with first term
    let cmd = `grep -rl --null "${grepTerms[0]}" "${vaultPath}" --include="*.md" --include="*.mdx"`;

    // Chain additional terms
    for (let i = 1; i < grepTerms.length; i++) {
      cmd += ` | xargs -0 grep -l --null "${grepTerms[i]}"`;
    }

    // Final xargs outputs newline-separated
    cmd += ` | tr '\\0' '\\n'`;

    const result = execSync(cmd, { encoding: "utf-8" });
    return result.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Build a map of filename/title -> slug for resolving wiki-links.
 */
export function buildSlugMap(candidates) {
  const map = new Map();
  for (const filePath of candidates) {
    const raw = readFileSync(filePath, "utf-8");
    const { data } = matter(raw);
    const filename = basename(filePath).replace(/\.(mdx?)$/, "");
    const slug = data.slug ? slugify(data.slug) : slugify(data.title || filename);
    map.set(filename.toLowerCase(), slug);
    if (data.title) {
      map.set(data.title.toLowerCase(), slug);
    }
  }
  return map;
}

/**
 * Convert [[wiki-links]] to markdown links with slug resolution.
 */
export function normalizeWikiLinks(content, slugMap) {
  return content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_, target, display) => {
      const text = display || target;
      const slug = slugMap.get(target.toLowerCase()) || slugify(target);
      return `[${text}](/${slug})`;
    }
  );
}

/**
 * Copy referenced images from vault to media directory, rewriting paths.
 */
export function syncMedia(content, filePath, vaultPath, mediaDir) {
  const imageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let result = content;

  for (const [, imgPath] of content.matchAll(imageRegex)) {
    if (imgPath.startsWith("http://") || imgPath.startsWith("https://")) continue;

    let srcPath = resolve(dirname(filePath), imgPath);
    if (!existsSync(srcPath)) {
      srcPath = join(vaultPath, imgPath);
    }
    if (!existsSync(srcPath) || !statSync(srcPath).isFile()) continue;

    const relativePath = imgPath.startsWith("media/") ? imgPath.slice(6) : imgPath;
    const destPath = join(mediaDir, relativePath);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(srcPath, destPath);
    result = result.replaceAll(imgPath, `/media/${relativePath}`);
  }

  return result;
}

/**
 * Sync a single file from vault to content directory.
 * Returns the slug if synced, null if skipped.
 */
export function syncFile(filePath, vaultPath, slugMap, config) {
  const { contentDir, mediaDir, filter = {}, stripFields = [] } = config;

  const raw = readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);

  // Check frontmatter filter
  if (data.public !== true) return null;

  // Check project filter if specified
  if (filter.project) {
    const project = String(data.project || "");
    if (!project.includes(filter.project)) return null;
  }

  const ext = filePath.endsWith(".mdx") ? ".mdx" : ".md";
  const slug = data.slug
    ? slugify(data.slug)
    : slugify(data.title || basename(filePath).replace(/\.(mdx?)$/, ""));

  // Strip internal fields from frontmatter
  const fieldsToStrip = ["public", "project", "slug", ...stripFields];
  const cleanData = { ...data };
  for (const field of fieldsToStrip) {
    delete cleanData[field];
  }

  // Add last modified date
  cleanData.updated = statSync(filePath).mtime.toISOString();

  let normalizedContent = normalizeWikiLinks(content, slugMap);
  normalizedContent = syncMedia(normalizedContent, filePath, vaultPath, mediaDir);
  const output = matter.stringify(normalizedContent, cleanData);

  const outPath = join(contentDir, `${slug}${ext}`);
  writeFileSync(outPath, output);

  return slug;
}

/**
 * Run a full sync from vault to content directory.
 */
export function sync(config) {
  const { vaultPath, contentDir, filter = {} } = config;

  if (!existsSync(contentDir)) {
    mkdirSync(contentDir, { recursive: true });
  }

  console.log(`Scanning ${vaultPath}...`);

  // Build grep terms from filter
  const grepFilter = {};
  if (filter.public !== false) grepFilter["public"] = true;
  if (filter.project) grepFilter["project"] = filter.project;

  const candidates = findCandidates(vaultPath, grepFilter);
  console.log(`Found ${candidates.length} candidate(s)`);

  const slugMap = buildSlugMap(candidates);

  let synced = 0;
  for (const filePath of candidates) {
    const slug = syncFile(filePath, vaultPath, slugMap, config);
    if (slug) {
      console.log(`  synced: ${slug}`);
      synced++;
    }
  }

  console.log(`Done. ${synced} file(s) synced to ${contentDir}`);
  return candidates;
}

/**
 * Watch vault for changes and re-sync on modification.
 */
export function startWatch(config) {
  const { vaultPath, filter = {} } = config;
  console.log(`\nWatching vault for changes...`);

  let debounce = null;

  const grepFilter = {};
  if (filter.public !== false) grepFilter["public"] = true;
  if (filter.project) grepFilter["project"] = filter.project;

  watch(vaultPath, { recursive: true }, (eventType, filename) => {
    if (!filename || !(filename.endsWith(".md") || filename.endsWith(".mdx")))
      return;

    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const filePath = join(vaultPath, filename);
      if (!existsSync(filePath)) return;

      const candidates = findCandidates(vaultPath, grepFilter);
      const slugMap = buildSlugMap(candidates);
      const slug = syncFile(filePath, vaultPath, slugMap, config);
      if (slug) {
        console.log(
          `  ${eventType === "rename" ? "new" : "updated"}: ${slug}`
        );
      }
    }, 300);
  });
}

/**
 * Load config from a JSON file, merging with defaults.
 */
export function loadConfig(configPath, overrides = {}) {
  let fileConfig = {};
  if (configPath && existsSync(configPath)) {
    fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  const merged = { ...fileConfig, ...overrides };

  // Resolve vault path from config, env, or CLI arg
  const vaultPath = merged.vaultPath || process.env.OBSIDIAN_VAULT;
  if (!vaultPath) {
    throw new Error(
      "Vault path required. Set OBSIDIAN_VAULT env var, pass --vault, or add vaultPath to hyalite-sync.json config."
    );
  }

  const cwd = configPath ? dirname(resolve(configPath)) : process.cwd();

  return {
    vaultPath: resolve(vaultPath),
    contentDir: resolve(cwd, merged.contentDir || "./content"),
    mediaDir: resolve(cwd, merged.mediaDir || "./public/media"),
    filter: merged.filter || {},
    stripFields: merged.stripFields || [],
  };
}
