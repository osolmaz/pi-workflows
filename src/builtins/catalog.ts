import { BuiltinWorkflowCatalog } from "../workflows/catalog.js";
import monitorWorkflow from "./monitor.workflow.js";

export const builtinWorkflowCatalog = new BuiltinWorkflowCatalog([
  {
    id: "monitor",
    revision: "1",
    definition: monitorWorkflow,
    legacySources: [
      {
        workflowHash: "7a22158da94d18ec1c9fe42e70d72017a4e0620d5e5142ae839d0cd6eea55c06",
        revision: "1",
        pathSuffixes: [
          "/src/builtins/monitor.workflow.ts",
          "/dist/builtins/monitor.workflow.js",
          "/src/workflows/monitor.workflow.ts",
          "/dist/workflows/monitor.workflow.js",
        ],
      },
    ],
  },
]);
