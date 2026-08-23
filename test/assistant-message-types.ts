import { agent, assistantMessage } from "../src/workflows/definition.js";

agent({
  prompt: () => "Reply normally.",
  expectedOutput: assistantMessage(),
});

agent({
  prompt: () => "Submit JSON.",
  expectedOutput: `{ "ok": true }`,
  validate: (value) => value,
});

agent({
  prompt: () => "This definition must not type-check.",
  expectedOutput: assistantMessage(),
  // @ts-expect-error visible assistant output cannot use a submission validator
  validate: (value) => value,
});
