# ADR-0003: Installable role packs

- Status: Accepted

## Context

Projects need reusable custom subagent roles without copying them into every repository. The extension itself no longer ships built-in roles.

## Decision

Discover role files from three sources, in this order:

1. project `.pi/agents`;
2. global Pi agent directories;
3. installable packages that contribute agent directories through `pi-herdr-subagents:roles:discover:v1`.

Project roles override global roles. Global roles override package roles. If two packages contribute the same role name, discovery reports a collision instead of choosing by package order.

A role is a Markdown file with frontmatter and an optional prompt body. Role frontmatter may own model, thinking, tools, skills, cwd, session mode, prompt mode, and interaction defaults. Legacy roles that request an external CLI fail closed before Herdr creates resources.

The runtime does not scan arbitrary `node_modules` folders. Installed packages register their directories through the discovery event.

## Consequences

- Role packs are reusable and explicit.
- Local policy can override package defaults.
- Package collisions are visible and deterministic.
- There is no protected built-in namespace.
- Role packs contribute roles only; they do not add commands or executable workflow engines.
