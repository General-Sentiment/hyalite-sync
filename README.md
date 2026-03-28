# obsidian-content-sync

Sync content from an Obsidian vault to a static site content directory. Filters notes by frontmatter (e.g. `public: true`), converts `[[wiki-links]]` to markdown links, and copies referenced images.

## Install

```bash
npm install obsidian-content-sync
```

Or use directly with npx:

```bash
npx obsidian-content-sync --vault ~/my-vault
```

## Usage

```bash
obsidian-content-sync [options] [vault-path]
```

### Options

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Path to config JSON file (default: `./obsidian-sync.json`) |
| `--vault <path>` | Obsidian vault path (or set `OBSIDIAN_VAULT` env var) |
| `--content-dir <path>` | Output directory for content files (default: `./content`) |
| `--media-dir <path>` | Output directory for media files (default: `./public/media`) |
| `-w, --watch` | Watch vault for changes and re-sync automatically |
| `-h, --help` | Show help |

### Config file

Create an `obsidian-sync.json` in your project root:

```json
{
  "vaultPath": "/path/to/vault",
  "contentDir": "./content",
  "mediaDir": "./public/media",
  "filter": {
    "project": "My Project"
  },
  "stripFields": ["draft"]
}
```

The vault path can also be set via the `OBSIDIAN_VAULT` environment variable or a `.env.local` file.

## How it works

1. **Finds candidates** -- Uses `grep` to quickly find `.md`/`.mdx` files in your vault matching the filter criteria (defaults to `public: true` in frontmatter).

2. **Resolves wiki-links** -- Builds a slug map from all candidate files and converts `[[wiki-links]]` and `[[target|display text]]` to standard markdown links with correct slugs.

3. **Syncs media** -- Copies locally-referenced images to the media output directory and rewrites paths to `/media/...`.

4. **Writes output** -- Saves processed files to the content directory using the slug as the filename.

## Programmatic API

```js
import { sync, startWatch, loadConfig } from "obsidian-content-sync";

const config = loadConfig("./obsidian-sync.json");
sync(config);

// Optionally watch for changes
startWatch(config);
```

## Requirements

- Node.js >= 18
- `grep` available on the system PATH

## License

MIT
