---
title: Test installed workflows end to end
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-09-02
---

# Test installed workflows end to end

## Goal

Add one black-box test runner that starts base Pi with only the packed Pi Workflows package. The runner will execute a workflow through the package-owned host and check Pi's workflow widget throughout its lifecycle. It will also check the Rust `piw` client. A separate phase can use a real model.

The runner must keep the Pi provider and model as separate exact values. It must work with Pi's built-in providers instead of containing OpenAI-specific model logic.

## Provider boundary

Pi has two distinct OpenAI providers.

- `openai-codex` uses ChatGPT Plus or Pro subscription credentials. Its GPT-5.6 models use the `openai-codex-responses` API against the ChatGPT backend.
- `openai` uses an OpenAI API key. Its GPT-5.6 models use the `openai-responses` API against `api.openai.com`.

The current base Pi catalog includes `gpt-5.6-luna` under both providers. These are separate provider and model pairs:

```text
provider=openai-codex model=gpt-5.6-luna
provider=openai       model=gpt-5.6-luna
```

The runner will require both `--provider` and `--model` for a real-model run. It will pass them to Pi as separate arguments and then query Pi's RPC state. The selected provider and model id must match the request. The selected API must match that exact pair. The runner will never accept Pi's model fallback.

Any built-in Pi provider can be used when its normal authentication is ready and its selected model can call tools. The runner will not write a `models.json` file or register a custom provider.

## Base Pi and resource isolation

The runner will invoke the `@earendil-works/pi-coding-agent` package entry point directly. It will not invoke the `pi` command found in `PATH`, because that command can be a wrapper that adds personal packages or restart behavior.

The default entry point will come from the repository's pinned Pi dependency. An optional `--pi-entry` argument will allow a pre-release check against another installed base Pi version.

Each run will use:

- one temporary home directory;
- one temporary project;
- one temporary session directory;
- one temporary package installation;
- either a temporary Pi agent directory or a dedicated user-supplied test profile.

Pi will start with `--no-skills`, `--no-themes`, `--no-prompt-templates`, `--no-context-files`, and `--no-builtin-tools`. The runner must not use `--no-extensions`, because that would also disable Pi Workflows.

After startup, the runner will call RPC `get_commands`. The `workflow`, `controller`, and `piw` commands must come from the packed Pi Workflows package. Any other user or project extension is a failure. Base Pi's own inline commands are allowed.

## Installed package test

The test must use the npm package that would be published, including its file allowlist and production dependencies.

The runner will:

1. Run `npm pack` into the temporary root.
2. Install that archive into a temporary consumer project with `npm install --omit=dev`.
3. Find the resulting `@osolmaz/pi-workflows` package directory.
4. Run base Pi's `install` command against that installed directory.
5. Start Pi and verify the extension command source paths point into that directory.

Passing the `.tgz` file directly to `pi install` is not valid. Pi treats that file as an extension path. Pointing Pi at an extracted package before its dependencies are installed also fails because `better-sqlite3` is absent. The temporary consumer installation avoids both errors and tests the same dependency layout as a normal npm install.

## Authentication

The runner will let base Pi resolve credentials through Pi's documented authentication rules. It will not read, print, copy, or rewrite credential values.

### Subscription profile

A subscription run will use a dedicated Pi test profile supplied with `--profile`. The operator logs in to that profile once with base Pi. For ChatGPT Plus or Pro, the requested provider is `openai-codex`.

The profile must be dedicated to this smoke test. The runtime resource check will reject unrelated extensions. The run uses a temporary home and temporary workflow state. Its session directory is also temporary even when the profile is reused for OAuth credentials.

### API key

An API-key run can use an ephemeral agent directory. Pi receives the caller's existing environment and resolves the provider's normal variable, such as `OPENAI_API_KEY` for the `openai` provider. The runner will not name, inspect, or log the variable value.

Before a model call, the runner will execute Pi's documented `auth check` command for the exact provider and model. It will stop before the workflow starts when authentication or model resolution fails.

## Startup recovery

Before Pi starts, the runner creates an incompatible state fixture inside the guarded temporary home. It then starts Pi and waits for the extension's one bounded host-unavailable warning. The runner moves the fixture intact, as the alpha reset instruction requires, and starts the host through the installed client.

The same Pi process must establish its origin-session subscription without a restart. An observer subscription verifies that the host has a coordinator epoch for that session. More polling must not produce a second host-unavailable warning. The normal runtime workflow then proves that the recovered session receives live widget updates.

This check reproduces the case where Pi starts before the host can open durable state. It changes no operator database or Pi session.

## Runtime workflow

The first workflow does not call a model. It has one delayed compute step and a fixed final output.

The runner will start it through Pi RPC and check the following sequence:

1. The package-owned host starts on demand.
2. RPC emits `setWidget` and `setStatus` for the `pi-workflows` key with `running` state.
3. `/workflow pause` is accepted.
4. The widget and status change to `paused`.
5. Server status reports one parked run and no active workflow runner.
6. `/workflow resume` is accepted.
7. The widget and status return to `running`.
8. The workflow completes with the fixed output.
9. RPC clears the widget and status after completion.
10. No `extension_error` event appears.

This run proves package loading and client-to-host startup. It also proves supervised worker control and the RPC widget contract. The complete check uses no model usage.

## Real-model workflow

The second workflow has one structured agent step. Its prompt asks the selected model to submit one fixed object through the `workflow` tool. Built-in tools stay disabled, so the model sees the workflow tool without file or shell mutation tools.

