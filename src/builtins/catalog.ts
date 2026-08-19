import { BuiltinWorkflowCatalog } from "../workflows/catalog.js";
import autodocWorkflow from "./autodoc.workflow.js";
import autoimplementWorkflow from "./autoimplement.workflow.js";
import autoplanWorkflow from "./autoplan.workflow.js";
import monitorWorkflow from "./monitor.workflow.js";
import planApprovalWorkflow from "./plan-approval.workflow.js";

export const builtinWorkflowCatalog = new BuiltinWorkflowCatalog([
  { id: "autoplan", revision: "1", definition: autoplanWorkflow },
  { id: "autodoc", revision: "1", definition: autodocWorkflow },
  { id: "autoimplement", revision: "3", definition: autoimplementWorkflow },
  { id: "plan-approval", revision: "1", definition: planApprovalWorkflow },
  {
    id: "monitor",
    revision: "6",
    definition: monitorWorkflow,
    legacySources: [
      {
        workflowHash: "7a22158da94d18ec1c9fe42e70d72017a4e0620d5e5142ae839d0cd6eea55c06",
        revision: "2",
        pathSuffixes: [
          "/src/builtins/monitor.workflow.ts",
          "/dist/builtins/monitor.workflow.js",
          "/src/workflows/monitor.workflow.ts",
          "/dist/workflows/monitor.workflow.js",
        ],
      },
      {
        workflowHash: "352fc09c88922c7375281b52f049c1039d05441ce37f2082f5ff07fea66d5318",
        revision: "2",
        pathSuffixes: ["/dist/builtins/monitor.workflow.js"],
      },
      {
        workflowHash: "dc601e2323a8213f5d52fa555e804ae8ed0846f809b3a1e9e5073a3c9c3a114e",
        revision: "2",
        pathSuffixes: ["/dist/builtins/monitor.workflow.js"],
      },
    ],
  },
]);
