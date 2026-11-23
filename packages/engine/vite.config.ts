import { mergeConfig } from "vite";

import { libraryConfig } from "../../vite.lib.ts";

export default mergeConfig(libraryConfig, {
  build: {
    lib: {
      // Workers bundle the workflow code and the failure converter from their own files.
      entry: {
        "failure-converter": "src/failure-converter.ts",
        index: "src/index.ts",
        workflows: "src/workflows/index.ts",
      },
      fileName: (_format: string, name: string) => `${name}.js`,
    },
  },
});