The runner will check:

- Pi still reports the requested provider and model id, while its API matches that exact pair;
- one durable workflow step message exists in the origin session;
- the message has one request id and one current attempt id;
- one submission is accepted for that attempt;
- stale or duplicate session delivery does not appear;
- the workflow completes with the fixed output;
- the Pi turn settles and no extension error appears.

The result will not claim one upstream API request. Pi or the provider can retry a request. The test proves one accepted workflow submission and one origin-session delivery.

## Headless piw check

The current Rust `piw` command requires a terminal. Add one production command-line option:

```bash
piw RUN_ID --once
```

`--once` will connect through the normal Rust client and wait for one complete run view. It will render one frame with the existing `piw` renderer and a Ratatui test backend. It will then print the plain frame and exit. A missing run, connection failure, protocol error, or snapshot timeout will return a nonzero exit code.

The E2E runner will install the candidate Rust binary into the temporary root with `cargo install --path tui --root ... --locked`. It will call `piw RUN_ID --once` while the runtime workflow is active and after completion. The output must contain the exact run id, workflow name, step name, and current status.

This option also gives operators a normal noninteractive way to capture one viewer frame. It is not a test-only protocol.

## Runner interface

Add one command:

```bash
npm run test:e2e:live -- [options]
```

Supported forms:

```bash
npm run test:e2e:live -- --runtime-only

npm run test:e2e:live -- \
  --profile ~/.config/pi-workflows-e2e/openai-codex \
  --provider openai-codex \
  --model gpt-5.6-luna

npm run test:e2e:live -- \
  --provider openai \
  --model gpt-5.6-luna

npm run test:e2e:live -- \
  --profile /path/to/dedicated-profile \
  --provider anthropic \
  --model exact-model-id
```

A real-model run requires explicit provider and model arguments. `--runtime-only` makes no model call. The runner will not choose a default provider, infer a provider from a model name, or change the model after startup.

## Cleanup and failure evidence

The standalone runner will own one temporary root and remove it in a `finally` path. It will:

- close the Pi RPC process;
- stop the workflow server through the installed client;
- wait for the host endpoint to disappear;
- stop child workers started for the smoke workflows;
- remove the npm consumer installation, sessions, workflow state, and fixture project.

A normal failure will print a small diagnostic summary before cleanup. The summary will identify the failed phase and the software versions. It will also show the exact provider, model name, run id, host status, recent RPC event types, and bounded `piw` output. It will not print credentials, arbitrary environment values, or unrelated session content.

An explicit `--keep` option can preserve the one temporary root for manual debugging. Without that option, failures must not leave stale test directories.

## Automated tests

Add tests for:

- `piw --once` argument handling and one-frame rendering;
- timeout, missing-run, and host connection failures;
- packed npm installation with production dependencies;
- extension source isolation in base Pi;
- origin-session reconnection after initial host startup fails;
- one warning during the simulated outage;
- RPC widget and status transitions;
- pause with no active worker;
- abort of an active origin-session model turn;
- one new resumed step message and one fresh model turn after resume;
- protected decision revision stability across pause and resume;
- a complete session capture with no false host-interruption diagnostic;
- resume and completion;
- exact provider and model validation;
- model fallback rejection;
- cleanup after success and injected failure;
- bounded and secret-free diagnostics.

The existing mock-provider E2E suite remains the deterministic origin-session and model-tool gate. CI will run the new installed-package runner in `--runtime-only` mode. Real-provider runs stay manual because provider availability, subscription usage, API cost, and model behavior are external facts.

## Release use

Before a release:

1. Run all repository checks.
2. Run the installed-package test in `--runtime-only` mode.
3. Run one real-model check with an explicit provider and model.
4. Record the exact Pi version, package version, Rust version, provider, model id, API, and run result.
5. Do not release after fallback, ambiguous delivery, duplicate session delivery, extension error, cleanup failure, or disagreement between Pi, the host, and `piw`.

The GitHub publish jobs will continue to use deterministic checks. They must not receive a personal subscription credential or a broad API key.

## Files

Implementation will update:

- `scripts/live-e2e.mjs`;
- `test/fixtures/live-e2e/runtime.workflow.ts`;
- `test/fixtures/live-e2e/model.workflow.ts`;
- `package.json`;
- `tui/src/main.rs`;
- `tui/src/ui/mod.rs`;
- Rust and TypeScript E2E tests;
- `docs/workflows.md` and `docs/tui-viewer.md`.

## Contract impact

The runner creates only temporary Pi sessions and workflow state. A reusable subscription test profile is operator-owned and contains its own normal Pi authentication. The script does not change Pi session schemas, Pi internals, private APIs, or another repository.

The implementation uses documented Pi package installation and CLI model selection. It uses `auth check`, RPC state, RPC command discovery, and RPC extension UI events. Workflow state remains behind the existing Pi Workflows client protocol. The only new public interface is `piw RUN_ID --once`.

## Completion criteria

The work is complete when a clean base Pi process loads only the packed Pi Workflows package. The same Pi process must recover after the temporary incompatible-state gate is removed. The deterministic runtime workflow must pass every widget and lifecycle check, while `piw --once` must agree with Pi and the host. The full Pi mock-provider test must abort an active origin-session workflow turn, resume it through a distinct resumed step message, complete through one fresh model turn, and leave a complete session capture. The installed real-model check must reject a false host-interruption diagnostic. An explicitly selected built-in model must complete the structured agent workflow. Cleanup must leave no process or large temporary directory, and all repository checks must pass.
