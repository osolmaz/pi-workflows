---
title: Bundle Pi Workflows skills with the extension
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-17
---

# Bundle Pi Workflows skills with the extension

Pi Workflows should be the single source of truth for instructions that teach an agent how to use its extension and built-in workflows. Installing the Pi package should discover those skills with the extension, while Pi's normal package filters let users disable either resource type or an individual skill.

## Outcome

The npm package will include two optional Pi skills:

- `pi-workflows` explains when and how to use the `workflow` tool, control runs, complete step contracts, publish progress, and author workflow files.
- `monitor` starts and operates the built-in monitor workflow with the established 30-minute default, inferred finish rule, status report on every check, and structured progress guidance.

The existing monitor skill in `osolmaz/tools` will move here and be removed from that repository. OnurPi will expose the upstream extension and skills from one reviewed package version.

## Scope

- Add stable skill paths under `skills/`.
- Declare both the extension and skills in the Pi package manifest.
- Include the skill files in npm artifacts.
- Document bundled resources and independent disable controls.
- Add automated checks for manifest paths, skill metadata, package contents, and duplicate skill names.
- Test discovery from a packed package with the real Pi runtime.
- Release the compatible feature as `0.7.0`, following the repository's pre-1.0 minor-release convention.
- Update the OnurPi pin and package resource forwarding.
- Delete the Tools copy and sync local skill mirrors so no duplicate remains.

## Non-goals

- Do not add a new workflow node, workflow schema field, or Pi core API.
- Do not load skills only while a workflow step is active.
- Do not create a general workflow-to-skill attachment system.
- Do not copy unrelated operating-policy skills such as `autoimplement` or `autoresearch-loop`.

## Public contract

The package uses Pi's documented package resource contract:

- `pi.extensions` exposes the existing extension.
- `pi.skills` exposes `skills/`.
- Pi package filters and `pi config` can disable all skills, one skill, or the extension independently.

The `workflow` tool description remains the small always-available call contract. The `pi-workflows` skill contains detailed guidance that Pi loads only when a matching task requires it. Workflow step messages remain compact and authoritative for `submit` and `update` attempt identifiers.

## Contract impact

- **Session state:** no new session entry or change to normal Pi session behavior.
- **Other persistent data:** none.
- **Pi internals:** none.
- **Public Pi API:** package `pi.skills` discovery and existing package resource filters. The extension continues to use its current public APIs.

## Implementation

1. Add `skills/pi-workflows/SKILL.md` with concise tool and authoring guidance linked to the bundled reference docs.
2. Move the current monitor skill to `skills/monitor/SKILL.md` and align repository-relative references with the package layout.
3. Add `skills` to the npm package files and Pi manifest.
4. Add tests that validate declared paths, required frontmatter, unique skill names, and packed files.
5. Update README installation and configuration examples, including independent resource filtering.
6. Pack the package and start the real Pi runtime from that artifact. Verify that `/skill:pi-workflows` and `/skill:monitor` are discovered with the extension, then verify that package filtering can hide the monitor skill without hiding the extension.
7. Run all repository checks and Pi Reviewer, merge, release `0.7.0`, and verify npm contents.
8. Pin `0.7.0` in OnurPi, forward the dependency's skills, and run OnurPi checks.
9. Remove `agents/skills/monitor` from Tools, run the sync script, and verify that the installed skill now comes from the Pi Workflows package only.

## Acceptance criteria

- A direct Pi installation of `@osolmaz/pi-workflows` discovers the extension and both skills.
- The OnurPi wrapper discovers the same two upstream skills.
- Users can disable bundled skills or the extension with standard Pi package settings.
- The model can use the `workflow` tool from the new skill without larger workflow step messages.
- npm contains the two `SKILL.md` files and their referenced documentation.
- Tools contains no monitor skill source or synced duplicate.
- Local checks, real-Pi end-to-end tests, Pi Reviewer, and CI pass.

## Verification

Run in `pi-workflows`:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
npx -y @simpledoc/simpledoc check
npm pack --dry-run
```

Run the packed-package Pi discovery smoke test documented by the implementation, then run in OnurPi:

```bash
npm run check
npm run slophammer
git diff --check
```

Run in Tools after deletion:

```bash
python3 agents/sync-skills.py monitor
npx -y @simpledoc/simpledoc check
```
