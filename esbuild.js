const esbuild = require("esbuild");

// Add possibility to watch for changes and compile the library automatically when -w flag is used
const watch = process.argv.includes("-w");

// Default esbuild options for any build
const options = {
  color: true,
  logLevel: "error",
  bundle: true,
  sourcemap: true,
  tsconfig: "tsconfig.json",
  external: ["pg", "dotenv"], // pg is defined as external and not bundled (should be part of node_mosules as specified in package.json)
  platform: "node",
};
if (watch) {
  options.watch = {
    onRebuild(error, result) {
      if (error) console.error("watch build failed:", error);
      else console.log("watch build succeeded:", result);
    },
  };
}

esbuild
  .build({
    ...options,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  })
  .catch(() => process.exit(1));
