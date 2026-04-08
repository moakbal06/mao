# @moakbal/mao-cli

## 0.2.2

### Patch Changes

- Updated dependencies [5315e4e]
  - @moakbal/mao-web@0.2.2

## 0.2.1

### Patch Changes

- ac625c3: Fix startup onboarding and install reliability:
  - Repair npm global install startup path by improving package resolution and web package discovery hints.
  - Make `ao start` prerequisite installs explicit and interactive for required tools (`tmux`, `git`) with clearer fallback guidance.
  - Keep `ao spawn` preflight check-only for `tmux` (no implicit install).
  - Remove redundant agent runtime re-detection during config generation.

## 0.2.0

### Minor Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@moakbal/mao`. Made `@moakbal/mao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.

### Patch Changes

- Updated dependencies [3a650b0]
  - @moakbal/mao-core@0.2.0
  - @moakbal/mao-web@0.2.0
  - @moakbal/mao-plugin-agent-claude-code@0.2.0
  - @moakbal/mao-plugin-agent-aider@0.2.0
  - @moakbal/mao-plugin-agent-codex@0.2.0
  - @moakbal/mao-plugin-agent-opencode@0.2.0
  - @moakbal/mao-plugin-notifier-composio@0.2.0
  - @moakbal/mao-plugin-notifier-desktop@0.2.0
  - @moakbal/mao-plugin-notifier-openclaw@0.1.1
  - @moakbal/mao-plugin-notifier-slack@0.2.0
  - @moakbal/mao-plugin-notifier-webhook@0.2.0
  - @moakbal/mao-plugin-runtime-process@0.2.0
  - @moakbal/mao-plugin-runtime-tmux@0.2.0
  - @moakbal/mao-plugin-scm-github@0.2.0
  - @moakbal/mao-plugin-terminal-iterm2@0.2.0
  - @moakbal/mao-plugin-terminal-web@0.2.0
  - @moakbal/mao-plugin-tracker-github@0.2.0
  - @moakbal/mao-plugin-tracker-linear@0.2.0
  - @moakbal/mao-plugin-workspace-clone@0.2.0
  - @moakbal/mao-plugin-workspace-worktree@0.2.0
