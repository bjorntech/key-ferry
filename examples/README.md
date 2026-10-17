# Configuration examples

These examples use the public package name `@bjorntech/key-ferry` and synthetic
values only. They do not start an MCP server or contact a provider.

## Primary setup: global plugin plus project MCPs

Use the `global/` and `project/` pair when installing Key Ferry once in the
user's global OpenCode configuration:

1. Copy `global/opencode.json` into the user's native global configuration at
   `~/.config/opencode/opencode.json` (a generic public user-home path, not a
   repository-specific path). Keep unrelated settings. Set its
   `projectDirectory` to the absolute path of the Varlock root chosen for the
   global key set, and copy `global/.env.schema` there.
2. Copy `project/opencode.json` to the project root as the native
   `opencode.json`, and copy `project/.env.schema` to the separate project
   Varlock root selected for `PROJECT_API_KEY`.
3. Copy `project/.opencode/key-ferry.jsonc` to the project at that path. It
   maps the project's existing MCP name to its project key; it is not another
   plugin entry.

The global and project schemas and mappings are separate key sets. The native
project file defines MCPs only, while the global file installs the plugin and
its global MCP definition. The `global-mcp` and `project-mcp` names match the
maps in their corresponding files. The sample commands are placeholders and
must be replaced with real local commands before use. For remote servers,
keep the server's URL and proxy decorators aligned; this example does not
wire a remote backend automatically.

The global `projectDirectory` placeholder is intentionally generic. Replace it
with an absolute path selected by the user; do not commit a real local path or
credential.

## Alternative: one intentionally project-configured plugin

`single-project/` is the supported legacy flat setup. Copy its native
`opencode.json` and `.env.schema` together into one project root. Use this
alternative only when intentionally configuring the plugin in that project;
do not combine it with an existing globally configured Key Ferry mapping,
because host plugin options replace one another. It is an alternative to the
primary global-plus-project pair, not an additional layer.

Both native `opencode.json` files are strict JSON for ordinary editors. The
Key Ferry project mapping remains JSONC because its loader supports comments;
its filename is intentionally `key-ferry.jsonc`. `.env.schema` comments are
Varlock semantic decorators and must remain intact.
