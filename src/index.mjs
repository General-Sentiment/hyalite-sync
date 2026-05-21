import { execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  statSync,
  readdirSync,
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
 * Skips fenced code blocks so embedded link-like syntax is preserved verbatim.
 */
export function normalizeWikiLinks(content, slugMap) {
  const parts = content.split(/(^```[^\n]*\n[\s\S]*?\n```\s*$)/gm);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(
        /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (_, target, display) => {
          const text = display || target;
          const slug = slugMap.get(target.toLowerCase()) || slugify(target);
          return `[${text}](/${slug})`;
        }
      );
    })
    .join("");
}

const MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif",
  ".mp4", ".webm", ".ogv", ".mov",
  ".mp3", ".ogg", ".wav", ".flac",
  ".pdf",
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogv", ".mov"]);

function fileExt(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function isMediaFile(name) {
  return MEDIA_EXTENSIONS.has(fileExt(name));
}

function isVideoFile(name) {
  return VIDEO_EXTENSIONS.has(fileExt(name));
}

/**
 * Map a resolved source path to a path under mediaDir, preserving the vault's
 * directory structure. A leading "media/" prefix is stripped so the vault's
 * media/ folder lines up with the site's public/media/ folder.
 */
function mediaRelativePath(srcPath, vaultPath) {
  let rel = resolve(srcPath);
  const vault = resolve(vaultPath);
  if (rel.startsWith(vault + "/")) rel = rel.slice(vault.length + 1);
  else rel = basename(srcPath);
  if (rel.startsWith("media/")) rel = rel.slice(6);
  return rel;
}

const vaultMediaIndexCache = new Map();

/**
 * Index all media files in the vault by basename so wiki-links like
 * [[photo.jpg]] resolve no matter where the file lives (mirrors Obsidian's
 * default resolution).
 */
function getVaultMediaIndex(vaultPath) {
  const cached = vaultMediaIndexCache.get(vaultPath);
  if (cached) return cached;

  const index = new Map();
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isMediaFile(entry.name)) {
        const key = entry.name.toLowerCase();
        if (!index.has(key)) index.set(key, full);
      }
    }
  }
  walk(vaultPath);
  vaultMediaIndexCache.set(vaultPath, index);
  return index;
}

/**
 * Resolve a wiki-link target to a media file in the vault.
 * Tries (1) the file's directory, (2) the vault root, (3) a basename match
 * anywhere in the vault. Returns the resolved source path, or null.
 */
function findMediaInVault(target, filePath, vaultPath) {
  // Try relative to the file first
  let srcPath = resolve(dirname(filePath), target);
  if (existsSync(srcPath) && statSync(srcPath).isFile()) return srcPath;

  // Try vault root
  srcPath = join(vaultPath, target);
  if (existsSync(srcPath) && statSync(srcPath).isFile()) return srcPath;

  // Fall back to vault-wide basename lookup
  const index = getVaultMediaIndex(vaultPath);
  const hit = index.get(basename(target).toLowerCase());
  if (hit) return hit;

  return null;
}

/**
 * Resolve wiki-links in frontmatter values.
 * Media wiki-links are copied and rewritten to /media/ paths.
 * Non-media wiki-links are resolved via the slug map.
 */
export function resolveFrontmatterWikiLinks(data, slugMap, filePath, vaultPath, mediaDir) {
  const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

  function resolveValue(value) {
    if (typeof value === "string") {
      return value.replace(wikiLinkRegex, (_, target, display) => {
        if (isMediaFile(target)) {
          const srcPath = findMediaInVault(target, filePath, vaultPath);
          if (srcPath) {
            const relativePath = mediaRelativePath(srcPath, vaultPath);
            const destPath = join(mediaDir, relativePath);
            mkdirSync(dirname(destPath), { recursive: true });
            copyFileSync(srcPath, destPath);
            return `/media/${relativePath}`;
          }
        }
        // Non-media: resolve as page link
        const slug = slugMap.get(target.toLowerCase()) || slugify(target);
        return `/${slug}`;
      });
    }
    if (Array.isArray(value)) {
      return value.map(resolveValue);
    }
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const result = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = resolveValue(v);
      }
      return result;
    }
    return value;
  }

  const resolved = {};
  for (const [key, value] of Object.entries(data)) {
    resolved[key] = resolveValue(value);
  }
  return resolved;
}

/**
 * Resolve wiki-links inside ```slider fenced blocks to media files.
 * Each non-empty line in the block is treated as a single [[file]] reference;
 * matched files are copied into mediaDir and the line is rewritten to a
 * /media/... path so downstream rendering doesn't need wiki-link awareness.
 */
