# clarify — prompt rewriter for the OpenCode 2 TUI

Rewrite rough, plain-language prompts into precise technical prompts before
sending them to the model. A port of
[pi-clarify](https://github.com/dodo-reach/pi-clarify) by
[dodo-reach](https://github.com/dodo-reach) for the opencode2 TUI.

## Install

Copy `clarify.ts` into the TUI plugin directory:

```bash
mkdir -p ~/.config/opencode/plugins/tui
cp clarify.ts ~/.config/opencode/plugins/tui/
```

Restart opencode2 (or open a new session). The plugin auto-loads from
`plugins/tui/`.

## Usage

| Trigger | Effect |
| --- | --- |
| `/clarify <idea>` | Rewrite the idea (press Enter) |
| `/clarify` | Rewrite the rest of the prompt |
| `/clarify:model` | Pick a rewrite model (and variant) from a list |
| `/clarify:model <provider> <id>` | Pin a rewrite model |
| `/clarify:model reset` | Use the session model again |
| `... -clarify` | Marker anywhere in a message |
| "Clarify prompt" (command palette) | Rewrite the whole box content |

## Config (optional)

Create `<config-dir>/clarify.json`:

```json
{
  "provider": "<provider>",
  "model": "<model-id>",
  "variant": "<variant-id>"
}
```

When no config is set, the session model is used with its lowest-effort
variant when it has variants.

## Credits

Adapted from [pi-clarify](https://github.com/dodo-reach/pi-clarify) by
[dodo-reach](https://github.com/dodo-reach) (MIT). Original concept and prompt
system belong to its author; this version ports the behavior to the OpenCode 2
TUI plugin API.
