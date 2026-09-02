import { compute, defineWorkflow } from "@osolmaz/pi-workflows";

export default defineWorkflow({
  name: "live-runtime-e2e",
  startAt: "hold",
  nodes: {
    hold: compute({
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        return { smoke: "runtime-passed" };
      },
    }),
  },
  edges: [],
});
