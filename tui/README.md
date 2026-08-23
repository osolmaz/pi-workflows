# piw

piw is the terminal viewer for [pi-workflows](https://github.com/osolmaz/pi-workflows).
It browses saved workflow runs, follows active runs, and replays recorded workflow and Pi conversation events without rerunning models or tools.

## Install

Install the `pi-workflows` crate to get the `piw` command:

```bash
cargo install pi-workflows
```

## Use

Open the canonical workflow database:

```bash
piw
```

Open one run by ID:

```bash
piw 20260823T120000Z-example-a1b2c3d4
```

Serve local runs over the live replay protocol:

```bash
piw serve
```

Connect another viewer to that server:

```bash
piw --connect ws://127.0.0.1:9377/ws
```

See the [piw viewer guide](https://github.com/osolmaz/pi-workflows/blob/main/docs/tui-viewer.md) for controls, themes, replay behavior, and remote viewing.
