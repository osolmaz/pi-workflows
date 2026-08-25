import {
  agent,
  allowSettingsPath,
  compute,
  defineWorkflow,
  settingsRoute,
  workflowSettings,
} from "@osolmaz/pi-workflows";

type Settings = {
  instructions: string[];
  route: "normal" | "careful";
  variables: Record<string, unknown>;
};

function parseSettings(value: unknown): Settings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings must be an object");
  }
  const settings = value as Partial<Settings>;
  if (
    !Array.isArray(settings.instructions) ||
    !settings.instructions.every((item) => typeof item === "string") ||
    (settings.route !== "normal" && settings.route !== "careful") ||
    settings.variables === null ||
    typeof settings.variables !== "object" ||
    Array.isArray(settings.variables)
  ) {
    throw new Error("settings are invalid");
  }
  return {
    instructions: [...settings.instructions],
    route: settings.route,
    variables: { ...settings.variables },
  };
}

export default defineWorkflow({
  name: "live-settings",
  settings: workflowSettings<Settings>({
    initial: { instructions: [], route: "normal", variables: {} },
    parse: parseSettings,
    description: "Instructions, variables, and the future route for this example.",
    paths: [
      allowSettingsPath("/instructions", {
        read: ["session", "human"],
        add: ["session", "human"],
        remove: ["session", "human"],
        replace: ["session", "human"],
      }),
      allowSettingsPath("/route", {
        read: ["session", "human"],
        replace: ["session", "human"],
      }),
      allowSettingsPath("/variables", {
        read: ["session", "human"],
        add: ["session", "human"],
        remove: ["session", "human"],
        replace: ["session", "human"],
      }),
    ],
  }),
  startAt: "prepare",
  nodes: {
    prepare: agent({
      prompt: ({ settings }) =>
        [
          "Prepare the requested work.",
          `Current instructions and variables: ${JSON.stringify(settings)}`,
          "The user can change future settings or queue several post-completion prompts while this step runs.",
        ].join("\n"),
      expectedOutput: `{ "prepared": "summary" }`,
    }),
    choose: settingsRoute({
      run: ({ settings }) => ({ route: (settings as Settings).route }),
    }),
    normal: compute({
      run: ({ settings }) => ({ mode: "normal", settings }),
    }),
    careful: compute({
      run: ({ settings }) => ({ mode: "careful", settings }),
    }),
  },
  edges: [
    { from: "prepare", to: "choose" },
    {
      from: "choose",
      switch: { on: "$.route", cases: { normal: "normal", careful: "careful" } },
    },
  ],
  presentationPrompt:
    "Explain which route and settings were used. Any queued follow-up prompts run only after this response settles.",
});