export function syncSliderMedia(content, filePath, vaultPath, mediaDir) {
  const fence = /^```slider[^\n]*\n([\s\S]*?)\n```\s*$/gm;
  // Accept bare [[file]] or Obsidian embed prefixes like ![[file]] / !S[[file]].
  const wikiLink = /(?:!\w*)?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  return content.replace(fence, (_match, body) => {
    const rewritten = body.replace(wikiLink, (whole, target) => {
      const srcPath = findMediaInVault(target, filePath, vaultPath);
      if (!srcPath) return whole;
      const relativePath = mediaRelativePath(srcPath, vaultPath);
      const destPath = join(mediaDir, relativePath);
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      return `/media/${relativePath}`;
    });
    return "```slider\n" + rewritten + "\n```";
  });
}

/**
 * Resolve Obsidian-style media embeds (![[file.ext]], including size hints
 * like !S[[file.ext]]) anywhere in the body. Images become markdown image
 * links; videos become <figure class="video"><video …></figure> raw HTML.
 * Fenced code blocks are skipped so slider blocks (already rewritten) and
 * literal samples are left alone.
 */
export function syncEmbedMedia(content, filePath, vaultPath, mediaDir) {
  const embedRe = /!\w*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const parts = content.split(/(^```[^\n]*\n[\s\S]*?\n```\s*$)/gm);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(embedRe, (whole, target, display) => {
        if (!isMediaFile(target)) return whole;
        const srcPath = findMediaInVault(target, filePath, vaultPath);
        if (!srcPath) return whole;
        const relativePath = mediaRelativePath(srcPath, vaultPath);
        const destPath = join(mediaDir, relativePath);
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(srcPath, destPath);
        const mediaUrl = `/media/${relativePath}`;
        if (isVideoFile(target)) {
          return `<figure class="video"><video src="${mediaUrl}" autoplay muted loop playsinline></video></figure>`;
        }
        const alt = display && !/^\d+$/.test(display.trim()) ? display.trim() : "";
        return `![${alt}](${mediaUrl})`;
      });
    })
    .join("");
}

/**
 * Copy referenced images from vault to media directory, rewriting paths.
 */
export function syncMedia(content, filePath, vaultPath, mediaDir) {
  const imageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let result = content;

  for (const [, imgPath] of content.matchAll(imageRegex)) {
    if (imgPath.startsWith("http://") || imgPath.startsWith("https://")) continue;
    // Skip absolute web paths — they're already pointing at synced media.
    if (imgPath.startsWith("/")) continue;

    let srcPath = resolve(dirname(filePath), imgPath);
    if (!existsSync(srcPath)) {
      srcPath = join(vaultPath, imgPath);
    }
    if (!existsSync(srcPath) || !statSync(srcPath).isFile()) continue;

    const relativePath = mediaRelativePath(srcPath, vaultPath);
    const destPath = join(mediaDir, relativePath);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(srcPath, destPath);
    result = result.replaceAll(imgPath, `/media/${relativePath}`);
  }

  return result;
}

const COMPUTED_SOURCES = {
  "file.mtime": (stat) => stat.mtime.toISOString(),
  "file.birthtime": (stat) => stat.birthtime.toISOString(),
  "file.size": (stat) => stat.size,
  slug: (_stat, ctx) => ctx.slug,
  filepath: (_stat, ctx) => ctx.filePath,
};

function resolveComputedField(source, fileStat, ctx) {
  const resolver = COMPUTED_SOURCES[source];
  if (resolver) return resolver(fileStat, ctx);
  // Treat as a literal value
  return source;
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

  // Add computed fields from config
  const { computedFields = {} } = config;
  const fileStat = Object.keys(computedFields).length > 0 ? statSync(filePath) : null;
  for (const [field, source] of Object.entries(computedFields)) {
    cleanData[field] = resolveComputedField(source, fileStat, { slug, filePath });
  }

  // Resolve wiki-links in frontmatter values
  const resolvedData = resolveFrontmatterWikiLinks(cleanData, slugMap, filePath, vaultPath, mediaDir);

  let normalizedContent = syncSliderMedia(content, filePath, vaultPath, mediaDir);
  normalizedContent = syncEmbedMedia(normalizedContent, filePath, vaultPath, mediaDir);
  normalizedContent = normalizeWikiLinks(normalizedContent, slugMap);
  normalizedContent = syncMedia(normalizedContent, filePath, vaultPath, mediaDir);
  const output = matter.stringify(normalizedContent, resolvedData);

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
    computedFields: merged.computedFields || {},
  };
}
